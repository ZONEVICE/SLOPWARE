//! Reptile entry point.
//!
//!   reptile                -> HTTP, starting at port 55667
//!   reptile --https        -> a new self-signed certificate, then HTTPS
//!   reptile --port N       -> start at port N instead
//!
//! Nothing about hosting, syncing or discovery survives this process: it all
//! lives in memory. The synchronised files, of course, stay on disk.

use reptile::app::App;
use reptile::config::{usage, Config};
use reptile::util::logger::Logger;
use reptile::util::sys::on_termination;
use std::sync::mpsc::channel;
use std::time::Duration;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let config = Config::from_args(&argv);
    if config.help {
        println!("{}", usage());
        return;
    }
    if config.version {
        println!("{}", env!("REPTILE_VERSION"));
        return;
    }

    // Before any other thread exists (Unix signal masks are inherited).
    let (stop_sender, stop_receiver) = channel::<&'static str>();
    let (done_sender, done_receiver) = channel::<()>();
    on_termination(move |signal| {
        let _ = stop_sender.send(signal);
        // Windows ends the process when this returns for a closed console:
        // give the shutdown a few seconds to finish first.
        let _ = done_receiver.recv_timeout(Duration::from_secs(5));
    });

    let logger = Logger::new("reptile", config.log_level);
    for flag in &config.unknown_args {
        logger.warn(format_args!("ignoring unknown option {flag}"));
    }
    let protocol = config.protocol;
    let allow_remote = config.allow_remote_ui;
    let app = match App::new(config, logger.clone()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("reptile failed to start: {error}");
            std::process::exit(1);
        }
    };
    let port = match app.listen() {
        Ok(port) => port,
        Err(error) => {
            eprintln!("reptile failed to start: {error}");
            std::process::exit(1);
        }
    };

    let identity = &app.identity;
    let scan = app.discovery.status();
    logger.info(format_args!("Reptile {} (Rust) is running over {}", identity.version, protocol.to_uppercase()));
    logger.info(format_args!(
        "  control panel  {}{}",
        app.url_for(port),
        if allow_remote { " (open to the network)" } else { " (this computer only)" }
    ));
    logger.info(format_args!("  peers connect  {}:{port}", identity.address()));
    logger.info(format_args!("  host           {}", identity.hostname));
    logger.info(format_args!("  session UUID   {}", identity.uuid));
    if scan["enabled"] == true {
        logger.info(format_args!(
            "  discovery      scanning ports {} on the local network",
            scan["ports"]["ranges"].as_str().unwrap_or("")
        ));
    } else {
        logger.info("  discovery      off (turn it on from the status bar)");
    }
    if protocol == "https" {
        logger.info("  the certificate is self-signed and brand new: expect a browser warning");
    }

    let signal = stop_receiver.recv().unwrap_or("SIGTERM");
    logger.info(format_args!("{signal} received, shutting down"));
    // Never hang on the way out.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(5));
        std::process::exit(0);
    });
    app.close();
    let _ = done_sender.send(());
    std::process::exit(0);
}
