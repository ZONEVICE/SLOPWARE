//! What Tendril prints on the console: the start-up banner (addresses, the
//! certificate fingerprint and, when it was generated, the password - shown
//! this one time only and never logged) and a subscriber that reports the
//! events an operator should notice.

use std::collections::VecDeque;
use std::io::Write;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::config::cli::Scheme;
use crate::core::lock::LockExt;
use crate::core::{clock, netinfo};
use crate::http::state::AppState;
use crate::services::events::{Event, Subscriber};

/// Prints the start-up banner to stdout.
pub fn banner(state: &AppState, requested_port: u16, generated_password: Option<&str>) {
    let info = &state.info;
    let settings = state.settings.get();
    let port = info.addr.port();
    let scheme = info.scheme.as_str();
    let mut out = String::new();
    out.push_str(&format!("\nTendril {} - lightweight web code editor\n\n", info.version));
    match info.scheme {
        Scheme::Https => {
            out.push_str("  Mode       HTTPS, self-signed certificate (new on every start: the browser will warn)\n");
            if let Some(fp) = &info.fingerprint {
                out.push_str(&format!("  SHA-256    {fp}\n"));
            }
        }
        Scheme::Http => {
            out.push_str("  Mode       HTTP - NOT ENCRYPTED: the password and your files travel in clear text.\n");
            out.push_str("             Use it only on a trusted network, or start without `http` for HTTPS.\n");
        }
    }
    let moved = if requested_port != 0 && requested_port != port {
        format!("   (port {requested_port} was busy)")
    } else {
        String::new()
    };
    out.push_str(&format!("  Listening  {}{moved}\n", info.addr));
    let urls = urls(info.addr.ip(), scheme, port);
    for (i, url) in urls.iter().enumerate() {
        out.push_str(&format!("  {}  {url}\n", if i == 0 { "Open     " } else { "         " }));
    }
    match generated_password {
        Some(pw) => {
            out.push_str(&format!("  Password   {pw}\n"));
            out.push_str("             generated for this run and shown only once; set your own with\n");
            out.push_str("             --password <text> or \"password\" in settings.json\n");
        }
        None if info.password_from_cli => out.push_str("  Password   set with --password\n"),
        None => out.push_str("  Password   from settings.json\n"),
    }
    out.push_str(&format!(
        "  Idle       closes itself after {} minute(s) without activity\n",
        settings.idle_timeout_minutes
    ));
    out.push_str(&format!("  Data       {}\n", info.data_dir.display()));
    out.push_str("\nPress Ctrl+C to stop.\n");
    print!("{out}");
}

/// URLs to open: loopback plus every local address when bound to all
/// interfaces, otherwise the bound address.
fn urls(bound: IpAddr, scheme: &str, port: u16) -> Vec<String> {
    let host = |ip: IpAddr| match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        v4 => v4.to_string(),
    };
    if !bound.is_unspecified() {
        return vec![format!("{scheme}://{}:{port}", host(bound))];
    }
    let mut out = vec![format!("{scheme}://localhost:{port}")];
    for ip in netinfo::local_ips() {
        if bound.is_ipv4() && ip.is_ipv6() {
            continue;
        }
        out.push(format!("{scheme}://{}:{port}", host(ip)));
    }
    out
}

/// Most operator lines kept while the console accepts no output; later ones
/// are dropped (operator notices are best-effort).
const CONSOLE_QUEUE: usize = 256;

/// Writes operator lines to the console without ever blocking the caller.
///
/// A paused console blocks whoever writes to it: on Windows a QuickEdit mouse
/// selection pauses console output, and on Unix Ctrl+S (XOFF) does the same.
/// Events are reported from request handlers on the single runtime thread, so
/// a blocking write there would stall every connection. Lines are queued
/// instead (at most `CONSOLE_QUEUE`) and written in order by a short-lived
/// thread that exists only while there is something to write: at rest Tendril
/// keeps its single thread.
struct Printer {
    state: Mutex<PrinterState>,
    write: Box<dyn Fn(&str) + Send + Sync>,
}

#[derive(Default)]
struct PrinterState {
    lines: VecDeque<String>,
    /// A thread is writing `lines`.
    writing: bool,
}

impl Printer {
    fn new(write: impl Fn(&str) + Send + Sync + 'static) -> Arc<Printer> {
        Arc::new(Printer { state: Mutex::default(), write: Box::new(write) })
    }

    /// Queues `line` and starts the writer thread when none is running.
    fn print(self: &Arc<Self>, line: String) {
        {
            let mut state = self.state.locked();
            if state.lines.len() >= CONSOLE_QUEUE {
                return;
            }
            state.lines.push_back(line);
            if state.writing {
                return;
            }
            state.writing = true;
        }
        let printer = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("tendril-console".into())
            .stack_size(64 * 1024)
            .spawn(move || printer.drain());
        if spawned.is_err() {
            // No thread to write with: drop the lines rather than block.
            let mut state = self.state.locked();
            state.lines.clear();
            state.writing = false;
        }
    }

