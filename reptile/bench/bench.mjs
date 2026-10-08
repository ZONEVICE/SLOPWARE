#!/usr/bin/env node
/**
 * Black-box benchmark for Reptile, either implementation.
 *
 * Starts two real Reptile processes (a host and a syncing peer) on loopback,
 * drives them through the control-panel HTTP API only, and measures for each
 * scenario: wall time to convergence, CPU time of each process (from
 * /proc/<pid>/stat) and resident memory (mean and peak, from /proc/<pid>/status;
 * the peak is reset per scenario through /proc/<pid>/clear_refs). After each
 * scenario both trees are compared byte for byte, so a run is also an
 * end-to-end correctness check.
 *
 * It only uses the processes and their HTTP API, so it measures the Node.js
 * implementation (the default), the Rust one, or a mix of both:
 *
 *   node bench/bench.mjs                                    # Node.js, default sizes
 *   node bench/bench.mjs --quick                            # small sizes, a smoke run
 *   node bench/bench.mjs --cmd rust/target/release/reptile  # Rust
 *   node bench/bench.mjs --host-cmd "node node/src/index.js" --peer-cmd rust/target/release/reptile
 *   node bench/bench.mjs --https --out results.json
 *   node bench/bench.mjs --files 50000 --big-mb 1024        # bigger
 *
 * A Windows build can take part under Wine: `--host-cmd "wine reptile.exe"
 * --host-windows` passes it Windows paths (Z:\...). Linux only (/proc).
 * Nothing but Node.js's standard library.
 */
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// --- options ----------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const quick = Boolean(flag('--quick', false));

/** `reptile/`, the directory above this script. */
const PRODUCT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const opts = {
  cmd: String(flag('--cmd', `node ${join(PRODUCT_DIR, 'node', 'src', 'index.js')}`)),
  hostCmd: flag('--host-cmd', null),
  peerCmd: flag('--peer-cmd', null),
  https: Boolean(flag('--https', false)),
  hostWindows: Boolean(flag('--host-windows', false)),
  peerWindows: Boolean(flag('--peer-windows', false)),
  cwd: PRODUCT_DIR,
  files: Number(flag('--files', quick ? 2000 : 20000)),
  perDir: Number(flag('--per-dir', 100)),
  liveFiles: Number(flag('--live-files', quick ? 300 : 2000)),
  modifyFiles: Number(flag('--modify-files', quick ? 100 : 500)),
  bigMb: Number(flag('--big-mb', quick ? 32 : 256)),
  idleSeconds: Number(flag('--idle', quick ? 3 : 10)),
  timeoutS: Number(flag('--timeout', 600)),
  workdir: flag('--workdir', null),
  out: flag('--out', null),
  only: flag('--only', null),
  keep: Boolean(flag('--keep', false)),
};

const CLK_TCK = 100;
/** A path as a Windows instance running under Wine must be given it. */
const winPath = (path) => `Z:${path.replaceAll('/', '\\')}`;
// The instances serve brand-new self-signed certificates; this process only
// ever talks to the throw-away instances it started itself.
if (opts.https) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- small helpers ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function procStat(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  // fields[0] is field 3 (state); utime is field 14, stime field 15.
  return { cpuS: (Number(fields[11]) + Number(fields[12])) / CLK_TCK };
}

