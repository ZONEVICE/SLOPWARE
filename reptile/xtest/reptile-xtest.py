#!/usr/bin/env python3
"""reptile-xtest: helper for the Linux <-> Windows interoperability test of Reptile.

Temporary test tooling, standard library only, Python 3.8+. It is not part of
Reptile and is not meant to be committed.

What it does, on either machine:

  populate DIR      create the deterministic test tree (r1/ and r2/ inside DIR) and
                    write DIR/_xtest-expected-r0.json (the initial state)
  churn DIR -r N    apply a scripted sequence of changes inside DIR/rN, then
                    write DIR/_xtest-expected-rN.json (the digest of the final tree)
  converge DIR -r N wait until DIR matches the digest the OTHER side wrote
  digest DIR        print the digest of a directory
  clean DIR         empty a directory
  api URL METHOD PATH [JSON|@file]   call a Reptile instance's HTTP API
  wait URL KEY VALUE                 wait until GET /api/state has KEY (dotted, e.g.
                                     syncing.state) equal to VALUE (e.g. live)
  agent --root R --port P --token T  small HTTP agent so the other machine can
                                     run populate/churn/converge/clean/probe here
  remote URL TOKEN ACTION [DIR] ...  talk to such an agent

Why the digest travels inside the synced directory: the file
`_xtest-expected-rN.json` is written LAST by whoever made the changes, so it
reaches the other side through Reptile itself, and `converge` compares the
real content (SHA-256 per file) with it. Files whose names start with
`_xtest-` and Reptile's `.reptile-*.tmp` files are ignored by every digest.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = "_xtest-"
TMP = re.compile(r"^\.reptile-[0-9a-f]{8,32}\.tmp$")
RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
FORBIDDEN = set('\\:*?"<>|')
_hash_cache = {}


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# --- digests ---------------------------------------------------------------------------


def file_sha(path):
    info = os.stat(path)
    key = (path, info.st_size, info.st_mtime_ns)
    if key not in _hash_cache:
        h = hashlib.sha256()
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                h.update(block)
        _hash_cache[key] = h.hexdigest()
    return _hash_cache[key]


def digest(root):
    """{ "dir/": "dir", "dir/file": "<sha256>" }, symlinks and test files skipped."""
    entries = {}
    for current, dirs, files in os.walk(root):
        dirs.sort()
        rel = os.path.relpath(current, root).replace(os.sep, "/")
        rel = "" if rel == "." else rel + "/"
        for name in list(dirs):
            full = os.path.join(current, name)
            if name.startswith(PREFIX) or TMP.match(name) or os.path.islink(full):
                dirs.remove(name)
                continue
            entries[rel + name + "/"] = "dir"
        for name in files:
            full = os.path.join(current, name)
            if name.startswith(PREFIX) or TMP.match(name) or os.path.islink(full):
                continue
            try:
                entries[rel + name] = file_sha(full)
            except OSError as error:  # vanished or locked while reading
                entries[rel + name] = f"unreadable: {error.__class__.__name__}"
    return entries


def windows_unfriendly(path):
    """A name Windows cannot store as is (so a Windows peer cannot have it)."""
    for segment in path.rstrip("/").split("/"):
        if set(segment) & FORBIDDEN or segment.endswith((".", " ")) or segment.split(".")[0].lower() in RESERVED:
            return True
    return False


def case_collisions(paths):
    groups = {}
    for path in paths:
        groups.setdefault(path.lower(), []).append(path)
    return {path for group in groups.values() if len(group) > 1 for path in group}


def compare(actual, expected, tolerate_windows=False):
    tolerated = set()
    if tolerate_windows:
        collisions = case_collisions(expected)
        tolerated = {p for p in expected if windows_unfriendly(p) or p in collisions}
    missing = sorted(p for p in expected if p not in actual and p not in tolerated)
    extra = sorted(p for p in actual if p not in expected)
    changed = sorted(p for p in expected if p in actual and actual[p] != expected[p] and p not in tolerated)
    return {"missing": missing, "extra": extra, "changed": changed, "tolerated": sorted(tolerated)}


def expected_path(root, round_):
    return os.path.join(root, f"{PREFIX}expected-r{round_}.json")


def converge(root, round_, timeout, tolerate_windows):
    """Wait for the other side's digest to arrive, then for the tree to match it."""
    started = time.time()
    last = None
    while time.time() - started < timeout:
        try:
            with open(expected_path(root, round_), encoding="utf-8") as handle:
                expected = json.load(handle)["entries"]
        except (OSError, ValueError, KeyError):
            time.sleep(1)
            continue
        last = compare(digest(root), expected, tolerate_windows)
        if not (last["missing"] or last["extra"] or last["changed"]):
            return {"ok": True, "seconds": round(time.time() - started, 1), "tolerated": last["tolerated"]}
        time.sleep(1)
    if last is None:
        return {"ok": False, "reason": f"{expected_path(root, round_)} never arrived", "seconds": timeout}
    return {"ok": False, "seconds": timeout, **{k: v[:40] for k, v in last.items()}, "counts": {k: len(v) for k, v in last.items()}}


