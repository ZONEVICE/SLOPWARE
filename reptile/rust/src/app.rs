//! Composition root: builds one fully wired Reptile instance.
//!
//! WIRING ORDER (dependencies flow downwards, never back up):
//!
//!   config
//!     -> event bus, identity
//!       -> domain services: hosting, syncing, discovery, mode controller
//!            (the transports they need - the peer HTTP client and the
//!             network probe - are injected here, so the domain never
//!             imports them)
//!         -> HTTP: router + route plugins, control panel files, SSE hub
//!         -> reporters: event-bus subscribers (console messages)
//!
//! `App::new` never listens. `App::listen` does, walking past busy ports,
//! which is also what lets the tests start instances on ephemeral ports.

use crate::config::Config;
use crate::domain::discovery::Discovery;
use crate::domain::hosting::HostingService;
use crate::domain::identity::Identity;
use crate::domain::modes::ModeController;
use crate::domain::protocol::PROTOCOL_VERSION;
use crate::domain::syncing::SyncingService;
use crate::domain::transport::{PeerApi, PeerFactory, Probe};
use crate::http::assets::Statics;
use crate::http::guard::Guard;
use crate::http::router::Router;
use crate::http::routes::{register_all, Deps};
use crate::http::server::Server;
use crate::http::sse::SseHub;
use crate::http::tls::server_config;
use crate::http::HttpApp;
use crate::peer::client::PeerClient;
use crate::peer::probe::probe;
use crate::reporters::attach_all;
use crate::util::cert::{generate, Certificate};
use crate::util::events::{Event, EventBus, Subscription};
use crate::util::listen::listen_with_fallback;
use crate::util::logger::Logger;
use crate::util::net::{lan_addresses, parse_ipv4};
use crate::util::threads::Locked;
use crate::util::time::now_ms;
use serde_json::{json, Value};
use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct App {
    pub config: Arc<Config>,
    pub logger: Logger,
    pub bus: Arc<EventBus>,
    pub identity: Arc<Identity>,
    pub hosting: Arc<HostingService>,
    pub syncing: Arc<SyncingService>,
    pub discovery: Arc<Discovery>,
    pub modes: Arc<ModeController>,
    pub sse: Arc<SseHub>,
    pub tls: Option<Certificate>,
    http: Arc<HttpApp>,
    server: Mutex<Option<Arc<Server>>>,
    subscriptions: Mutex<Vec<Subscription>>,
    closed: AtomicBool,
}

/// Everything the control panel displays, in one object.
fn snapshot(
    identity: &Identity,
    config: &Config,
    discovery: &Discovery,
    modes: &ModeController,
    hosting: &HostingService,
    syncing: &SyncingService,
) -> Value {
    json!({
        "identity": identity.to_json(),
        "ui": { "remote": config.allow_remote_ui },
        "discovery": discovery.status(),
        "mode": modes.mode(),
        "hosting": hosting.status(),
        "syncing": syncing.status(),
        "serverTime": now_ms(),
    })
}

