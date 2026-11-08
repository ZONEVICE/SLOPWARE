//! Workspace-wide search: the file list behind "Go to File" and the text
//! search behind "Find in Files".
//!
//! Both walk the tree on demand, iteratively (no recursion depth limit), never
//! follow symbolic links to directories (no loops, no escaping the
//! workspace), skip the folders named in `search_exclude`, and stop at a
//! result cap or a time budget, reporting `truncated` so the browser can say
//! so. The tree view never uses this: it lists one folder at a time.
//!
//! Text search is literal (no regular expressions, to avoid a regex engine in
//! the binary), optionally ASCII case-insensitive and whole-word. Files over
//! 1 MiB, binary files and files that are not UTF-8 are skipped.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::jail::Jail;
use super::text;
use super::{FsError, FsResult};

/// Files larger than this are not searched.
pub const MAX_SEARCH_FILE: u64 = 1024 * 1024;

/// A walk over the workspace's files, yielding workspace-relative paths.
struct Walker<'a> {
    jail: &'a Jail,
    exclude: &'a [String],
    show_hidden: bool,
    stack: Vec<(PathBuf, String)>,
    pending: Vec<(PathBuf, String)>,
}

impl<'a> Walker<'a> {
    fn new(jail: &'a Jail, exclude: &'a [String], show_hidden: bool) -> Walker<'a> {
        Walker {
            jail,
            exclude,
            show_hidden,
            stack: vec![(jail.root().to_path_buf(), String::new())],
            pending: Vec::new(),
        }
    }
}

impl Iterator for Walker<'_> {
    /// (absolute path, workspace-relative path, size)
    type Item = (PathBuf, String, u64);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some((abs, rel)) = self.pending.pop() {
                let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
                return Some((abs, rel, size));
            }
            let (dir, rel_dir) = self.stack.pop()?;
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            let mut files = Vec::new();
            for entry in entries.flatten() {
                let Ok(name) = entry.file_name().into_string() else { continue };
                if !self.show_hidden && name.starts_with('.') {
                    continue;
                }
                let Ok(kind) = entry.file_type() else { continue };
                let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
                let path = entry.path();
                if kind.is_dir() {
                    if !self.exclude.contains(&name) {
                        self.stack.push((path, rel));
                    }
                } else if kind.is_file() {
                    files.push((path, rel));
                } else if kind.is_symlink() {
                    // Links to files inside the workspace are listed; links to
                    // directories are not followed.
                    if let Ok(target) = fs::canonicalize(&path)
                        && self.jail.contains(&target)
                        && fs::metadata(&target).map(|m| m.is_file()).unwrap_or(false)
                    {
                        files.push((path, rel));
                    }
                }
            }
            files.sort_by(|a, b| b.1.cmp(&a.1)); // popped in ascending order
            self.pending = files;
        }
    }
}

