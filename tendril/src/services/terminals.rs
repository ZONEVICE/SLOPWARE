//! Integrated terminals: one shell per pseudo-terminal (`openpty` on Unix,
//! ConPTY on Windows 10 1809+) through `portable-pty`.
//!
//! Each terminal uses three small threads, because every PTY call blocks:
//!
//! - **reader**: PTY output -> a bounded channel the WebSocket task drains.
//!   The bound is the flow control: a slow browser makes the reader wait.
//! - **control**: browser input and resize requests -> the PTY. When its
//!   channel closes (the WebSocket went away) or the child exits, it kills the
//!   child and drops the PTY master. Dropping the master is what makes the
//!   reader see end-of-file (on Windows only `ClosePseudoConsole` does, and it
//!   must happen while the reader is still draining output, or it can hang).
//! - **waiter**: waits for the shell to exit, records the exit code and tells
//!   the control thread.
//!
//! Closing the WebSocket therefore always kills the shell: no orphaned
//! processes keep memory after a tab is closed. The number of live terminals
//! is capped by `max_terminals`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};

use portable_pty::{ChildKiller, CommandBuilder, PtySize, native_pty_system};
use tokio::sync::mpsc;

use crate::core::lock::LockExt;

/// Stack size for the per-terminal threads (they only shuffle buffers).
const THREAD_STACK: usize = 128 * 1024;
/// Output chunks buffered between the reader thread and the WebSocket.
const OUTPUT_QUEUE: usize = 32;

/// Why a terminal could not be opened.
#[derive(Debug)]
pub enum TerminalError {
    /// `max_terminals` are already running.
    Limit(usize),
    /// The PTY or the shell could not be started.
    Spawn(String),
}

impl std::fmt::Display for TerminalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TerminalError::Limit(n) => write!(f, "the maximum of {n} terminals is already open"),
            TerminalError::Spawn(msg) => write!(f, "could not start the shell: {msg}"),
        }
    }
}

enum Control {
    Input(Vec<u8>),
    Resize(u16, u16),
    /// The browser side went away.
    Close,
    ChildExited,
}

/// The browser's handle on a running terminal. Dropping it closes the
/// terminal and kills the shell.
pub struct Terminal {
    pub id: u64,
    /// The command line that was started.
    pub shell: String,
    /// The program's file name without `.exe`, for the browser's tab title.
    pub name: String,
    /// Set when `terminal_shell` could not be started and the platform
    /// default was used instead: what to tell the user.
    pub notice: Option<String>,
    /// Output from the shell; `None` once the PTY closed.
    pub output: mpsc::Receiver<Vec<u8>>,
    control: std_mpsc::Sender<Control>,
    exit_code: Arc<AtomicI64>,
}

impl Terminal {
    /// Sends keystrokes to the shell.
    pub fn write(&self, data: Vec<u8>) {
        let _ = self.control.send(Control::Input(data));
    }

    /// Resizes the PTY.
    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.control.send(Control::Resize(cols.clamp(2, 1000), rows.clamp(1, 1000)));
    }

    /// The shell's exit code once it exited (-1 while running or unknown).
    pub fn exit_code(&self) -> i64 {
        self.exit_code.load(Ordering::SeqCst)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        // The waiter thread holds a sender too, so the channel would not
        // close by itself while the shell runs: say goodbye explicitly.
        let _ = self.control.send(Control::Close);
    }
}

/// Spawns and tracks terminals.
pub struct Terminals {
    next_id: AtomicU64,
    live: Arc<AtomicUsize>,
    killers: Arc<Mutex<HashMap<u64, Box<dyn ChildKiller + Send + Sync>>>>,
}

impl Default for Terminals {
    fn default() -> Self {
        Terminals::new()
    }
}

