//! The composition root: builds every service, binds, serves, and shuts down.
//!
//! Start-up order matters and is spelled out in [`start`]:
//!
//! 1. `~/.tendril` and `settings.json` (an invalid file stops here);
//! 2. the logger, then the event subscribers ([`wire_subscribers`]);
//! 3. the password (`--password` > settings > random);
//! 4. the listener (port walk), then the certificate (HTTPS only);
//! 5. the shared state and the router;
//! 6. background tasks: the accept loop, the idle watchdog, the log flusher
//!    and the signal handler.
//!
//! [`run_until_stopped`] waits for the shutdown signal (idle timeout, the
//! Settings tab's button, Ctrl+C), kills terminals and flushes the logs.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::config::cli::{Cli, Scheme};
use crate::config::paths::DataDir;
use crate::config::settings::SettingsStore;
use crate::console;
use crate::core::{clock, netinfo, random};
use crate::http::state::{AppState, ServerInfo, Services};
use crate::http::{listen, routes, server, tls};
use crate::services::activity::Activity;
use crate::services::auth::{Auth, PasswordSource};
use crate::services::events::{Bus, Event, Subscriber};
use crate::services::logger::Logger;
use crate::services::shutdown::Shutdown;
use crate::services::terminals::Terminals;
use crate::services::workspaces::Workspaces;

/// The logger the panic hook writes to (set once the logger exists).
pub static PANIC_LOGGER: OnceLock<Arc<Logger>> = OnceLock::new();

/// How Tendril should start.
#[derive(Debug, Clone)]
pub struct Options {
    pub scheme: Scheme,
    pub password: Option<String>,
    pub port: Option<u16>,
    pub bind: Option<IpAddr>,
    pub data_dir: DataDir,
    /// Print the banner and console notices (off in tests).
    pub console: bool,
    /// Period of the idle watchdog.
    pub watchdog_every: Duration,
}

impl Options {
    /// Options for a normal run from the command line.
    pub fn from_cli(cli: &Cli) -> Options {
        Options {
            scheme: cli.scheme,
            password: cli.password.clone(),
            port: cli.port,
            bind: cli.bind,
            data_dir: DataDir::for_current_user(),
            console: true,
            watchdog_every: Duration::from_secs(60),
        }
    }
}

/// A running instance.
pub struct Started {
    pub state: AppState,
    pub addr: SocketAddr,
}

/// Event subscribers - the pub/sub seam's consumers, one line each. A new
/// reaction to events (metrics, notifications) is a new line here.
pub fn wire_subscribers(bus: &Bus, logger: &Arc<Logger>, console_output: bool) {
    bus.subscribe(audit_log(logger.clone()));
    if console_output {
        bus.subscribe(console::reporter());
    }
}

/// Writes every event to the JSON Lines log.
fn audit_log(logger: Arc<Logger>) -> Subscriber {
    Arc::new(move |event: &Event| logger.event(event))
}

/// Starts everything and returns once the server is listening.
pub async fn start(options: Options) -> Result<Started, String> {
    let data_dir = options.data_dir.clone();
    data_dir.ensure().map_err(|e| format!("could not create {}: {e}", data_dir.root().display()))?;

    let loaded = SettingsStore::load(&data_dir.settings_file())?;
    let settings = loaded.store.get();

    let logger = Arc::new(Logger::new(data_dir.logs_dir(), settings.log_retention_days, settings.log_max_total_mb));
    logger.prune();
    let _ = PANIC_LOGGER.set(logger.clone());
    let bus = Bus::new();
    wire_subscribers(&bus, &logger, options.console);
    for warning in &loaded.warnings {
        bus.publish(Event::SettingsWarning { message: warning.clone() });
    }

    let (password, source, generated) = match (&options.password, settings.password()) {
        (Some(p), _) => (p.clone(), PasswordSource::Cli, None),
        (None, Some(p)) => (p.to_string(), PasswordSource::Settings, None),
        (None, None) => {
            let p = random::password();
            (p.clone(), PasswordSource::Random, Some(p))
        }
    };

    let ip = match options.bind {
        Some(ip) => ip,
        None => settings.bind.parse().map_err(|_| format!("invalid bind address in settings: {}", settings.bind))?,
    };
    let requested_port = options.port.unwrap_or(settings.port);
    let std_listener = listen::bind(ip, requested_port).map_err(|e| format!("could not listen on {ip}: {e}"))?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let addr = std_listener.local_addr().map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| e.to_string())?;

    let (tls_config, fingerprint) = match options.scheme {
        Scheme::Https => {
            let names = tls::subject_names(netinfo::hostname().as_deref(), &netinfo::local_ips());
            let minted = tls::mint(&data_dir.cert_dir(), names)?;
            (Some(minted.config), Some(minted.fingerprint))
        }
        Scheme::Http => (None, None),
    };

    let info = ServerInfo {
        version: env!("CARGO_PKG_VERSION"),
        scheme: options.scheme,
        addr,
        data_dir: data_dir.root().to_path_buf(),
        fingerprint,
        started_ms: clock::unix_ms(),
        password_from_cli: options.password.is_some(),
    };
    let state = AppState(Arc::new(Services {
        activity: Activity::new(settings.idle_timeout_minutes),
        auth: Auth::new(&password, source),
        workspaces: Workspaces::new(&data_dir.recent_file()),
        terminals: Terminals::new(),
        shutdown: Shutdown::new(),
        settings: loaded.store,
        blocked_hits: Mutex::default(),
        logger,
        bus,
        info,
    }));

    let router = routes::build(state.clone());
    tokio::spawn(server::serve(listener, router, tls_config, state.shutdown.subscribe()));
    spawn_watchdog(state.clone(), options.watchdog_every);
    spawn_log_flusher(state.clone());
    spawn_signal_handler(state.clone());

    state.publish(Event::Started {
        version: state.info.version.into(),
        scheme: options.scheme.as_str().into(),
        addr: addr.to_string(),
        data_dir: data_dir.root().display().to_string(),
        password_source: source.as_str().into(),
    });
    if options.console {
        console::banner(&state, requested_port, generated.as_deref());
    }
    Ok(Started { state, addr })
}