async function procMem(pid) {
  const raw = await readFile(`/proc/${pid}/status`, 'utf8');
  const kb = (key) => Number((raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
  return { rssKb: kb('VmRSS'), hwmKb: kb('VmHWM'), threads: kb('Threads') };
}

async function resetPeak(pid) {
  try {
    await writeFile(`/proc/${pid}/clear_refs`, '5');
    return true;
  } catch {
    return false;
  }
}

// --- instances ----------------------------------------------------------------

async function startInstance(name, extraArgs = []) {
  const command = (name === 'host' && opts.hostCmd) || (name === 'peer' && opts.peerCmd) || opts.cmd;
  const [bin, ...base] = String(command).split(' ').filter(Boolean);
  // Port 0 and the startup banner: the instance picks a free port itself.
  const args = [...base, '--host', '127.0.0.1', '--port', '0', '--log-level', 'info', ...(opts.https ? ['--https'] : []), ...extraArgs];
  if (!extraArgs.some((a) => a.startsWith('--scan'))) args.push('--no-scan');
  const certDir = await mkdtemp(join(tmpdir(), `reptile-bench-cert-${name}-`));
  const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, REPTILE_CERT_DIR: certDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.once('exit', r));
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not report its port: ${output}`)), 20_000);
    createInterface({ input: child.stdout }).on('line', (line) => {
      output += `${line}\n`;
      const match = /control panel\s+\S+:(\d+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.once('exit', () => reject(new Error(`${name} exited: ${output}`)));
  });

  const inst = {
    name,
    port,
    pid: child.pid,
    child,
    base: `${opts.https ? 'https' : 'http'}://127.0.0.1:${port}`,
    output: () => output,
    async api(method, path, body) {
      const res = await fetch(`${inst.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      if (!res.ok) throw new Error(`${name} ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      return data;
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(6000).then(() => child.kill('SIGKILL'))]);
      }
      await rm(certDir, { recursive: true, force: true });
    },
  };

  const started = now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${name} exited: ${output}`);
    try {
      await inst.api('GET', '/api/ping');
      break;
    } catch {
      if (now() - started > 15000) throw new Error(`${name} did not answer: ${output}`);
      await sleep(50);
    }
  }
  inst.startupMs = now() - started;
  return inst;
}

// --- measurement --------------------------------------------------------------

/** Measure CPU and memory of `instances` while `fn` runs. */
async function measure(instances, fn) {
  const before = {};
  const samples = {};
  const peakResetOk = {};
  for (const inst of instances) {
    peakResetOk[inst.name] = await resetPeak(inst.pid);
    before[inst.name] = await procStat(inst.pid);
    samples[inst.name] = [];
  }
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const inst of instances) {
        try {
          samples[inst.name].push((await procMem(inst.pid)).rssKb);
        } catch {}
      }
      await sleep(100);
    }
  })();
  const t0 = now();
  const result = await fn();
  const wallMs = now() - t0;
  sampling = false;
  await sampler;

  const procs = {};
  for (const inst of instances) {
    const after = await procStat(inst.pid);
    const mem = await procMem(inst.pid);
    const s = samples[inst.name];
    const sampledPeak = s.length ? Math.max(...s) : mem.rssKb;
    const cpuS = after.cpuS - before[inst.name].cpuS;
    procs[inst.name] = {
      cpuS: round(cpuS, 2),
      cpuPct: round((cpuS / (wallMs / 1000)) * 100, 1),
      rssEndMb: round(mem.rssKb / 1024, 1),
      rssMeanMb: round((s.length ? s.reduce((a, b) => a + b, 0) / s.length : mem.rssKb) / 1024, 1),
      rssPeakMb: round(Math.max(peakResetOk[inst.name] ? mem.hwmKb : 0, sampledPeak) / 1024, 1),
      threads: mem.threads,
    };
  }
  return { wallMs: Math.round(wallMs), procs, ...(result || {}) };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// --- trees --------------------------------------------------------------------

const TMP_RE = /^\.reptile-[0-9a-f]+\.tmp$/;

/** Every path (relative), cheaply, without sizes. */
async function listPaths(root) {
  const out = [];
  const visit = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (TMP_RE.test(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        await visit(join(dir, e.name), rel);
      } else if (e.isFile()) out.push(rel);
    }
  };
  await visit(root, '');
  return out;
}

/** Paths, sizes and mtimes: what convergence means for the purpose of timing. */
async function signature(root) {
  const paths = (await listPaths(root)).sort();
  const hash = createHash('sha1');
  const BATCH = 256;
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    const stats = await Promise.all(chunk.map((p) => (p.endsWith('/') ? null : lstat(join(root, p)).catch(() => null))));
    chunk.forEach((p, j) => hash.update(`${p}\0${stats[j] ? `${stats[j].size}:${Math.round(stats[j].mtimeMs)}` : ''}\n`));
  }
  return { count: paths.length, digest: hash.digest('hex') };
}

/** Content check, outside of any timing. */
async function contentDigest(root) {
  const paths = (await listPaths(root)).sort();
  const hash = createHash('sha256');
  for (const p of paths) {
    hash.update(`${p}\n`);
    if (!p.endsWith('/')) {
      await new Promise((res, rej) => {
        createReadStream(join(root, p)).on('data', (d) => hash.update(d)).on('end', res).on('error', rej);
      });
    }
  }
  return { count: paths.length, digest: hash.digest('hex') };
}

/** Wait until both trees have the same paths, sizes and mtimes. */
async function waitConverged(a, b, { timeoutMs = opts.timeoutS * 1000 } = {}) {
  const started = now();
  for (;;) {
    const [la, lb] = await Promise.all([listPaths(a), listPaths(b)]);
    if (la.length === lb.length) {
      const [sa, sb] = await Promise.all([signature(a), signature(b)]);
      if (sa.digest === sb.digest) return { convergedMs: Math.round(now() - started), entries: sa.count };
    }
    if (now() - started > timeoutMs) throw new Error(`no convergence after ${timeoutMs} ms (${la.length} vs ${lb.length} entries)`);
    await sleep(100);
  }
}

async function verifyContent(a, b) {
  const [da, db] = await Promise.all([contentDigest(a), contentDigest(b)]);
  if (da.digest !== db.digest) throw new Error(`content differs (${da.count} vs ${db.count} entries)`);
  return true;
}

/** `count` small files (1-4 KiB of random bytes) in directories of `perDir`. */
async function makeSmallFiles(root, prefix, count, perDir = opts.perDir) {
  let bytes = 0;
  const jobs = [];
  for (let i = 0; i < count; i += 1) {
    const dir = join(root, prefix, `d${String(Math.floor(i / perDir)).padStart(4, '0')}`);
    const size = 1024 + Math.floor(Math.random() * 3072);
    bytes += size;
    jobs.push({ dir, file: join(dir, `f${String(i).padStart(6, '0')}.bin`), size });
  }
  const dirs = [...new Set(jobs.map((j) => j.dir))];
  await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));
  for (let i = 0; i < jobs.length; i += 64) {
    await Promise.all(jobs.slice(i, i + 64).map((j) => writeFile(j.file, randomBytes(j.size))));
  }
  return { files: count, dirs: dirs.length, mb: round(bytes / 1048576, 1) };
}

async function makeBigFile(file, mb) {
  await mkdir(dirname(file), { recursive: true });
  const chunk = randomBytes(1024 * 1024);
  await writeFile(file, '');
  for (let i = 0; i < mb; i += 1) {
    chunk.writeUInt32LE(i, 0);
    await appendFile(file, chunk);
  }
}

// --- scenarios ----------------------------------------------------------------

async function main() {
  const work = opts.workdir ? resolve(opts.workdir) : await mkdtemp(join(tmpdir(), 'reptile-bench-'));
  await mkdir(work, { recursive: true });
  const hostDir = join(work, 'host');
  const syncDir = join(work, 'peer', 'copy');
  await mkdir(hostDir, { recursive: true });
  await mkdir(dirname(syncDir), { recursive: true });

  const results = {
    meta: {
      date: new Date().toISOString(),
      cmd: opts.cmd,
      node: process.version,
      kernel: (await readFile('/proc/sys/kernel/osrelease', 'utf8')).trim(),
      cpu: ((await readFile('/proc/cpuinfo', 'utf8')).match(/^model name\s*:\s*(.*)$/m) || [])[1],
      options: opts,
    },
    scenarios: {},
  };
  const want = (name) => !opts.only || String(opts.only).split(',').includes(name);
  const record = (name, data) => {
    results.scenarios[name] = data;
    log(name, JSON.stringify(data));
  };

  const instances = [];
  try {
    // 1. Startup and idle, nothing hosted.
    const host = await startInstance('host');
    const peer = await startInstance('peer');
    instances.push(host, peer);
    record('startup', { hostMs: Math.round(host.startupMs), peerMs: Math.round(peer.startupMs) });
    await sleep(1000);
    record('idle', await measure([host, peer], () => sleep(opts.idleSeconds * 1000)));

    // 2. Idle with discovery on, worst case: every loopback /24 address refuses
    //    instantly, so every host gets the full port sweep.
    if (want('idle-scan')) {
      const scanner = await startInstance('scanner', ['--scan-hosts', '127.0.0.0/24']);
      await sleep(1000);
      record('idle-scan', await measure([scanner], () => sleep(Math.max(opts.idleSeconds, 10) * 1000)));
      await scanner.stop();
    }

    // 3. Hosting a big tree: walk + index + watcher.
    log(`generating ${opts.files} files…`);
    const gen = await makeSmallFiles(hostDir, 'tree', opts.files);
    record(
      'host-index',
      await measure([host], async () => {
        await host.api('POST', '/api/host', { path: opts.hostWindows ? winPath(hostDir) : hostDir, name: 'Bench', pin: '1234', excluded: [] });
        return { generated: gen };
      }),
    );
    await sleep(2000);

    // 4. Initial sync of the big tree into an empty directory.
    record(
      'initial-sync',
      await measure([host, peer], async () => {
        await peer.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: opts.peerWindows ? winPath(syncDir) : syncDir, pin: '1234' });
        const t0 = now();
        for (;;) {
          const state = (await peer.api('GET', '/api/state')).syncing?.state;
          if (state === 'live') break;
          if (state === 'error' || state === 'stopped') throw new Error(`sync ended in ${state}`);
          if (now() - t0 > opts.timeoutS * 1000) throw new Error('initial sync timed out');
          await sleep(100);
        }
        const liveMs = Math.round(now() - t0);
        const conv = await waitConverged(hostDir, syncDir);
        return { liveMs, ...conv, filesPerS: Math.round(opts.files / ((liveMs || 1) / 1000)) };
      }),
    );
    await verifyContent(hostDir, syncDir);
    // Let the peer's watcher start and finish its rescan.
    await sleep(5000);

    // 5. Idle while live, with the whole tree watched on both sides.
    record('live-idle', await measure([host, peer], () => sleep(opts.idleSeconds * 1000)));

    const liveCase = async (name, fn) => {
      if (!want(name)) return;
      record(
        name,
        await measure([host, peer], async () => {
          const t0 = now();
          const extra = await fn();
          const writeMs = Math.round(now() - t0);
          const conv = await waitConverged(hostDir, syncDir);
          return { writeMs, totalMs: writeMs + conv.convergedMs, ...conv, ...(extra || {}) };
        }),
      );
      await verifyContent(hostDir, syncDir);
      await sleep(2500);
    };

    // 6-10. Live changes in both directions.
    await liveCase('live-create-host', () => makeSmallFiles(hostDir, 'new-h', opts.liveFiles));
    await liveCase('live-create-peer', () => makeSmallFiles(syncDir, 'new-p', opts.liveFiles));
    await liveCase('live-modify-host', async () => {
      const files = (await listPaths(join(hostDir, 'tree'))).filter((p) => !p.endsWith('/')).slice(0, opts.modifyFiles);
      for (let i = 0; i < files.length; i += 64) {
        await Promise.all(files.slice(i, i + 64).map((p) => writeFile(join(hostDir, 'tree', p), randomBytes(2048))));
      }
      return { modified: files.length };
    });
    await liveCase('live-big-file-host', async () => {
      await makeBigFile(join(hostDir, 'big', 'blob.bin'), opts.bigMb);
      return { mb: opts.bigMb };
    });
    await liveCase('live-delete-tree-host', async () => {
      await rm(join(hostDir, 'tree'), { recursive: true, force: true });
      return { deletedFiles: opts.files };
    });

    // Throughput figure for the big file.
    const big = results.scenarios['live-big-file-host'];
    if (big) big.mbPerS = round(opts.bigMb / (big.totalMs / 1000), 1);
  } finally {
    for (const inst of instances) await inst.stop().catch(() => {});
    if (!opts.keep && !opts.workdir) await rm(work, { recursive: true, force: true });
  }

  printSummary(results);
  if (opts.out) {
    await writeFile(resolve(String(opts.out)), JSON.stringify(results, null, 2));
    log(`results written to ${opts.out}`);
  }
}

function printSummary({ scenarios }) {
  const rows = [['scenario', 'wall s', 'conv s', 'host cpu s', 'peer cpu s', 'host rss mean/peak MB', 'peer rss mean/peak MB']];
  for (const [name, s] of Object.entries(scenarios)) {
    if (!s.procs) continue;
    const h = s.procs.host || s.procs.scanner;
    const q = s.procs.peer;
    rows.push([
      name,
      (s.wallMs / 1000).toFixed(2),
      s.totalMs !== undefined ? (s.totalMs / 1000).toFixed(2) : s.liveMs !== undefined ? (s.liveMs / 1000).toFixed(2) : '-',
      h ? `${h.cpuS} (${h.cpuPct}%)` : '-',
      q ? `${q.cpuS} (${q.cpuPct}%)` : '-',
      h ? `${h.rssMeanMb} / ${h.rssPeakMb}` : '-',
      q ? `${q.rssMeanMb} / ${q.rssPeakMb}` : '-',
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  '));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