/// Decrements the live count and forgets the killer when a terminal ends.
struct LiveGuard {
    id: u64,
    live: Arc<AtomicUsize>,
    killers: Arc<Mutex<HashMap<u64, Box<dyn ChildKiller + Send + Sync>>>>,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.killers.locked().remove(&self.id);
        self.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Terminals {
    /// No terminals yet.
    pub fn new() -> Terminals {
        Terminals { next_id: AtomicU64::new(1), live: Arc::new(AtomicUsize::new(0)), killers: Arc::default() }
    }

    /// Terminals currently running.
    pub fn count(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    /// Starts `shell` (or the default shell) in `cwd`. A configured shell
    /// that cannot be started falls back to the platform default, with a
    /// `notice` saying so.
    pub fn spawn(&self, shell: &str, cwd: &Path, cols: u16, rows: u16, max: usize) -> Result<Terminal, TerminalError> {
        // Reserve a slot first so concurrent opens cannot exceed the cap.
        if self.live.fetch_add(1, Ordering::SeqCst) >= max {
            self.live.fetch_sub(1, Ordering::SeqCst);
            return Err(TerminalError::Limit(max));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let guard = LiveGuard { id, live: self.live.clone(), killers: self.killers.clone() };

        let size = PtySize { rows: rows.clamp(1, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 };
        let mut argv = shell_command(shell);
        let mut notice = None;
        let (master, mut child) = match start_shell(&argv, cwd, size) {
            Ok(started) => started,
            Err(err) if !shell.trim().is_empty() => {
                let fallback = vec![default_shell()];
                let started = start_shell(&fallback, cwd, size).map_err(TerminalError::Spawn)?;
                notice = Some(format!(
                    "terminal_shell \"{}\" could not be started ({err}); using {} instead",
                    shell.trim(),
                    fallback[0]
                ));
                argv = fallback;
                started
            }
            Err(err) => return Err(TerminalError::Spawn(err)),
        };
        let mut reader = master.try_clone_reader().map_err(|e| TerminalError::Spawn(e.to_string()))?;
        let mut writer = master.take_writer().map_err(|e| TerminalError::Spawn(e.to_string()))?;
        self.killers.locked().insert(id, child.clone_killer());
        let mut killer = child.clone_killer();

        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_QUEUE);
        let (control_tx, control_rx) = std_mpsc::channel::<Control>();
        let exit_code = Arc::new(AtomicI64::new(-1));

        // Reader: PTY -> channel. What happens once the browser side is gone
        // (`blocking_send` fails) depends on the platform:
        // - Windows: keep reading and discarding until EOF. `ClosePseudoConsole`
        //   (called when the control thread drops the master) can block until
        //   the output pipe is drained, so a reader that stopped early could hang
        //   that thread and leak the conhost. EOF comes once the pseudoconsole
        //   is closed, which also ends the processes attached to it.
        // - Unix: stop at once. Leaving closes this reader's descriptor of the
        //   master; with the control thread's one dropped too, the terminal is
        //   hung up for anything that survived the shell's SIGHUP (a disowned
        //   job, a shell ignoring HUP). Draining instead would keep this thread
        //   alive for as long as such a process writes.
        spawn_thread("tendril-pty-read", move || {
            let mut buf = vec![0u8; 16 * 1024];
            let mut receiver_gone = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !receiver_gone && output_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            if !cfg!(windows) {
                                break;
                            }
                            receiver_gone = true;
                        }
                    }
                }
            }
        });

        // Waiter: records the exit code and wakes the control thread.
        let waiter_control = control_tx.clone();
        let waiter_code = exit_code.clone();
        spawn_thread("tendril-pty-wait", move || {
            let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
            waiter_code.store(code, Ordering::SeqCst);
            let _ = waiter_control.send(Control::ChildExited);
        });

        // Control: input/resize -> PTY; owns the master and the live guard.
        spawn_thread("tendril-pty-ctl", move || {
            let _guard = guard;
            while let Ok(message) = control_rx.recv() {
                match message {
                    Control::Input(data) => {
                        if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                    }
                    Control::Resize(cols, rows) => {
                        let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                    }
                    Control::Close | Control::ChildExited => break,
                }
            }
            let _ = killer.kill();
            drop(writer);
            drop(master);
        });

        let name = program_name(&argv[0]);
        Ok(Terminal { id, shell: argv.join(" "), name, notice, output: output_rx, control: control_tx, exit_code })
    }

    /// Kills every running shell (shutdown).
    pub fn kill_all(&self) {
        for killer in self.killers.locked().values_mut() {
            let _ = killer.kill();
        }
    }
}

/// A program's file name without directories or `.exe`: `pwsh` for
/// `C:\Program Files\PowerShell\7\pwsh.exe`, `bash` for `/bin/bash`.
pub fn program_name(program: &str) -> String {
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file);
    if name.is_empty() { "shell".into() } else { name.into() }
}

