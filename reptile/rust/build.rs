//! Build script: embeds the control panel and checks the version.
//!
//! The control panel is the same set of HTML, CSS and ES modules the Node.js
//! implementation serves from `../node/public`. It is compiled into the binary
//! so that the Rust build is one self-contained executable; there is a single
//! front end for both implementations, and it lives in `node/public`.
//!
//! `version.txt` one directory up is the product version shared by both
//! implementations. Cargo needs the same string in `Cargo.toml` (for package
//! metadata such as the .deb), so the build stops when the two disagree.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));

    // --- Version -------------------------------------------------------------
    let version_file = manifest.join("..").join("version.txt");
    println!("cargo:rerun-if-changed={}", version_file.display());
    let version = fs::read_to_string(&version_file)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", version_file.display()))
        .trim()
        .to_string();
    let cargo_version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION");
    if version != cargo_version {
        panic!(
            "version mismatch: {} says {version:?} but Cargo.toml says {cargo_version:?}. \
             Update the `version` field of Cargo.toml to match.",
            version_file.display()
        );
    }
    println!("cargo:rustc-env=REPTILE_VERSION={version}");

    // --- Control panel ---------------------------------------------------------
    let public = env::var_os("REPTILE_PUBLIC_SRC")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("..").join("node").join("public"));
    println!("cargo:rerun-if-env-changed=REPTILE_PUBLIC_SRC");
    if !public.is_dir() {
        panic!(
            "the control panel files were not found at {}. They are shared with the Node.js \
             implementation; build from a full checkout of reptile/, or point \
             REPTILE_PUBLIC_SRC at a copy of node/public.",
            public.display()
        );
    }
    let mut files = Vec::new();
    collect(&public, &public, &mut files);
    files.sort();

    let mut out = String::from("/// The control panel, embedded at build time from `node/public`.\n");
    out.push_str("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    for (relative, absolute) in &files {
        println!("cargo:rerun-if-changed={}", absolute.display());
        let absolute = absolute.canonicalize().unwrap_or_else(|_| absolute.clone());
        writeln!(out, "    ({relative:?}, include_bytes!({:?})),", absolute.to_string_lossy()).unwrap();
    }
    out.push_str("];\n");
    let destination = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("assets.rs");
    fs::write(&destination, out).expect("write assets.rs");
}

/// Every regular file below `dir`, as (path relative to `base` with `/`, absolute path).
fn collect(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", dir.display()))
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().expect("file type");
        if kind.is_dir() {
            collect(base, &path, out);
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(base)
                .expect("inside base")
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((relative, path));
        }
    }
}
