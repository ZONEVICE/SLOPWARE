/**
 * CodeMirror grammars, one lazy loader per language id of core/languages.js.
 * Each `import()` becomes its own chunk, so a language costs nothing until a
 * file in it is opened. Modern grammars come from the @codemirror/lang-*
 * packages; the rest are CodeMirror 5 modes through StreamLanguage.
 */

const legacy = (load) => async () => {
  const [{ StreamLanguage }, mode] = await Promise.all([import('@codemirror/language'), load()]);
  return StreamLanguage.define(mode);
};

export const LOADERS = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-sass')).sass(),
  sass: async () => (await import('@codemirror/lang-sass')).sass({ indented: true }),
  less: async () => (await import('@codemirror/lang-less')).less(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  shell: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  powershell: legacy(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  toml: legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  ini: legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties),
  dockerfile: legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
  lua: legacy(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua),
  ruby: legacy(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  perl: legacy(async () => (await import('@codemirror/legacy-modes/mode/perl')).perl),
  r: legacy(async () => (await import('@codemirror/legacy-modes/mode/r')).r),
  swift: legacy(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  kotlin: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  csharp: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
  scala: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).scala),
  dart: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).dart),
  haskell: legacy(async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell),
  clojure: legacy(async () => (await import('@codemirror/legacy-modes/mode/clojure')).clojure),
  erlang: legacy(async () => (await import('@codemirror/legacy-modes/mode/erlang')).erlang),
  julia: legacy(async () => (await import('@codemirror/legacy-modes/mode/julia')).julia),
  diff: legacy(async () => (await import('@codemirror/legacy-modes/mode/diff')).diff),
  cmake: legacy(async () => (await import('@codemirror/legacy-modes/mode/cmake')).cmake),
  nginx: legacy(async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx),
  protobuf: legacy(async () => (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  wast: legacy(async () => (await import('@codemirror/legacy-modes/mode/wast')).wast),
};

const cache = new Map();

/** Resolves with the extension for a language id, or null for plain text. */
export function loadLanguage(id) {
  const loader = LOADERS[id];
  if (!loader) return Promise.resolve(null);
  if (!cache.has(id)) cache.set(id, loader().catch((err) => {
    cache.delete(id);
    console.error(`[codemirror] language ${id} failed to load`, err);
    return null;
  }));
  return cache.get(id);
}