impl App {
    pub fn new(config: Config, logger: Logger) -> io::Result<Arc<App>> {
        let config = Arc::new(config);
        let error_logger = logger.clone();
        let bus = EventBus::new(move |message| error_logger.error(message));
        let identity = Arc::new(Identity::new(config.protocol, config.interfaces.clone()));

        // --- Domain ---------------------------------------------------------------
        let hosting =
            HostingService::new(bus.clone(), identity.clone(), config.watcher, config.timing, logger.child("host"));
        let factory_identity = identity.clone();
        let timing = config.timing;
        let peer_factory: PeerFactory = Arc::new(move |address, port, protocol| {
            Arc::new(PeerClient::new(address, port, protocol, factory_identity.clone(), timing)) as Arc<dyn PeerApi>
        });
        let prober: Probe = Arc::new(probe);
        let syncing = SyncingService::new(
            bus.clone(),
            identity.clone(),
            config.timing,
            config.watcher,
            peer_factory,
            prober.clone(),
            logger.child("sync"),
        );
        let discovery =
            Discovery::new(config.discovery.clone(), identity.clone(), bus.clone(), prober, logger.child("discovery"));
        let modes = ModeController::new(bus.clone(), hosting.clone(), syncing.clone());

        // --- HTTP -----------------------------------------------------------------
        let snapshot_fn: Arc<dyn Fn() -> Value + Send + Sync> = {
            let (identity, config, discovery, modes, hosting, syncing) =
                (identity.clone(), config.clone(), discovery.clone(), modes.clone(), hosting.clone(), syncing.clone());
            Arc::new(move || snapshot(&identity, &config, &discovery, &modes, &hosting, &syncing))
        };
        let ping_fn: Arc<dyn Fn() -> Value + Send + Sync> = {
            let (identity, modes, hosting) = (identity.clone(), modes.clone(), hosting.clone());
            Arc::new(move || {
                json!({
                    "app": "reptile",
                    "version": identity.version,
                    "protocolVersion": PROTOCOL_VERSION,
                    "uuid": identity.uuid,
                    "hostname": identity.hostname,
                    "protocol": identity.protocol,
                    "port": identity.port(),
                    "mode": modes.mode(),
                    "hosting": hosting.ping_info(),
                })
            })
        };
        let sse = {
            let snapshot_fn = snapshot_fn.clone();
            SseHub::new(Box::new(move || snapshot_fn()))
        };
        let deps = Arc::new(Deps {
            identity: identity.clone(),
            hosting: hosting.clone(),
            syncing: syncing.clone(),
            discovery: discovery.clone(),
            modes: modes.clone(),
            sse: sse.clone(),
            logger: logger.child("http"),
            snapshot: snapshot_fn,
            ping: ping_fn,
        });
        let mut router = Router::new();
        register_all(&mut router, &deps);
        let http = Arc::new(HttpApp {
            router,
            guard: Guard::new(config.allow_remote_ui, &identity.hostname, config.interfaces.clone()),
            statics: Statics::new(config.public_dir.clone()),
            logger: logger.child("http"),
        });

        let mut subscriptions = attach_all(&bus, &logger);
        let hub = Arc::downgrade(&sse);
        subscriptions.push(bus.subscribe(move |event| {
            if let Event::StateChanged { .. } = event {
                if let Some(hub) = hub.upgrade() {
                    hub.schedule();
                }
            }
        }));

        // --- TLS ------------------------------------------------------------------
        let tls = if config.protocol == "https" {
            // A BRAND NEW certificate on every start, replacing the previous one.
            let host = &identity.hostname;
            let mut ips: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()];
            ips.extend(lan_addresses(&identity.interfaces()).iter().filter_map(|a| parse_ipv4(a).map(IpAddr::V4)));
            let certificate = generate(
                &config.cert_dir,
                &format!("{host}.local"),
                &["localhost".into(), host.clone(), format!("{host}.local")],
                &ips,
            )
            .map_err(|error| {
                io::Error::other(format!("could not generate a certificate in {}: {error}", config.cert_dir.display()))
            })?;
            *identity.certificate_fingerprint.locked() = Some(certificate.fingerprint256.clone());
            logger.info(format_args!(
                "generated a new self-signed certificate ({}) at {}",
                certificate.key_type,
                certificate.cert_path.display()
            ));
            Some(certificate)
        } else {
            None
        };

        Ok(Arc::new(App {
            config,
            logger,
            bus,
            identity,
            hosting,
            syncing,
            discovery,
            modes,
            sse,
            tls,
            http,
            server: Mutex::new(None),
            subscriptions: Mutex::new(subscriptions),
            closed: AtomicBool::new(false),
        }))
    }

    /// Listen, walking past busy ports, then start discovery. Returns the
    /// port actually bound.
    pub fn listen(&self) -> io::Result<u16> {
        let bound = listen_with_fallback(&self.config.host, self.config.port, self.config.port_attempts, &self.logger)?;
        let tls = match &self.tls {
            Some(certificate) => Some(server_config(&certificate.cert_der, &certificate.key_der)?),
            None => None,
        };
        let http = self.http.clone();
        let server =
            Server::new(bound.listener, tls, Arc::new(move |request| http.handle(request)), self.logger.child("http"))?;
        server.serve();
        self.identity.set_port(bound.port);
        *self.server.locked() = Some(server);
        self.discovery.start();
        Ok(bound.port)
    }

    /// A browsable URL; a wildcard bind becomes localhost.
    pub fn url_for(&self, port: u16) -> String {
        let host = &self.config.host;
        let shown = if host == "0.0.0.0" || host == "::" { "localhost" } else { host.as_str() };
        if shown.contains(':') {
            format!("{}://[{shown}]:{port}", self.config.protocol)
        } else {
            format!("{}://{shown}:{port}", self.config.protocol)
        }
    }

    /// Stop everything. Safe to call twice.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.discovery.stop();
        self.modes.shutdown();
        self.sse.close();
        for subscription in self.subscriptions.locked().drain(..) {
            subscription.off();
        }
        if let Some(server) = self.server.locked().take() {
            server.close();
        }
        self.bus.clear();
    }

    /// Close the listening socket and every connection WITHOUT telling peers
    /// (a crash, for tests).
    pub fn kill_connections(&self) {
        if let Some(server) = self.server.locked().take() {
            server.close();
        }
    }

    /// Drop every open connection but keep listening (a network blip, for tests).
    pub fn drop_connections(&self) {
        if let Some(server) = self.server.locked().as_ref() {
            server.drop_connections();
        }
    }
}
