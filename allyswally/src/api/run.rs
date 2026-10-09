//! Executing a saved MASKED item: a keyboard shortcut, an open/run target, a
//! clipboard paste, or code.
//!
//! This is where the GUI's "run" verb lands for every category. Each action is
//! written to the audit log — in full for executed code and launched targets,
//! but only as a type and a length for clipboard/text, which could be a
//! password.

use crate::exec;
use crate::input::{keymap, InputSession};
use crate::json::{Obj, Value};
use crate::state::AppState;
use crate::win::{clipboard, shell};
use std::sync::Arc;
use std::time::Duration;

use super::items;

/// Run the item `id` in `category`. Returns a result object for the GUI.
pub fn run_item(state: &Arc<AppState>, category: &str, id: &str) -> Value {
    if !AppState::is_category(category) {
        return err("unknown category");
    }
    let list = state.store.get(&AppState::category_file(category));
    let item = match items::find(&list, id) {
        Some(it) => it.clone(),
        None => return err("item not found"),
    };
    let name = item.get_str("name").unwrap_or("").to_string();

    match category {
        "shortcuts" => run_shortcut(state, &item, &name),
        "launchers" => run_launcher(state, &item, &name),
        "clipboard" => run_clipboard(state, &item, &name),
        "scripts" => run_script(state, &item, &name),
        _ => err("unknown category"),
    }
}

fn run_shortcut(state: &Arc<AppState>, item: &Value, name: &str) -> Value {
    // Accept either a "keys" array or a "combo" string like "Ctrl+Shift+Esc".
    let keys: Vec<String> = if let Some(arr) = item.get("keys").and_then(|v| v.as_array()) {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
    } else if let Some(combo) = item.get_str("combo") {
        keymap::split_combo(combo)
    } else {
        return err("shortcut has no keys");
    };

    let session = InputSession::new();
    let ok = session.combo(&keys);
    state.logger.info(
        "shortcut.run",
        vec![
            ("name".into(), Value::Str(name.to_string())),
            ("keys".into(), Value::Str(keys.join("+"))),
            ("ok".into(), Value::Bool(ok)),
        ],
    );
    if ok {
        Obj::new().boolean("ok", true).str("kind", "shortcut").build()
    } else {
        err("one or more keys were not recognised")
    }
}

fn run_launcher(state: &Arc<AppState>, item: &Value, name: &str) -> Value {
    let target = match item.get_str("target") {
        Some(t) if !t.is_empty() => t,
        _ => return err("launcher has no target"),
    };
    let args = item.get_str("args").filter(|s| !s.is_empty());
    let ok = shell::open(target, args);
    state.logger.info(
        "launcher.open",
        vec![
            ("name".into(), Value::Str(name.to_string())),
            ("target".into(), Value::Str(target.to_string())),
            ("ok".into(), Value::Bool(ok)),
        ],
    );
    if ok {
        Obj::new().boolean("ok", true).str("kind", "launcher").build()
    } else {
        err("the shell could not open the target")
    }
}

fn run_clipboard(state: &Arc<AppState>, item: &Value, name: &str) -> Value {
    let text = item.get_str("text").unwrap_or("");
    let mode = item.get_str("mode").unwrap_or("paste");
    let restore = item.get_bool("restore").unwrap_or(false);

    // Privacy: never log the content, only a type and a length.
    state.logger.info(
        "clipboard.send",
        vec![
            ("name".into(), Value::Str(name.to_string())),
            ("mode".into(), Value::Str(mode.to_string())),
            ("chars".into(), Value::Num(text.chars().count() as f64)),
        ],
    );

    if mode == "type" {
        InputSession::new().type_text(text);
        return Obj::new().boolean("ok", true).str("kind", "clipboard").build();
    }

    // Paste mode: optionally remember the previous clipboard, set ours, send
    // Ctrl+V, then restore.
    let previous = if restore { clipboard::get_text() } else { None };
    if !clipboard::set_text(text) {
        return err("could not open the host clipboard");
    }
    let session = InputSession::new();
    session.combo(&["ctrl".to_string(), "v".to_string()]);
    if restore {
        std::thread::sleep(Duration::from_millis(150));
        if let Some(prev) = previous {
            clipboard::set_text(&prev);
        }
    }
    Obj::new().boolean("ok", true).str("kind", "clipboard").build()
}

fn run_script(state: &Arc<AppState>, item: &Value, name: &str) -> Value {
    let lang = item.get_str("lang").unwrap_or("cmd");
    let source = item.get_str("source").unwrap_or("inline");
    let detached = item.get_bool("runDetached").unwrap_or(lang.starts_with("ahk"));
    let args: Vec<String> = item
        .get("args")
        .and_then(|v| v.as_str())
        .map(|s| split_args(s))
        .unwrap_or_default();

    let (timeout, limit) =
        state.with_config(|c| (c.command_timeout_secs(), c.command_output_limit()));
    let timeout = Duration::from_secs(timeout);

    // Resolve the program and arguments for this language/source.
    let plan = match build_plan(state, item, lang, source, &args) {
        Ok(p) => p,
        Err(e) => return err(&e),
    };

    // Audit: executed code is logged in full.
    state.logger.info(
        "script.run",
        vec![
            ("name".into(), Value::Str(name.to_string())),
            ("lang".into(), Value::Str(lang.to_string())),
            ("program".into(), Value::Str(plan.program.clone())),
            ("args".into(), Value::Str(plan.args.join(" "))),
            ("detached".into(), Value::Bool(detached)),
        ],
    );

    if plan.shell_open {
        let ok = shell::open(&plan.program, None);
        return if ok {
            Obj::new().boolean("ok", true).str("kind", "script").build()
        } else {
            err("the shell could not open the target")
        };
    }

    if detached {
        match exec::spawn_detached(&plan.program, &plan.args) {
            Ok(pid) => Obj::new()
                .boolean("ok", true)
                .str("kind", "script")
                .boolean("detached", true)
                .num("pid", pid as f64)
                .build(),
            Err(e) => err(&format!("failed to launch: {e}")),
        }
    } else {
        let result = if lang == "cmd" && source == "inline" {
            exec::run_cmd_line(plan.cmd_line.as_deref().unwrap_or(""), timeout, limit)
        } else {
            exec::run_capture(&plan.program, &plan.args, timeout, limit)
        };
        exec_result_to_value(result)
    }
}