    /// Waits up to `limit` until every queued line was written.
    fn drained(&self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            {
                let state = self.state.locked();
                if state.lines.is_empty() && !state.writing {
                    return true;
                }
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Writes the queued lines in order, then lets the thread end. The queue
    /// is found empty under the same lock `print` takes, so a line queued
    /// meanwhile either is written by this thread or starts a new one.
    fn drain(&self) {
        loop {
            let line = {
                let mut state = self.state.locked();
                match state.lines.pop_front() {
                    Some(line) => line,
                    None => {
                        state.writing = false;
                        return;
                    }
                }
            };
            (self.write)(&line);
        }
    }
}

/// The process's printer for stderr (see [`Printer`]).
fn stderr_printer() -> &'static Arc<Printer> {
    static PRINTER: OnceLock<Arc<Printer>> = OnceLock::new();
    PRINTER.get_or_init(|| {
        Printer::new(|line| {
            // Ignore write errors: `eprintln!` would panic on a closed or
            // broken stderr, and release builds abort on panic.
            let _ = writeln!(std::io::stderr().lock(), "{line}");
        })
    })
}

/// Prints a line on stderr without ever blocking the caller.
pub fn say(line: impl Into<String>) {
    stderr_printer().print(line.into());
}

/// Waits up to `limit` for the queued lines to reach the console; false if
/// it is still paused. Used before exiting, so the last line usually shows
/// but a paused console never keeps the process alive.
pub fn drain(limit: Duration) -> bool {
    stderr_printer().drained(limit)
}

/// Reports the events an operator should notice on stderr, with a UTC time.
/// The lines go through a [`Printer`], so a paused console never blocks a
/// request; the start-up banner stays synchronous, since it is printed before
/// any connection is served.
pub fn reporter() -> Subscriber {
    let printer = Arc::clone(stderr_printer());
    Arc::new(move |event: &Event| {
        let line = match event {
            Event::LoginOk { ip } => format!("login from {ip}"),
            Event::LoginFailed { ip, failures } => format!("wrong password from {ip} ({failures} of 3)"),
            Event::IpBlocked { ip } => format!("BLOCKED {ip} after 3 wrong passwords (restart Tendril to unblock)"),
            Event::WorkspaceOpened { ip, path } => format!("{ip} opened {path}"),
            Event::TerminalOpened { ip, shell, .. } => format!("{ip} opened a terminal ({shell})"),
            Event::PasswordChanged { ip } => format!("{ip} changed the password"),
            Event::SettingsWarning { message } => format!("warning: {message}"),
            Event::Stopping { reason } => format!("stopping: {reason}"),
            Event::Error { context, message } => format!("error in {context}: {message}"),
            _ => return,
        };
        let now = clock::rfc3339_ms(clock::unix_ms());
        printer.print(format!("[{}] {line}", &now[11..19]));
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Waits up to five seconds for `condition`.
    fn eventually(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        condition()
    }

    #[test]
    fn a_paused_console_never_blocks_the_caller() {
        // This console accepts nothing until `resume` is dropped, like one
        // with a QuickEdit selection (Windows) or after Ctrl+S (Unix).
        let (resume, paused) = mpsc::channel::<()>();
        let paused = Mutex::new(paused);
        let (entered, blocked) = mpsc::channel::<()>();
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = written.clone();
        let printer = Printer::new(move |line| {
            let _ = entered.send(());
            let _ = paused.locked().recv();
            sink.locked().push(line.to_string());
        });
        // Wait until the writer took the first line and blocked on the
        // console. Otherwise the result depends on when its thread starts: it
        // could free that line's queue slot only after the queue had filled,
        // and a later line would take it (seen on Windows).
        printer.print("line 0".into());
        blocked.recv_timeout(Duration::from_secs(5)).expect("the writer thread should start");
        let started = Instant::now();
        for i in 1..1000 {
            printer.print(format!("line {i}"));
        }
        assert!(started.elapsed() < Duration::from_secs(1), "reporting blocked on the paused console");

        drop(resume);
        assert!(eventually(|| !printer.state.locked().writing), "the writer thread should end once drained");
        // The line being written plus a full queue of the next ones, in
        // order; everything after them was dropped.
        let expected: Vec<String> = (0..=CONSOLE_QUEUE).map(|i| format!("line {i}")).collect();
        assert_eq!(*written.locked(), expected);
    }

    #[test]
    fn draining_gives_up_on_a_paused_console() {
        // Exiting must not wait forever for a console that accepts nothing:
        // that kept a stopped Tendril alive until someone pressed Ctrl+Q.
        let (resume, paused) = mpsc::channel::<()>();
        let paused = Mutex::new(paused);
        let printer = Printer::new(move |_line| {
            let _ = paused.locked().recv();
        });
        printer.print("Tendril stopped".into());
        let started = Instant::now();
        assert!(!printer.drained(Duration::from_millis(100)));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(resume);
        assert!(printer.drained(Duration::from_secs(5)));
    }

    #[test]
    fn the_writer_thread_ends_when_idle_and_comes_back() {
        let written = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = written.clone();
        let printer = Printer::new(move |line| sink.locked().push(line.to_string()));
        printer.print("one".into());
        assert!(eventually(|| written.locked().len() == 1 && !printer.state.locked().writing));
        printer.print("two".into());
        printer.print("three".into());
        assert!(eventually(|| written.locked().len() == 3 && !printer.state.locked().writing));
        assert_eq!(*written.locked(), vec!["one", "two", "three"]);
    }

    #[test]
    fn urls_for_specific_and_wildcard_binds() {
        assert_eq!(urls("127.0.0.1".parse().unwrap(), "https", 6060), vec!["https://127.0.0.1:6060"]);
        assert_eq!(urls("::1".parse().unwrap(), "http", 7000), vec!["http://[::1]:7000"]);
        let all = urls("0.0.0.0".parse().unwrap(), "https", 6060);
        assert_eq!(all[0], "https://localhost:6060");
        assert!(all.iter().all(|u| !u.contains('[')));
    }
}