/// Result of [`list_files`].
#[derive(Debug, Serialize)]
pub struct FileList {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// Every file path in the workspace (for fuzzy "Go to File" in the browser),
/// up to `limit` entries.
pub fn list_files(jail: &Jail, exclude: &[String], show_hidden: bool, limit: usize) -> FileList {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut files = Vec::new();
    let mut truncated = false;
    for (_, rel, _) in Walker::new(jail, exclude, show_hidden) {
        if files.len() >= limit || Instant::now() > deadline {
            truncated = true;
            break;
        }
        files.push(rel);
    }
    files.sort_unstable();
    FileList { files, truncated }
}

/// Text search options.
#[derive(Debug, Clone)]
pub struct Query {
    pub needle: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// Only paths containing this substring (empty: all).
    pub include: String,
    pub max_matches: usize,
    pub budget: Duration,
}

/// One matching line.
#[derive(Debug, Serialize)]
pub struct LineMatch {
    /// 1-based line number.
    pub line: usize,
    /// 0-based column, in characters.
    pub col: usize,
    /// Match length, in characters.
    pub len: usize,
    /// The line (shortened around the match when long).
    pub text: String,
    /// Characters dropped from the start of `text`.
    pub offset: usize,
}

/// Matches within one file.
#[derive(Debug, Serialize)]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

/// Result of [`grep`].
#[derive(Debug, Serialize)]
pub struct GrepResult {
    pub results: Vec<FileMatches>,
    pub total: usize,
    pub files_searched: usize,
    pub truncated: bool,
}

/// Searches every text file of the workspace for a literal string.
pub fn grep(jail: &Jail, exclude: &[String], show_hidden: bool, query: &Query) -> FsResult<GrepResult> {
    if query.needle.is_empty() {
        return Err(FsError::InvalidPath("the search text is empty".into()));
    }
    let deadline = Instant::now() + query.budget;
    let needle: Vec<u8> = if query.case_sensitive {
        query.needle.as_bytes().to_vec()
    } else {
        query.needle.as_bytes().to_ascii_lowercase()
    };
    let include = query.include.to_lowercase();
    let mut out = GrepResult { results: Vec::new(), total: 0, files_searched: 0, truncated: false };
    for (abs, rel, size) in Walker::new(jail, exclude, show_hidden) {
        if out.total >= query.max_matches || Instant::now() > deadline {
            out.truncated = true;
            break;
        }
        if size > MAX_SEARCH_FILE || (!include.is_empty() && !rel.to_lowercase().contains(&include)) {
            continue;
        }
        let Ok(bytes) = fs::read(&abs) else { continue };
        if text::looks_binary(&bytes) {
            continue;
        }
        let Ok(content) = std::str::from_utf8(&bytes) else { continue };
        out.files_searched += 1;
        let mut matches = Vec::new();
        for (index, line) in content.lines().enumerate() {
            let hay: Vec<u8> =
                if query.case_sensitive { line.as_bytes().to_vec() } else { line.as_bytes().to_ascii_lowercase() };
            let mut from = 0;
            while let Some(pos) = find(&hay[from..], &needle).map(|p| p + from) {
                let end = pos + needle.len();
                if !query.whole_word || is_word_boundary(&hay, pos, end) {
                    matches.push(line_match(index + 1, line, pos, end));
                    out.total += 1;
                    break; // one entry per line is enough for the results list
                }
                from = pos + 1;
            }
            if out.total >= query.max_matches {
                break;
            }
        }
        if !matches.is_empty() {
            out.results.push(FileMatches { path: rel, matches });
        }
    }
    Ok(out)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn is_word_boundary(hay: &[u8], start: usize, end: usize) -> bool {
    (start == 0 || !is_word_byte(hay[start - 1])) && (end >= hay.len() || !is_word_byte(hay[end]))
}

/// Builds a [`LineMatch`], cutting long lines to a window around the match.
fn line_match(line_no: usize, line: &str, start: usize, end: usize) -> LineMatch {
    const BEFORE: usize = 60;
    const MAX: usize = 240;
    // Byte offsets of a match found in an ASCII-lowercased copy are valid in
    // the original line too: ASCII lowercasing never changes lengths.
    let col = line[..start].chars().count();
    let len = line[start..end].chars().count();
    let mut cut = 0;
    let mut shown = line;
    if line.len() > MAX {
        let mut from = start.saturating_sub(BEFORE);
        while !line.is_char_boundary(from) {
            from -= 1;
        }
        let mut to = (from + MAX).min(line.len());
        while !line.is_char_boundary(to) {
            to -= 1;
        }
        cut = line[..from].chars().count();
        shown = &line[from..to];
    }
    LineMatch { line: line_no, col, len, text: shown.to_string(), offset: cut }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::random;

    fn workspace() -> (PathBuf, Jail) {
        let base = std::env::temp_dir().join(format!("tendril-search-{}", random::token_hex(4)));
        fs::create_dir_all(base.join("src/deep")).unwrap();
        fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        fs::write(base.join("src/main.rs"), "fn main() {\n    let Total = 1;\n    total_count();\n}\n").unwrap();
        fs::write(base.join("src/deep/util.rs"), "pub fn total() {}\n").unwrap();
        fs::write(base.join("node_modules/pkg/index.js"), "total\n").unwrap();
        fs::write(base.join("logo.png"), [0x89, b'P', 0, 0, b't', b'o', b't', b'a', b'l']).unwrap();
        let jail = Jail::new(&base).unwrap();
        (base, jail)
    }

    fn excludes() -> Vec<String> {
        vec!["node_modules".into()]
    }

    fn query(needle: &str) -> Query {
        Query {
            needle: needle.into(),
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            max_matches: 100,
            budget: Duration::from_secs(5),
        }
    }

    #[test]
    fn lists_files_skipping_excluded_folders() {
        let (base, jail) = workspace();
        let list = list_files(&jail, &excludes(), true, 100);
        assert_eq!(list.files, vec!["logo.png", "src/deep/util.rs", "src/main.rs"]);
        assert!(!list.truncated);
        let capped = list_files(&jail, &excludes(), true, 1);
        assert!(capped.truncated);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finds_text_with_options() {
        let (base, jail) = workspace();
        let all = grep(&jail, &excludes(), true, &query("total")).unwrap();
        assert_eq!(all.total, 3); // Total, total_count, total() - not the binary, not node_modules
        let mut q = query("total");
        q.case_sensitive = true;
        assert_eq!(grep(&jail, &excludes(), true, &q).unwrap().total, 2);
        q.whole_word = true;
        let words = grep(&jail, &excludes(), true, &q).unwrap();
        assert_eq!(words.total, 1);
        assert_eq!(words.results[0].path, "src/deep/util.rs");
        assert_eq!(words.results[0].matches[0].col, 7);
        let mut inc = query("total");
        inc.include = "deep".into();
        assert_eq!(grep(&jail, &excludes(), true, &inc).unwrap().total, 1);
        assert!(grep(&jail, &excludes(), true, &query("")).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn long_lines_are_windowed_on_char_boundaries() {
        let line = format!("{}needle{}", "é".repeat(200), "x".repeat(400));
        let start = line.find("needle").unwrap();
        let m = line_match(1, &line, start, start + 6);
        assert!(m.text.contains("needle"));
        assert!(m.text.chars().count() <= 240);
        assert_eq!(m.col, 200);
        assert_eq!(m.offset + m.text.find("needle").map(|b| m.text[..b].chars().count()).unwrap(), 200);
    }
}