/// Waits for the shutdown signal, then cleans up. Returns the reason.
pub async fn run_until_stopped(started: Started) -> String {
    let state = started.state;
    let reason = state.shutdown.wait().await;
    state.publish(Event::Stopping { reason: reason.clone() });
    state.terminals.kill_all();
    tokio::time::sleep(Duration::from_millis(150)).await;
    state.logger.flush();
    reason
}

/// Runs Tendril on a single-threaded runtime until it stops.
pub fn run(options: Options) -> Result<String, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(16)
        .thread_keep_alive(Duration::from_secs(10))
        .thread_stack_size(512 * 1024)
        .build()
        .map_err(|e| format!("could not start the runtime: {e}"))?;
    let result = runtime.block_on(async {
        let started = start(options).await?;
        Ok(run_until_stopped(started).await)
    });
    // PTY reader threads may be blocked in read(); do not wait for them.
    runtime.shutdown_timeout(Duration::from_millis(500));
    result
}

/// Closes the process after `idle_timeout_minutes` without user activity.
///
/// It sleeps until the moment the timeout would expire, so the process stops
/// on time (the browser counts down to that same moment and then checks that
/// the server is gone). Activity meanwhile only moves the deadline: on waking
/// early it sleeps again. A changed timeout wakes it at once. `every` caps
/// each sleep because the deadline is wall-clock time while sleeps are
/// monotonic: after a laptop's suspend it re-checks within that interval.
fn spawn_watchdog(state: AppState, every: Duration) {
    tokio::spawn(async move {
        loop {
            if state.activity.expired() {
                let minutes = state.activity.timeout().as_secs() / 60;
                state.shutdown.trigger(format!("idle timeout: no activity for {minutes} minute(s)"));
                break;
            }
            let wait = state.activity.remaining().min(every).max(Duration::from_millis(10));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = state.activity.timeout_changed() => {}
            }
        }
    });
}

/// Flushes buffered log lines every two seconds.
fn spawn_log_flusher(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            state.logger.flush();
        }
    });
}

/// Ctrl+C (and SIGTERM on Unix, closing the console on Windows) stop the
/// process cleanly.
fn spawn_signal_handler(state: AppState) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut term = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => return,
            };
            let mut hangup = match signal(SignalKind::hangup()) {
                Ok(s) => s,
                Err(_) => return,
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => state.shutdown.trigger("interrupted (Ctrl+C)"),
                _ = term.recv() => state.shutdown.trigger("terminated (SIGTERM)"),
                _ = hangup.recv() => state.shutdown.trigger("hang-up (SIGHUP)"),
            }
        }
        #[cfg(windows)]
        {
            let close = tokio::signal::windows::ctrl_close();
            match close {
                Ok(mut close) => {
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => state.shutdown.trigger("interrupted (Ctrl+C)"),
                        _ = close.recv() => state.shutdown.trigger("console window closed"),
                    }
                }
                Err(_) => {
                    if tokio::signal::ctrl_c().await.is_ok() {
                        state.shutdown.trigger("interrupted (Ctrl+C)");
                    }
                }
            }
        }
    });
}
