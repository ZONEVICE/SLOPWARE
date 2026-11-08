//! Entry point: parse the command line, install the panic hook, run.

use std::process::ExitCode;
use std::time::Duration;

use tendril::config::cli::{self, Action};
use tendril::{app, console};

fn main() -> ExitCode {
    let cli = match cli::parse(std::env::args().skip(1)) {
        Ok(cli) => cli,
        Err(message) => {
            eprintln!("tendril: {message}\n\n{}", cli::usage());
            return ExitCode::from(2);
        }
    };
    match cli.action {
        Action::Help => {
            println!("{}", cli::usage());
            return ExitCode::SUCCESS;
        }
        Action::Version => {
            println!("tendril {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Action::Run => {}
    }

    install_panic_hook();
    match app::run(app::Options::from_cli(&cli)) {
        Ok(reason) => {
            // Through the console printer: a console paused with Ctrl+S or a
            // QuickEdit selection must not keep a stopped Tendril alive.
            console::say(format!("Tendril stopped: {reason}"));
            console::drain(Duration::from_secs(1));
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("tendril: {message}");
            pause_if_own_console();
            ExitCode::FAILURE
        }
    }
}

/// When Tendril owns its console window - started by a double-click from
/// Explorer, where it is the only process attached to the console - a fatal
/// error printed just before exit would vanish when the window closes. Wait for
/// Enter so it can be read. Never reached on a normal stop (idle timeout, the
/// Stop button, Ctrl+C or a closed window), only after an error.
#[cfg(windows)]
fn pause_if_own_console() {
    use std::io::Write;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleProcessList(lpdwProcessList: *mut u32, dwProcessCount: u32) -> u32;
    }
    let mut buf = [0u32; 2];
    // SAFETY: GetConsoleProcessList writes at most `buf.len()` process ids into
    // `buf` and returns how many processes are attached to the console; the
    // pointer and length are valid and the buffer contents are not read back.
    let count = unsafe { GetConsoleProcessList(buf.as_mut_ptr(), buf.len() as u32) };
    if count == 1 {
        eprint!("\nPress Enter to close . . . ");
        let _ = std::io::stderr().flush();
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
    }
}

/// Other platforms do not open their own console window.
#[cfg(not(windows))]
fn pause_if_own_console() {}

/// Release builds use `panic = "abort"`: no destructor runs after a panic,
/// so the panic is written to the log synchronously here, before the abort.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let message = format!("thread '{}' {info}", thread.name().unwrap_or("unnamed"));
        if let Some(logger) = app::PANIC_LOGGER.get() {
            logger.record_panic(&message);
        }
        eprintln!("tendril: fatal error: {message}");
    }));
}