# --- the test tree and the scripted changes ----------------------------------------------------


def blob(seed, size):
    import random

    return random.Random(seed).getrandbits(8 * size).to_bytes(size, "little") if size else b""


def put(root, rel, content):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(content if isinstance(content, bytes) else content.encode("utf-8"))


def populate(root, files=300, big_mb=8, hostile=False):
    """r1/ and r2/, each with the same base tree; `hostile` adds names only Linux can hold."""
    os.makedirs(root, exist_ok=True)
    for r in ("r1", "r2"):
        put(root, f"{r}/docs/readme.txt", f"readme of {r}\n" * 20)
        put(root, f"{r}/docs/notes/ünïcode ñ año.txt", "unicode name\n")
        put(root, f"{r}/docs/spaces in name.txt", "spaces\n")
        put(root, f"{r}/empty-file", b"")
        os.makedirs(os.path.join(root, r, "empty-dir"), exist_ok=True)
        put(root, f"{r}/project/src/main.rs", "fn main() {}\n")
        put(root, f"{r}/project/README.md", "# project\n")
        put(root, f"{r}/old/a.txt", "to be moved\n")
        put(root, f"{r}/old/sub/b.txt", "to be deleted with its tree\n")
        for i in range(files):
            put(root, f"{r}/bulk/d{i // 50:02d}/f{i:04d}.bin", blob(f"{r}-{i}", 1024 + (i * 37) % 3000))
        put(root, f"{r}/big.bin", blob(f"{r}-big", big_mb * 1024 * 1024))
    if hostile:
        for name in ("a:b.txt", "what?.txt", "pipe|name.txt", 'quote".txt', "trailing.", "aux.txt", "Case.txt", "case.txt"):
            put(root, f"r1/weird/{name}", f"hostile: {name}\n")
    entries = digest(root)
    with open(expected_path(root, 0), "w", encoding="utf-8") as handle:  # round 0 = the initial state
        json.dump({"round": 0, "written": time.time(), "entries": entries}, handle)
    return {"entries": len(entries)}


