//! Git, through the `git` program installed on the host. Tendril never
//! bundles git: when the host has none, or a workspace is not inside a
//! repository, the git endpoints say so and the browser hides git.
//!
//! What it does: status (branch, ahead/behind, changed files), a file's text
//! at `HEAD` or in the index (for diffs), stage, unstage, discard working-tree
//! changes, commit, list/switch/create branches, fetch, pull (fast-forward
//! only) and push. Nothing that rewrites history or deletes branches: force
//! pushes, resets, rebases and the like are for the terminal.
//!
//! Safety:
//! - Paths come from the browser workspace-relative; every component is
//!   validated by [`jail::split`] (no `..`, no NUL, Windows rules) and they
//!   are passed after `--`, with `GIT_LITERAL_PATHSPECS=1` so `*` or `:/` are
//!   plain names. git runs in the workspace folder.
//! - Branch names are checked by `git check-ref-format --branch` and may not
//!   start with `-`.
//! - git must never wait for a person: stdin is closed, there is no
//!   controlling terminal (a new session on Unix, no console on Windows),
//!   `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` (Git Credential
//!   Manager) and `SSH_ASKPASS_REQUIRE=never` (no password window on the
//!   host's screen). Credentials must already work (SSH agent or keys,
//!   a credential store); otherwise the operation fails with git's message.
//! - Every command has a time limit; remote ones a longer one.
//! - Status reads take no lock (`GIT_OPTIONAL_LOCKS=0`); commands that write
//!   are serialized, so double clicks cannot fight over `index.lock`.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::core::lock::LockExt;
use crate::services::files::{FsError, jail, text};

/// Limit for commands that stay on this machine.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Limit for fetch, pull and push.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(180);
/// Most changed files reported (a huge untracked tree must not flood the UI).
pub const MAX_FILES: usize = 5_000;
/// Most bytes kept from a command's output.
const MAX_OUTPUT: usize = 64 * 1024 * 1024;
/// Most characters of git's own error message passed on.
const MAX_MESSAGE: usize = 2_000;

/// Serializes the commands that write to a repository.
static WRITES: Mutex<()> = Mutex::new(());

/// Why a git operation failed.
#[derive(Debug)]
pub enum GitError {
    /// No `git` program on the host.
    Unavailable,
    /// The workspace is not inside a git working tree.
    NotARepository,
    /// A path or branch name was refused before running git.
    Invalid(String),
    /// git ran and failed; its own message.
    Failed(String),
    /// git did not finish in time (often a remote that never answers).
    TimedOut,
    /// The file at that revision cannot be shown as text.
    File(FsError),
    /// git could not be started or read.
    Io(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::Unavailable => write!(f, "git is not installed on the host"),
            GitError::NotARepository => write!(f, "this folder is not inside a git repository"),
            GitError::Invalid(why) => write!(f, "{why}"),
            GitError::Failed(message) => write!(f, "{message}"),
            GitError::TimedOut => write!(f, "git did not finish in time"),
            GitError::File(err) => write!(f, "{err}"),
            GitError::Io(message) => write!(f, "could not run git: {message}"),
        }
    }
}

impl From<FsError> for GitError {
    fn from(err: FsError) -> Self {
        GitError::File(err)
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// The branch and the changed files of a workspace.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Status {
    /// The current branch; `None` when detached.
    pub branch: Option<String>,
    /// The commit checked out (abbreviated), `None` before the first commit.
    pub commit: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    /// More than [`MAX_FILES`] changed: the list was cut.
    pub truncated: bool,
}

/// A changed (or untracked, or ignored) path, relative to the workspace.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct FileStatus {
    pub path: String,
    /// The old path of a rename, when it is inside the workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig: Option<String>,
    /// Status in the index (what a commit would record): `M`, `A`, `D`,
    /// `R`, `C`, `T`; `None` when nothing is staged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged: Option<char>,
    /// Status in the working tree against the index: `M`, `D`, `T`, or
    /// `U` for an untracked file; `None` when nothing is unstaged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged: Option<char>,
    /// A merge conflict waits for resolution.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
    /// Matched by `.gitignore` (folders end with `/`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
}

