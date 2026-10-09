//! Running commands and scripts on the host.
//!
//! Short commands run with a hidden window (`CREATE_NO_WINDOW`), their stdout
//! and stderr captured up to a byte limit and bounded by a timeout, with the
//! result returned to the GUI. Long-running scripts (a resident AutoHotkey
//! script, say) are launched detached with no timeout and no capture.
//!
//! This is remote code execution by design; the responsibility sits with the
//! user. Every command run is written to the audit log by the caller.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, PartialEq)]
pub struct ExecResult {
    pub launched: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub error: Option<String>,
}

impl ExecResult {
    fn failure(msg: String) -> ExecResult {
        ExecResult {
            launched: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            truncated: false,
            error: Some(msg),
        }
    }
}

/// Run a program with captured output, a hidden window, a timeout and an output
/// byte cap. On timeout the child is killed and `timed_out` is set.
pub fn run_capture(
    program: &str,
    args: &[String],
    timeout: Duration,
    output_limit: usize,
) -> ExecResult {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return ExecResult::failure(format!("failed to start `{program}`: {e}")),
    };

    // Drain stdout and stderr on their own threads so a full pipe never blocks
    // the child, capping each at the output limit.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_rx = spawn_reader(stdout, output_limit);
    let err_rx = spawn_reader(stderr, output_limit);

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let exit_code;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    exit_code = None;
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return ExecResult::failure(format!("wait failed: {e}")),
        }
    }

    let (stdout, out_trunc) = out_rx.recv().unwrap_or((String::new(), false));
    let (stderr, err_trunc) = err_rx.recv().unwrap_or((String::new(), false));

    ExecResult {
        launched: true,
        exit_code,
        stdout,
        stderr,
        timed_out,
        truncated: out_trunc || err_trunc,
        error: None,
    }
}

/// Read a pipe to end (or until the cap) on a thread, returning `(text, truncated)`.
fn spawn_reader(
    pipe: Option<impl Read + Send + 'static>,
    limit: usize,
) -> mpsc::Receiver<(String, bool)> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut truncated = false;
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 4096];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < limit {
                            let room = limit - buf.len();
                            let take = n.min(room);
                            buf.extend_from_slice(&chunk[..take]);
                            if take < n {
                                truncated = true;
                            }
                        } else {
                            truncated = true;
                        }
                    }
                }
            }
        }
        let _ = tx.send((String::from_utf8_lossy(&buf).into_owned(), truncated));
    });
    rx
}

/// Run a CMD one-liner (`cmd /C <line>`), captured.
pub fn run_cmd_line(line: &str, timeout: Duration, output_limit: usize) -> ExecResult {
    run_capture("cmd", &["/C".to_string(), line.to_string()], timeout, output_limit)
}

/// Launch a program detached: no window, no wait, no capture. Used for
/// long-running or resident scripts. Returns the child PID on success.
pub fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<u32> {
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_stdout() {
        let r = run_cmd_line("echo hello", Duration::from_secs(5), 4096);
        assert!(r.launched);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.stdout.contains("hello"));
        assert!(!r.timed_out);
    }

    #[test]
    fn nonzero_exit_code() {
        let r = run_cmd_line("exit 3", Duration::from_secs(5), 4096);
        assert_eq!(r.exit_code, Some(3));
    }

    #[test]
    fn times_out_long_command() {
        // `timeout` waits; ping -n is a portable stall on Windows.
        let r = run_cmd_line("ping -n 10 127.0.0.1", Duration::from_millis(300), 4096);
        assert!(r.timed_out);
    }

    #[test]
    fn output_is_capped() {
        // Echo a line but cap the capture very low to force truncation.
        let r = run_cmd_line("echo abcdefghijklmnop", Duration::from_secs(5), 4);
        assert!(r.truncated);
        assert!(r.stdout.len() <= 4);
    }

    #[test]
    fn missing_program_reports_error() {
        let r = run_capture(
            "definitely-not-a-real-program-xyz",
            &[],
            Duration::from_secs(2),
            4096,
        );
        assert!(!r.launched);
        assert!(r.error.is_some());
    }
}