def churn(root, round_):
    """Changes inside rN only, spaced so a rename is seen as a rename (window ~1.2 s)."""
    base = os.path.join(root, f"r{round_}")
    if not os.path.isdir(base):
        raise SystemExit(f"{base} does not exist: run populate first")
    p = lambda *parts: os.path.join(base, *parts)
    step = lambda text, pause: (log(f"  churn r{round_}: {text}"), time.sleep(pause))
    put(root, f"r{round_}/live/new1.txt", "brand new")
    put(root, f"r{round_}/live/dir/sub/leaf.bin", blob("leaf", 200_000))
    step("created files and nested directories", 2.5)
    with open(p("docs", "readme.txt"), "a", encoding="utf-8") as handle:
        handle.write("appended line\n")
    step("modified a file", 2.5)
    os.rename(p("docs", "spaces in name.txt"), p("docs", "renamed ñ.txt"))
    step("renamed a file", 3)
    os.rename(p("project"), p("project-renamed"))
    step("renamed a directory", 3)
    os.rename(p("old", "a.txt"), p("live", "a-moved.txt"))
    step("moved a file to another directory", 3)
    os.remove(p("bulk", "d00", "f0000.bin"))
    shutil.rmtree(p("old"))
    step("deleted a file and a tree", 3)
    os.remove(p("empty-file"))
    os.mkdir(p("empty-file"))
    put(root, f"r{round_}/empty-file/inside.txt", "now a directory")
    step("replaced a file by a directory", 2.5)
    put(root, f"r{round_}/live/big2.bin", blob("big2", 16 * 1024 * 1024))
    step("wrote a 16 MB file", 3)
    for i in range(100):
        put(root, f"r{round_}/burst/b{i:03d}.txt", f"burst {i}\n")
    step("burst of 100 small files", 4)
    entries = digest(root)
    with open(expected_path(root, round_), "w", encoding="utf-8") as handle:
        json.dump({"round": round_, "written": time.time(), "entries": entries}, handle)
    return {"entries": len(entries)}


def clean(root):
    os.makedirs(root, exist_ok=True)
    for name in os.listdir(root):
        full = os.path.join(root, name)
        shutil.rmtree(full) if os.path.isdir(full) and not os.path.islink(full) else os.remove(full)
    return {"cleaned": root}


# --- talking to Reptile and to the agent ----------------------------------------------------------


def http(method, url, body=None, headers=None, timeout=600):
    data = None if body is None else (body if isinstance(body, bytes) else body.encode("utf-8"))
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    context = ssl._create_unverified_context() if url.startswith("https") else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def reptile_api(url, method, path, payload):
    if payload and payload.startswith("@"):
        with open(payload[1:], encoding="utf-8") as handle:
            payload = handle.read()
    headers = {"Content-Type": "application/json"} if payload else ({} if method == "GET" else {"Content-Type": "application/json"})
    status, text = http(method, url.rstrip("/") + path, payload or ("{}" if method in ("POST", "PUT") else None), headers, 60)
    return status, text