/// Local and remote-tracking branches.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Branches {
    pub current: Option<String>,
    pub local: Vec<String>,
    /// `origin/name` for branches that exist only remotely.
    pub remote: Vec<String>,
}

/// The `git --version` line, or `None` when git is not installed. Checked
/// once per process.
pub fn version() -> Option<String> {
    static VERSION: OnceLock<Option<String>> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            let out = run(Path::new("."), &["--version"], None, LOCAL_TIMEOUT).ok()?;
            out.ok().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .clone()
}

/// Output of a finished git command.
struct Output {
    stdout: Vec<u8>,
    stderr: String,
    success: bool,
}

impl Output {
    fn ok(&self) -> bool {
        self.success
    }

    /// The command's result, or its error message.
    fn check(self) -> GitResult<Vec<u8>> {
        if self.success {
            return Ok(self.stdout);
        }
        let mut message = self.stderr.trim().to_string();
        if message.is_empty() {
            message = String::from_utf8_lossy(&self.stdout).trim().to_string();
        }
        if message.is_empty() {
            message = "git failed".into();
        }
        if message.chars().count() > MAX_MESSAGE {
            message = message.chars().take(MAX_MESSAGE).collect::<String>() + "…";
        }
        Err(GitError::Failed(message))
    }
}

/// Reads all of `reader`, keeping at most `cap` bytes (the rest is drained
/// so the child never blocks on a full pipe).
fn drain(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => return kept,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
}

