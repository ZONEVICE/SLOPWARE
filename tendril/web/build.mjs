#!/usr/bin/env node
/**
 * Front-end build: bundles web/src with esbuild into web/.out (readable, for
 * inspection) and gzips every output file into web/dist, which build.rs
 * embeds into the Rust binary. Nothing here runs at run time.
 *
 * Bundles, each loaded only when needed:
 *
 *   assets/public/boot.js      classic script in <head>: applies the saved theme before first paint
 *   assets/public/login.js     the login page
 *   assets/public/*.css        themes (shared) and the login page styles
 *   assets/app/main.js         the workbench (ES module) + code-split chunks in assets/app/chunks/
 *                              (CodeMirror and each of its languages are separate chunks)
 *   assets/app/app.css         workbench styles
 *   assets/app/monaco/         Monaco Editor + its web workers, fetched only when Monaco is chosen
 *   assets/app/xterm/          xterm.js, fetched only when a terminal is opened
 *
 * Usage: node web/build.mjs [--dev]   (--dev skips minification)
 */
import * as esbuild from 'esbuild';
import { gzipSync, constants as zlib } from 'node:zlib';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const out = join(root, '.out');
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Options shared by every bundle. */
const common = {
  bundle: true,
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  target: ['es2022', 'chrome100', 'firefox100', 'safari15.4'],
  logLevel: 'warning',
  charset: 'utf8',
};

const monaco = join(root, 'node_modules', 'monaco-editor', 'esm', 'vs');

await Promise.all([
  // Theme bootstrap: a classic (non-module) script so it runs before paint.
  esbuild.build({
    ...common,
    entryPoints: { 'assets/public/boot': join(src, 'public', 'boot.js') },
    format: 'iife',
    outdir: out,
  }),
  // The login page and the shared theme stylesheet.
  esbuild.build({
    ...common,
    entryPoints: {
      'assets/public/login': join(src, 'public', 'login.js'),
      'assets/public/login-style': join(src, 'public', 'login.css'),
      'assets/public/themes': join(src, 'styles', 'themes.css'),
    },
    format: 'esm',
    outdir: out,
  }),
  // The workbench, with code splitting for lazily loaded parts.
  esbuild.build({
    ...common,
    entryPoints: {
      'assets/app/main': join(src, 'app', 'main.js'),
      'assets/app/app': join(src, 'styles', 'app.css'),
    },
    format: 'esm',
    splitting: true,
    chunkNames: 'assets/app/chunks/[name]-[hash]',
    outdir: out,
    // Monaco and xterm are separate bundles loaded by URL at run time.
    external: ['/assets/*'],
  }),
  // Monaco Editor, built on its own and loaded only when selected.
  esbuild.build({
    ...common,
    entryPoints: { 'assets/app/monaco/monaco': join(src, 'app', 'editors', 'monaco', 'bundle.js') },
    format: 'esm',
    splitting: true,
    chunkNames: 'assets/app/monaco/chunks/[name]-[hash]',
    assetNames: 'assets/app/monaco/chunks/[name]-[hash]',
    loader: { '.ttf': 'file' },
    outdir: out,
  }),
  // Monaco's web workers: classic scripts served from the binary, never a CDN.
  esbuild.build({
    ...common,
    entryPoints: {
      'assets/app/monaco/workers/editor': join(monaco, 'editor', 'editor.worker.js'),
      'assets/app/monaco/workers/json': join(monaco, 'language', 'json', 'json.worker.js'),
      'assets/app/monaco/workers/css': join(monaco, 'language', 'css', 'css.worker.js'),
      'assets/app/monaco/workers/html': join(monaco, 'language', 'html', 'html.worker.js'),
      'assets/app/monaco/workers/ts': join(monaco, 'language', 'typescript', 'ts.worker.js'),
    },
    format: 'iife',
    outdir: out,
  }),
  // xterm.js for the integrated terminal.
  esbuild.build({
    ...common,
    entryPoints: { 'assets/app/xterm/xterm': join(src, 'app', 'terminal', 'bundle.js') },
    format: 'esm',
    outdir: out,
  }),
]);

// Static files: the two HTML pages and the icon.
for (const file of ['index.html', 'login.html', 'favicon.svg']) {
  cpSync(join(src, file), join(out, file));
}

/** Every file below `dir`, recursively. */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Gzip everything for embedding; report sizes.
let raw = 0;
let packed = 0;
const rows = [];
for (const file of walk(out)) {
  const rel = relative(out, file);
  const data = readFileSync(file);
  const gz = gzipSync(data, { level: zlib.Z_BEST_COMPRESSION });
  const target = join(dist, `${rel}.gz`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, gz);
  raw += data.length;
  packed += gz.length;
  rows.push([rel, data.length, gz.length]);
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`.padStart(12);
const groups = new Map();
for (const [rel, size, gz] of rows) {
  const key = rel.includes('/monaco/') ? 'monaco' : rel.includes('/xterm/') ? 'xterm' : rel.includes('/chunks/') ? 'app chunks' : rel;
  const g = groups.get(key) ?? [0, 0, 0];
  groups.set(key, [g[0] + 1, g[1] + size, g[2] + gz]);
}
console.log('\nFront end built:');
for (const [key, [count, size, gz]] of [...groups].sort()) {
  console.log(`  ${key.padEnd(34)} ${String(count).padStart(4)} file(s) ${kib(size)} -> ${kib(gz)} gzip`);
}
console.log(`  ${'total'.padEnd(34)} ${String(rows.length).padStart(4)} file(s) ${kib(raw)} -> ${kib(packed)} gzip\n`);