struct Plan {
    program: String,
    args: Vec<String>,
    cmd_line: Option<String>,
    shell_open: bool,
}

/// Work out what to actually run for a script item. Inline interpreter code is
/// written to a temp file first; `cmd` inline runs through `cmd /C`; "other"
/// with a path is handed to the shell.
fn build_plan(
    state: &Arc<AppState>,
    item: &Value,
    lang: &str,
    source: &str,
    args: &[String],
) -> Result<Plan, String> {
    let interp_key = match lang {
        "python" => Some("python"),
        "node" => Some("node"),
        "ahkV1" => Some("ahkV1"),
        "ahkV2" => Some("ahkV2"),
        _ => None,
    };

    if lang == "cmd" {
        if source == "file" {
            let path = item.get_str("path").unwrap_or("").to_string();
            if path.is_empty() {
                return Err("no file path".into());
            }
            return Ok(Plan {
                program: "cmd".into(),
                args: {
                    let mut a = vec!["/C".to_string(), path];
                    a.extend_from_slice(args);
                    a
                },
                cmd_line: None,
                shell_open: false,
            });
        }
        let code = item.get_str("code").unwrap_or("").to_string();
        if code.is_empty() {
            return Err("no code".into());
        }
        return Ok(Plan {
            program: "cmd".into(),
            args: vec![],
            cmd_line: Some(code),
            shell_open: false,
        });
    }

    if lang == "other" {
        // Best effort: open a path with the shell, or run inline as a cmd line.
        if source == "file" {
            let path = item.get_str("path").unwrap_or("").to_string();
            if path.is_empty() {
                return Err("no file path".into());
            }
            return Ok(Plan {
                program: path,
                args: vec![],
                cmd_line: None,
                shell_open: true,
            });
        }
        let code = item.get_str("code").unwrap_or("").to_string();
        return Ok(Plan {
            program: "cmd".into(),
            args: vec![],
            cmd_line: Some(code),
            shell_open: false,
        });
    }

    // Interpreter languages (python/node/ahk).
    let key = interp_key.ok_or_else(|| format!("unsupported language `{lang}`"))?;
    let program = state
        .with_config(|c| c.interpreter(key))
        .ok_or_else(|| format!("interpreter for `{lang}` is not configured"))?;

    let file = if source == "file" {
        let path = item.get_str("path").unwrap_or("").to_string();
        if path.is_empty() {
            return Err("no file path".into());
        }
        path
    } else {
        let code = item.get_str("code").unwrap_or("");
        if code.is_empty() {
            return Err("no code".into());
        }
        write_temp_script(state, lang, code)?
    };

    let mut full_args = vec![file];
    full_args.extend_from_slice(args);
    Ok(Plan {
        program,
        args: full_args,
        cmd_line: None,
        shell_open: false,
    })
}

/// Write inline code to a temp file with the right extension, returning its path.
fn write_temp_script(state: &Arc<AppState>, lang: &str, code: &str) -> Result<String, String> {
    let ext = match lang {
        "python" => "py",
        "node" => "js",
        "ahkV1" | "ahkV2" => "ahk",
        _ => "txt",
    };
    let dir = state.paths.root.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    let file = dir.join(format!("script-{}.{ext}", items::new_id()));
    std::fs::write(&file, code).map_err(|e| format!("write temp: {e}"))?;
    Ok(file.to_string_lossy().into_owned())
}

fn exec_result_to_value(r: exec::ExecResult) -> Value {
    Obj::new()
        .boolean("ok", r.error.is_none())
        .str("kind", "script")
        .boolean("launched", r.launched)
        .set(
            "exitCode",
            r.exit_code.map(|c| Value::Num(c as f64)).unwrap_or(Value::Null),
        )
        .str("stdout", r.stdout)
        .str("stderr", r.stderr)
        .boolean("timedOut", r.timed_out)
        .boolean("truncated", r.truncated)
        .set(
            "error",
            r.error.map(Value::Str).unwrap_or(Value::Null),
        )
        .build()
}

/// Split a simple argument string on spaces, honouring double quotes.
fn split_args(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        args.push(cur);
    }
    args
}

fn err(msg: &str) -> Value {
    Obj::new().boolean("ok", false).str("error", msg).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_splitting_respects_quotes() {
        assert_eq!(split_args("a b c"), vec!["a", "b", "c"]);
        assert_eq!(split_args("\"a b\" c"), vec!["a b", "c"]);
        assert_eq!(split_args("  spaced   out "), vec!["spaced", "out"]);
    }
}