/// Runs git in `cwd` with the environment described in the module comment.
fn run<S: AsRef<OsStr>>(cwd: &Path, args: &[S], input: Option<&[u8]>, timeout: Duration) -> GitResult<Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Inherited variables that would point git elsewhere.
    for var in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_PREFIX"] {
        cmd.env_remove(var);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid only detaches the child from Tendril's terminal (so
        // ssh cannot prompt on the host's console); it is async-signal-safe
        // and touches no memory of the parent.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console: nothing can prompt on the host.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => GitError::Unavailable,
        _ => GitError::Io(err.to_string()),
    })?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(input);
    }
    let stdout = child.stdout.take().ok_or_else(|| GitError::Io("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| GitError::Io("no stderr".into()))?;
    let out = std::thread::spawn(move || drain(stdout, MAX_OUTPUT));
    let err = std::thread::spawn(move || drain(stderr, 256 * 1024));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(GitError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(GitError::Io(e.to_string())),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    Ok(Output { stdout, stderr, success: status.success() })
}

/// Kills git and, on Unix, what it started (ssh, remote helpers): they share
/// the session and process group `setsid` gave it.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: plain kill(2) of the process group led by our child.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }
    let _ = child.kill();
}

/// Runs a git command and returns its stdout, or git's error.
fn git<S: AsRef<OsStr>>(cwd: &Path, args: &[S]) -> GitResult<Vec<u8>> {
    run(cwd, args, None, LOCAL_TIMEOUT)?.check()
}

/// Same, holding the write lock.
fn git_write<S: AsRef<OsStr>>(cwd: &Path, args: &[S], timeout: Duration) -> GitResult<Vec<u8>> {
    let _writing = WRITES.locked();
    run(cwd, args, None, timeout)?.check()
}

/// Where the workspace sits in its repository: `""` at the top, `"sub/dir/"`
/// below it. Fails with [`GitError::NotARepository`] outside a working tree.
pub fn prefix(workspace: &Path) -> GitResult<String> {
    let out = run(workspace, &["rev-parse", "--show-prefix"], None, LOCAL_TIMEOUT)?;
    if !out.ok() {
        let message = out.stderr.to_ascii_lowercase();
        // "not a git repository", or inside a .git folder / bare repository.
        if message.contains("not a git repository") || message.contains("must be run in a work tree") {
            return Err(GitError::NotARepository);
        }
        return out.check().map(|_| String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches(['\r', '\n']).to_string())
}

/// The workspace's branch and changed files.
pub fn status(workspace: &Path) -> GitResult<Status> {
    let prefix = prefix(workspace)?;
    let out = git(
        workspace,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored=matching", "--", "."],
    )?;
    Ok(parse_status(&out, &prefix))
}

/// Parses `git status --porcelain=v2 --branch -z` (paths relative to the
/// repository root) into workspace-relative entries.
pub fn parse_status(out: &[u8], prefix: &str) -> Status {
    let mut status = Status::default();
    let records: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    let local = |path: &str| -> Option<String> {
        let rest = path.strip_prefix(prefix)?;
        (!rest.is_empty()).then(|| rest.to_string())
    };
    let side = |c: u8| (c != b'.').then_some(c as char);
    let mut i = 0;
    while i < records.len() {
        let record = String::from_utf8_lossy(records[i]).into_owned();
        i += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.commit = Some(value.chars().take(12).collect()),
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = record.as_bytes()[0];
        let entry = match kind {
            // 1 XY sub mH mI mW hH hI path
            b'1' => {
                let fields: Vec<&str> = record.splitn(9, ' ').collect();
                let xy = fields.get(1).map(|s| s.as_bytes()).unwrap_or(b"..");
                local(fields.get(8).copied().unwrap_or("")).map(|path| FileStatus {
                    path,
                    staged: side(xy[0]),
                    unstaged: side(xy[1]),
                    ..Default::default()
                })
            }
            // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
            b'2' => {
                let fields: Vec<&str> = record.splitn(10, ' ').collect();
                let xy = fields.get(1).map(|s| s.as_bytes()).unwrap_or(b"..");
                let orig = records.get(i).map(|r| String::from_utf8_lossy(r).into_owned()).unwrap_or_default();
                i += 1;
                local(fields.get(9).copied().unwrap_or("")).map(|path| FileStatus {
                    path,
                    orig: local(&orig),
                    staged: side(xy[0]),
                    unstaged: side(xy[1]),
                    ..Default::default()
                })
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            b'u' => {
                let fields: Vec<&str> = record.splitn(11, ' ').collect();
                local(fields.get(10).copied().unwrap_or("")).map(|path| FileStatus {
                    path,
                    conflict: true,
                    ..Default::default()
                })
            }
            b'?' => local(&record[2..]).map(|path| FileStatus { path, unstaged: Some('U'), ..Default::default() }),
            b'!' => local(&record[2..]).map(|path| FileStatus { path, ignored: true, ..Default::default() }),
            _ => None,
        };
        if let Some(entry) = entry {
            if status.files.len() >= MAX_FILES {
                status.truncated = true;
                break;
            }
            status.files.push(entry);
        }
    }
    status
}

/// Validates workspace-relative paths for git (see the module comment).
fn clean_paths(paths: &[String]) -> GitResult<Vec<String>> {
    if paths.is_empty() {
        return Err(GitError::Invalid("no files given".into()));
    }
    paths
        .iter()
        .map(|p| {
            let parts = jail::split(p).map_err(GitError::from)?;
            if parts.is_empty() {
                return Err(GitError::Invalid("the workspace itself is not a file".into()));
            }
            Ok(parts.join("/"))
        })
        .collect()
}

/// `git <args...> -- <paths>`, holding the write lock.
fn on_paths(workspace: &Path, args: &[&str], paths: &[String]) -> GitResult<()> {
    let paths = clean_paths(paths)?;
    prefix(workspace)?;
    let mut all: Vec<&str> = args.to_vec();
    all.push("--");
    all.extend(paths.iter().map(String::as_str));
    git_write(workspace, &all, LOCAL_TIMEOUT).map(|_| ())
}

/// Stages files (new, changed or deleted).
pub fn stage(workspace: &Path, paths: &[String]) -> GitResult<()> {
    on_paths(workspace, &["add", "--all"], paths)
}

/// Unstages files, keeping the working tree as it is.
pub fn unstage(workspace: &Path, paths: &[String]) -> GitResult<()> {
    let has_head = run(workspace, &["rev-parse", "--verify", "--quiet", "HEAD"], None, LOCAL_TIMEOUT)?.ok();
    if has_head {
        on_paths(workspace, &["restore", "--staged"], paths)
    } else {
        // Before the first commit there is no HEAD to restore from.
        on_paths(workspace, &["rm", "--cached", "--quiet", "-r"], paths)
    }
}

/// Discards working-tree changes of tracked files (back to the index).
/// Untracked files are deleted through the file API instead.
pub fn discard(workspace: &Path, paths: &[String]) -> GitResult<()> {
    on_paths(workspace, &["restore", "--worktree"], paths)
}

/// Commits what is staged (`all`: every change of tracked files) with
/// `message`. Returns git's one-line summary.
pub fn commit(workspace: &Path, message: &str, all: bool) -> GitResult<String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(GitError::Invalid("the commit message is empty".into()));
    }
    prefix(workspace)?;
    let mut args = vec!["commit", "--file=-", "--cleanup=strip"];
    if all {
        args.push("--all");
    }
    let _writing = WRITES.locked();
    let out = run(workspace, &args, Some(message.as_bytes()), LOCAL_TIMEOUT)?.check()?;
    Ok(String::from_utf8_lossy(&out).lines().next().unwrap_or("").trim().to_string())
}

/// The text of a file at `HEAD` (`index: false`) or in the index, as the
/// editor shows text (LF, no BOM). `None` when the file is not there (new
/// or untracked).
pub fn show(workspace: &Path, path: &str, index: bool, limit: u64) -> GitResult<Option<String>> {
    let clean = clean_paths(&[path.to_string()])?.remove(0);
    prefix(workspace)?;
    let spec = if index { format!(":./{clean}") } else { format!("HEAD:./{clean}") };
    let out = run(workspace, &["show", spec.as_str()], None, LOCAL_TIMEOUT)?;
    if !out.ok() {
        let message = out.stderr.to_ascii_lowercase();
        let absent = ["does not exist", "exists on disk, but not in", "invalid object name", "bad revision"]
            .iter()
            .any(|m| message.contains(m));
        return if absent { Ok(None) } else { out.check().map(|_| None) };
    }
    if out.stdout.len() as u64 > limit {
        return Err(GitError::File(FsError::TooLarge { size: out.stdout.len() as u64, limit }));
    }
    Ok(Some(text::decode(out.stdout)?.text))
}

/// The local and remote-tracking branches.
pub fn branches(workspace: &Path) -> GitResult<Branches> {
    prefix(workspace)?;
    let out = git(workspace, &["for-each-ref", "--format=%(HEAD)%(refname)", "refs/heads", "refs/remotes"])?;
    let mut list = Branches::default();
    let mut remote = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let (current, name) = line.split_at(1);
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            if current == "*" {
                list.current = Some(branch.to_string());
            }
            list.local.push(branch.to_string());
        } else if let Some(branch) = name.strip_prefix("refs/remotes/") {
            if !branch.ends_with("/HEAD") {
                remote.push(branch.to_string());
            }
        }
    }
    // Remote branches that already have a local branch of the same name add nothing.
    list.remote = remote
        .into_iter()
        .filter(|r| !r.split_once('/').is_some_and(|(_, name)| list.local.iter().any(|l| l == name)))
        .collect();
    Ok(list)
}