class Agent(BaseHTTPRequestHandler):
    root, token = None, None

    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.headers.get("X-Token") != self.token:
            return self.reply(403, {"error": "bad token"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            action = self.path.strip("/")
            if action == "ping":
                return self.reply(200, {"now_ms": int(time.time() * 1000), "platform": sys.platform, "root": self.root})
            if action == "probe":  # can THIS machine reach that URL?
                started = time.time()
                try:
                    status, text = http("GET", body["url"], timeout=5)
                    return self.reply(200, {"status": status, "body": text[:300], "ms": int((time.time() - started) * 1000)})
                except Exception as error:  # noqa: BLE001 - report whatever went wrong
                    return self.reply(200, {"status": 0, "error": f"{error.__class__.__name__}: {error}"})
            name = body.get("dir", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", name):
                return self.reply(400, {"error": "dir must be one plain name"})
            target = os.path.join(self.root, name)
            os.makedirs(target, exist_ok=True)
            log(f"agent: {action} {name}")
            if action == "populate":
                result = populate(target, int(body.get("files", 300)), int(body.get("big_mb", 8)), bool(body.get("hostile")))
            elif action == "churn":
                result = churn(target, int(body.get("round", 1)))
            elif action == "converge":
                result = converge(target, int(body.get("round", 1)), int(body.get("timeout", 120)), bool(body.get("tolerate_windows")))
            elif action == "digest":
                result = {"entries": digest(target)}
            elif action == "clean":
                result = clean(target)
            else:
                return self.reply(404, {"error": f"unknown action {action}"})
            self.reply(200, result)
        except Exception as error:  # noqa: BLE001
            self.reply(500, {"error": f"{error.__class__.__name__}: {error}"})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("populate", "churn", "converge", "digest", "clean"):
        s = sub.add_parser(name)
        s.add_argument("dir")
        s.add_argument("-r", "--round", type=int, default=1)
        s.add_argument("--files", type=int, default=300)
        s.add_argument("--big-mb", type=int, default=8)
        s.add_argument("--hostile", action="store_true")
        s.add_argument("--timeout", type=int, default=120)
        s.add_argument("--tolerate-windows-names", action="store_true")
    s = sub.add_parser("api")
    s.add_argument("url")
    s.add_argument("method")
    s.add_argument("path")
    s.add_argument("payload", nargs="?")
    s = sub.add_parser("wait")
    s.add_argument("url")
    s.add_argument("key")
    s.add_argument("value")
    s.add_argument("--timeout", type=int, default=120)
    s = sub.add_parser("agent")
    s.add_argument("--root", required=True)
    s.add_argument("--port", type=int, default=55690)
    s.add_argument("--token", required=True)
    s = sub.add_parser("remote")
    s.add_argument("url")
    s.add_argument("token")
    s.add_argument("action")
    s.add_argument("dir", nargs="?")
    s.add_argument("-r", "--round", type=int, default=1)
    s.add_argument("--files", type=int, default=300)
    s.add_argument("--big-mb", type=int, default=8)
    s.add_argument("--hostile", action="store_true")
    s.add_argument("--timeout", type=int, default=120)
    s.add_argument("--tolerate-windows-names", action="store_true")
    s.add_argument("--probe-url")
    args = parser.parse_args()

    if args.command == "populate":
        result = populate(args.dir, args.files, args.big_mb, args.hostile)
    elif args.command == "churn":
        result = churn(args.dir, args.round)
    elif args.command == "converge":
        result = converge(args.dir, args.round, args.timeout, args.tolerate_windows_names)
    elif args.command == "digest":
        result = digest(args.dir)
    elif args.command == "clean":
        result = clean(args.dir)
    elif args.command == "api":
        status, text = reptile_api(args.url, args.method.upper(), args.path, args.payload)
        print(status, text)
        return 0 if status < 400 else 1
    elif args.command == "wait":
        started, seen = time.time(), None
        while time.time() - started < args.timeout:
            try:
                node = json.loads(http("GET", args.url.rstrip("/") + "/api/state", timeout=10)[1])
                for part in args.key.split("."):
                    node = node.get(part) if isinstance(node, dict) else None
                seen = node
                if str(node) == args.value:
                    print(json.dumps({"ok": True, "seconds": round(time.time() - started, 1)}))
                    return 0
            except Exception as error:  # noqa: BLE001 - keep polling
                seen = f"{error.__class__.__name__}"
            time.sleep(1)
        print(json.dumps({"ok": False, "last": seen, "seconds": args.timeout}))
        return 1
    elif args.command == "agent":
        Agent.root, Agent.token = os.path.abspath(args.root), args.token
        os.makedirs(Agent.root, exist_ok=True)
        server = ThreadingHTTPServer(("0.0.0.0", args.port), Agent)
        log(f"agent on :{args.port}, root {Agent.root}")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return 0
    else:  # remote
        body = {"dir": args.dir, "round": args.round, "files": args.files, "big_mb": args.big_mb, "hostile": args.hostile,
                "timeout": args.timeout, "tolerate_windows": args.tolerate_windows_names, "url": args.probe_url}
        before = int(time.time() * 1000)
        status, text = http("POST", args.url.rstrip("/") + "/" + args.action, json.dumps(body), {"X-Token": args.token, "Content-Type": "application/json"}, args.timeout + 900)
        after = int(time.time() * 1000)
        result = json.loads(text)
        if args.action == "ping" and "now_ms" in result:
            result["clock_skew_ms_remote_minus_local"] = result["now_ms"] - (before + after) // 2
            result["round_trip_ms"] = after - before
        if status >= 400:
            print(status, json.dumps(result))
            return 1
    print(json.dumps(result, ensure_ascii=False, indent=2) if not isinstance(result, dict) or len(json.dumps(result)) < 4000 else json.dumps({k: (f"<{len(v)} entries>" if k == "entries" else v) for k, v in result.items()}))
    return 0 if not isinstance(result, dict) or result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