/// A started shell: the PTY's master side and the child process.
type Started = (Box<dyn portable_pty::MasterPty + Send>, Box<dyn portable_pty::Child + Send + Sync>);

/// Opens a PTY and starts `argv` in it, in `cwd`.
fn start_shell(argv: &[String], cwd: &Path, size: PtySize) -> Result<Started, String> {
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::from_argv(argv.iter().map(Into::into).collect());
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "tendril");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The parent must not keep the slave open, or EOF never arrives.
    drop(pair.slave);
    Ok((pair.master, child))
}

fn spawn_thread(name: &str, body: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.into()).stack_size(THREAD_STACK).spawn(body);
}

/// The argument vector for a shell setting: the configured command, or the
/// platform default when it is empty. The program may be double-quoted so its
/// path can contain spaces (`"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo`);
/// an unquoted setting that names an existing file is taken whole, so a bare
/// path with spaces works too; otherwise the string is split on whitespace
/// (`bash -l`, `cmd.exe /k ...`).
pub fn shell_command(configured: &str) -> Vec<String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return vec![default_shell()];
    }
    if let Some(argv) = split_quoted_program(trimmed) {
        return argv;
    }
    if Path::new(trimmed).is_file() {
        return vec![trimmed.to_string()];
    }
    trimmed.split_whitespace().map(String::from).collect()
}

/// Splits `"program with spaces" arg1 arg2` into its argument vector, or
/// `None` when the string does not begin with a double-quoted program.
fn split_quoted_program(configured: &str) -> Option<Vec<String>> {
    let rest = configured.strip_prefix('"')?;
    let end = rest.find('"')?;
    let mut argv = vec![rest[..end].to_string()];
    argv.extend(rest[end + 1..].split_whitespace().map(String::from));
    Some(argv)
}

/// `$SHELL`, then bash, then `/bin/sh` on Unix; PowerShell, then `cmd.exe`
/// on Windows.
pub fn default_shell() -> String {
    if cfg!(windows) {
        if let Some(ps) = find_in_path("powershell.exe") {
            return ps.to_string_lossy().into_owned();
        }
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    }
    if let Ok(shell) = std::env::var("SHELL")
        && !shell.is_empty()
        && Path::new(&shell).exists()
    {
        return shell;
    }
    for candidate in ["/bin/bash", "/bin/sh"] {
        if Path::new(candidate).exists() {
            return candidate.into();
        }
    }
    "/bin/sh".into()
}