/// Checks a branch name with git's own rules.
fn branch_name(workspace: &Path, name: &str) -> GitResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err(GitError::Invalid(format!("\"{name}\" is not a valid branch name")));
    }
    let out = run(workspace, &["check-ref-format", "--branch", name], None, LOCAL_TIMEOUT)?;
    if !out.ok() {
        return Err(GitError::Invalid(format!("\"{name}\" is not a valid branch name")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Switches to a local branch, or (`remote`) creates a local branch that
/// tracks `origin/name`. git refuses when local changes would be lost.
pub fn checkout(workspace: &Path, name: &str, remote: bool) -> GitResult<()> {
    prefix(workspace)?;
    let name = branch_name(workspace, name)?;
    if remote {
        git_write(workspace, &["switch", "--track", name.as_str()], LOCAL_TIMEOUT).map(|_| ())
    } else {
        git_write(workspace, &["switch", name.as_str()], LOCAL_TIMEOUT).map(|_| ())
    }
}

/// Creates a branch from the current commit and switches to it.
pub fn create_branch(workspace: &Path, name: &str) -> GitResult<()> {
    prefix(workspace)?;
    let name = branch_name(workspace, name)?;
    git_write(workspace, &["switch", "--create", name.as_str()], LOCAL_TIMEOUT).map(|_| ())
}

/// Downloads new commits from the remotes.
pub fn fetch(workspace: &Path) -> GitResult<()> {
    prefix(workspace)?;
    git_write(workspace, &["fetch", "--all"], REMOTE_TIMEOUT).map(|_| ())
}

/// Brings the upstream's commits in when that needs no merge.
pub fn pull(workspace: &Path) -> GitResult<()> {
    prefix(workspace)?;
    git_write(workspace, &["pull", "--ff-only"], REMOTE_TIMEOUT).map(|_| ())
}

/// Pushes the current branch; a branch without upstream is published to
/// `origin` (or the only remote) and starts tracking it.
pub fn push(workspace: &Path) -> GitResult<()> {
    let status = status(workspace)?;
    if status.upstream.is_some() {
        return git_write(workspace, &["push"], REMOTE_TIMEOUT).map(|_| ());
    }
    if status.branch.is_none() {
        return Err(GitError::Invalid("there is no branch to push (detached HEAD)".into()));
    }
    let remotes = String::from_utf8_lossy(&git(workspace, &["remote"])?).into_owned();
    let remotes: Vec<&str> = remotes.lines().map(str::trim).filter(|r| !r.is_empty()).collect();
    let remote = if remotes.contains(&"origin") { "origin" } else { remotes.first().copied().unwrap_or("") };
    if remote.is_empty() {
        return Err(GitError::Invalid("the repository has no remote to push to".into()));
    }
    git_write(workspace, &["push", "--set-upstream", remote, "HEAD"], REMOTE_TIMEOUT).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn porcelain_v2_is_parsed_relative_to_the_workspace() {
        let out = [
            "# branch.oid 1234567890abcdef1234567890abcdef12345678",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb ws/src/main.rs",
            "1 A. N... 000000 100644 100644 000 ccc ws/new file.txt",
            "2 R. N... 100644 100644 100644 ddd ddd R100 ws/renamed.rs",
            "ws/old.rs",
            "u UU N... 100644 100644 100644 100644 e f g ws/conflict.txt",
            "? ws/untracked.md",
            "! ws/target/",
            "1 .M N... 100644 100644 100644 aaa bbb outside/elsewhere.rs",
            "",
        ]
        .join("\0");
        let status = parse_status(out.as_bytes(), "ws/");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.commit.as_deref(), Some("1234567890ab"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        type Row<'a> = (&'a str, Option<char>, Option<char>, bool, bool);
        let summary: Vec<Row> =
            status.files.iter().map(|f| (f.path.as_str(), f.staged, f.unstaged, f.conflict, f.ignored)).collect();
        assert_eq!(
            summary,
            vec![
                ("src/main.rs", None, Some('M'), false, false),
                ("new file.txt", Some('A'), None, false, false),
                ("renamed.rs", Some('R'), None, false, false),
                ("conflict.txt", None, None, true, false),
                ("untracked.md", None, Some('U'), false, false),
                ("target/", None, None, false, true),
            ]
        );
        assert_eq!(status.files[2].orig.as_deref(), Some("old.rs"));
        // Detached HEAD before the first commit.
        let status = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0", "");
        assert_eq!((status.branch, status.commit), (None, None));
    }

    #[test]
    fn paths_and_branch_names_are_checked_before_git_runs() {
        assert!(matches!(clean_paths(&["../outside".into()]), Err(GitError::File(FsError::Outside))));
        assert!(matches!(clean_paths(&[]), Err(GitError::Invalid(_))));
        assert!(matches!(clean_paths(&["".into()]), Err(GitError::Invalid(_))));
        // GIT_LITERAL_PATHSPECS makes `*` a plain name, which only Unix allows
        // as a filename; Windows refuses `*` in a path component.
        #[cfg(not(windows))]
        assert_eq!(clean_paths(&["./a//b.txt".into(), "*".into()]).unwrap(), vec!["a/b.txt", "*"]);
        #[cfg(windows)]
        {
            assert_eq!(clean_paths(&["./a//b.txt".into()]).unwrap(), vec!["a/b.txt"]);
            assert!(matches!(clean_paths(&["*".into()]), Err(GitError::File(FsError::InvalidPath(_)))));
        }
    }

    /// A scratch repository; `None` when git is not installed here.
    fn repo(name: &str) -> Option<PathBuf> {
        version()?;
        let dir = std::env::temp_dir().join(format!("tendril-git-{name}-{}", crate::core::random::token_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "--quiet", "--initial-branch=main"],
            vec!["config", "user.name", "Tendril Test"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
            // Keep line endings byte-for-byte: Git for Windows defaults
            // core.autocrlf to true, which would check files out with CRLF.
            vec!["config", "core.autocrlf", "false"],
        ] {
            git(&dir, &args).unwrap();
        }
        Some(dir)
    }

    #[test]
    fn a_whole_round_of_local_work() {
        let Some(dir) = repo("round") else { return };
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        let status = status(&dir).unwrap();
        assert_eq!(status.commit, None);
        assert!(status.files.iter().any(|f| f.path == "a.txt" && f.unstaged == Some('U')));

        // `*` is a plain name (GIT_LITERAL_PATHSPECS). Only Unix allows a file
        // named `*`: there, staging it leaves a.txt alone, and unstaging works
        // before the first commit too.
        #[cfg(not(windows))]
        {
            fs::write(dir.join("*"), "a file literally named star\n").unwrap();
            stage(&dir, &["*".into()]).unwrap();
            let s = super::status(&dir).unwrap();
            assert!(s.files.iter().any(|f| f.path == "*" && f.staged == Some('A')));
            assert!(s.files.iter().any(|f| f.path == "a.txt" && f.staged.is_none()));
            unstage(&dir, &["*".into()]).unwrap();
        }
        stage(&dir, &["a.txt".into()]).unwrap();
        assert!(commit(&dir, "   ", false).is_err());
        let summary = commit(&dir, "First commit", false).unwrap();
        assert!(summary.contains("First commit"), "{summary}");

        fs::write(dir.join("a.txt"), "one\ntwo\r\n").unwrap();
        assert_eq!(show(&dir, "a.txt", false, 1 << 20).unwrap().as_deref(), Some("one\n"));
        assert_eq!(show(&dir, "missing.txt", false, 1 << 20).unwrap(), None);
        discard(&dir, &["a.txt".into()]).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");

        create_branch(&dir, "feature/x").unwrap();
        assert!(create_branch(&dir, "-oops").is_err());
        assert!(create_branch(&dir, "bad..name").is_err());
        let list = branches(&dir).unwrap();
        assert_eq!(list.current.as_deref(), Some("feature/x"));
        assert!(list.local.contains(&"main".to_string()));
        checkout(&dir, "main", false).unwrap();
        assert_eq!(super::status(&dir).unwrap().branch.as_deref(), Some("main"));

        // Pushing without a remote explains itself instead of hanging.
        assert!(matches!(push(&dir), Err(GitError::Invalid(_))));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_outside_any_repository_says_so() {
        if version().is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("tendril-nogit-{}", crate::core::random::token_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        // GIT_CEILING_DIRECTORIES is not needed: the temp folder is not a repository.
        assert!(matches!(status(&dir), Err(GitError::NotARepository)));
        let _ = fs::remove_dir_all(&dir);
    }
}