/// Looks a program up in `PATH`.
pub fn find_in_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(program)).find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    // A deterministic shell for the PTY tests: `/bin/sh` on Unix, `cmd.exe` on
    // Windows (both understand `echo`, `exit <code>` and whitespace-less args).
    #[cfg(unix)]
    const TEST_SHELL: &str = "/bin/sh";
    #[cfg(windows)]
    const TEST_SHELL: &str = "cmd.exe";

    /// A command line plus the platform's Enter key (`\r\n` for cmd.exe).
    fn line(command: &str) -> Vec<u8> {
        let eol = if cfg!(windows) { "\r\n" } else { "\n" };
        format!("{command}{eol}").into_bytes()
    }

    fn collect_until(term: &mut Terminal, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            match term.output.try_recv() {
                Ok(chunk) => {
                    // ConPTY asks for the cursor position (ESC[6n) at start-up;
                    // answer it so the shell is not left waiting (harmless on
                    // Unix, where no such request arrives).
                    if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                        term.write(b"\x1b[1;1R".to_vec());
                    }
                    seen.extend_from_slice(&chunk);
                    if String::from_utf8_lossy(&seen).contains(needle) {
                        break;
                    }
                }
                Err(mpsc::error::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(10)),
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            }
        }
        String::from_utf8_lossy(&seen).into_owned()
    }

    #[test]
    fn runs_a_shell_and_reports_its_exit() {
        let terminals = Terminals::new();
        let dir = std::env::temp_dir();
        let mut term = terminals.spawn(TEST_SHELL, &dir, 80, 24, 4).unwrap();
        assert_eq!(terminals.count(), 1);
        term.write(line("echo tendril-42"));
        let out = collect_until(&mut term, "tendril-42", Duration::from_secs(10));
        assert!(out.contains("tendril-42"), "{out}");
        term.resize(100, 30);
        term.write(line("exit 3"));
        // The output channel closes once the shell exited.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(term.output.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(term.exit_code(), 3);
        let deadline = Instant::now() + Duration::from_secs(10);
        while terminals.count() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(terminals.count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn closing_hangs_up_processes_that_outlive_the_shell() {
        // A job that ignores SIGHUP and keeps writing must not keep the
        // terminal (and its reader thread) alive: once the browser side is
        // gone the reader stops, the terminal is hung up, and the job's next
        // write fails, which ends its loop.
        let alive = |pid: i32| {
            // SAFETY: signal 0 sends nothing; it only checks that `pid` exists.
            unsafe { libc::kill(pid, 0) == 0 }
        };
        let terminals = Terminals::new();
        let dir = std::env::temp_dir().join(format!("tendril-hup-{}", crate::core::random::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("job.pid");
        let mut term = terminals.spawn(TEST_SHELL, &dir, 80, 24, 4).unwrap();
        term.write(line(&format!(
            "(trap '' HUP; while /bin/echo x; do sleep 0.05; done) & echo $! > '{}'; echo READY-$((1+1))",
            pid_file.display()
        )));
        let out = collect_until(&mut term, "READY-2", Duration::from_secs(10));
        assert!(out.contains("READY-2"), "{out}");
        let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        assert!(alive(pid));

        drop(term);
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let survived = alive(pid);
        if survived {
            // SAFETY: plain kill of the job this test started.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!survived, "a job writing to a closed terminal kept running");
    }

    #[test]
    fn program_names_for_tab_titles() {
        assert_eq!(program_name(r"C:\Program Files\PowerShell\7\pwsh.exe"), "pwsh");
        assert_eq!(program_name("cmd.exe"), "cmd");
        assert_eq!(program_name("/bin/bash"), "bash");
        assert_eq!(program_name(""), "shell");
    }

    #[test]
    fn an_invalid_terminal_shell_falls_back_to_the_default() {
        let terminals = Terminals::new();
        let dir = std::env::temp_dir();
        let mut term = terminals.spawn("tendril-no-such-shell --flag", &dir, 80, 24, 4).unwrap();
        let notice = term.notice.clone().expect("a notice about the fallback");
        assert!(notice.contains("tendril-no-such-shell"), "{notice}");
        assert_eq!(term.shell, default_shell());
        // The fallback is a working shell.
        term.write(line("echo fallback-42"));
        let out = collect_until(&mut term, "fallback-42", Duration::from_secs(10));
        assert!(out.contains("fallback-42"), "{out}");
        // A valid setting leaves no notice.
        assert!(terminals.spawn(TEST_SHELL, &dir, 80, 24, 4).unwrap().notice.is_none());
    }

    #[test]
    fn the_limit_is_enforced_and_dropping_frees_the_slot() {
        let terminals = Terminals::new();
        let dir = std::env::temp_dir();
        let first = terminals.spawn(TEST_SHELL, &dir, 80, 24, 1).unwrap();
        assert!(matches!(terminals.spawn(TEST_SHELL, &dir, 80, 24, 1), Err(TerminalError::Limit(1))));
        drop(first);
        let deadline = Instant::now() + Duration::from_secs(10);
        while terminals.count() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(terminals.spawn(TEST_SHELL, &dir, 80, 24, 1).is_ok());
    }

    #[test]
    fn shell_selection() {
        assert_eq!(shell_command("bash -l"), vec!["bash", "-l"]);
        assert_eq!(shell_command("  ").len(), 1);
        assert!(!default_shell().is_empty());
        // A double-quoted program keeps the spaces in its path (S3).
        assert_eq!(
            shell_command(r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo"#),
            vec![r"C:\Program Files\PowerShell\7\pwsh.exe", "-NoLogo"]
        );
        assert_eq!(shell_command(r#""just one""#), vec!["just one"]);
        // An unquoted setting that names an existing file is taken whole, even
        // when the path contains spaces.
        let dir = std::env::temp_dir().join(format!("tendril shell {}", crate::core::random::token_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("my shell");
        std::fs::write(&program, b"x").unwrap();
        let path = program.to_string_lossy().into_owned();
        assert_eq!(shell_command(&path), vec![path.clone()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
