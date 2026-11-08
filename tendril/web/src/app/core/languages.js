/**
 * The language catalog: which language a file is, how each editor names it,
 * and how its icon looks. Editors load the grammar lazily (CodeMirror per
 * language chunk, Monaco by id); this module stays tiny and editor-agnostic.
 *
 * Adding a language: add one entry here and, for CodeMirror, one loader in
 * editors/codemirror/languages.js under the same `id`.
 */
import { basename, extname } from './paths.js';

/**
 * id: Tendril's id (also the CodeMirror loader key)
 * monaco: Monaco's language id
 * ext: extensions; names: exact file names (lower case)
 * color: CSS variable for the file icon; icon: icon name (default "file-code")
 */
export const LANGUAGES = [
  { id: 'javascript', name: 'JavaScript', monaco: 'javascript', ext: ['js', 'mjs', 'cjs'], color: '--syn-type' },
  { id: 'jsx', name: 'JavaScript JSX', monaco: 'javascript', ext: ['jsx'], color: '--syn-type' },
  { id: 'typescript', name: 'TypeScript', monaco: 'typescript', ext: ['ts', 'mts', 'cts'], color: '--syn-function' },
  { id: 'tsx', name: 'TypeScript JSX', monaco: 'typescript', ext: ['tsx'], color: '--syn-function' },
  { id: 'json', name: 'JSON', monaco: 'json', ext: ['json', 'jsonc', 'json5', 'webmanifest', 'map'], names: ['.prettierrc', '.eslintrc', '.babelrc'], color: '--syn-number', icon: 'json' },
  { id: 'html', name: 'HTML', monaco: 'html', ext: ['html', 'htm', 'xhtml', 'vue', 'svelte'], color: '--syn-tag' },
  { id: 'css', name: 'CSS', monaco: 'css', ext: ['css'], color: '--syn-keyword' },
  { id: 'scss', name: 'SCSS', monaco: 'scss', ext: ['scss'], color: '--syn-keyword' },
  { id: 'sass', name: 'Sass', monaco: 'scss', ext: ['sass'], color: '--syn-keyword' },
  { id: 'less', name: 'Less', monaco: 'less', ext: ['less'], color: '--syn-keyword' },
  { id: 'markdown', name: 'Markdown', monaco: 'markdown', ext: ['md', 'markdown', 'mdx', 'mkd'], color: '--syn-link', icon: 'markdown' },
  { id: 'python', name: 'Python', monaco: 'python', ext: ['py', 'pyw', 'pyi'], color: '--syn-function' },
  { id: 'rust', name: 'Rust', monaco: 'rust', ext: ['rs'], color: '--syn-number' },
  { id: 'go', name: 'Go', monaco: 'go', ext: ['go'], names: ['go.mod', 'go.sum'], color: '--syn-operator' },
  { id: 'java', name: 'Java', monaco: 'java', ext: ['java'], color: '--syn-property' },
  { id: 'kotlin', name: 'Kotlin', monaco: 'kotlin', ext: ['kt', 'kts'], color: '--syn-keyword' },
  { id: 'scala', name: 'Scala', monaco: 'scala', ext: ['scala', 'sc'], color: '--syn-property' },
  { id: 'c', name: 'C', monaco: 'c', ext: ['c', 'h'], color: '--syn-function' },
  { id: 'cpp', name: 'C++', monaco: 'cpp', ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'], color: '--syn-function' },
  { id: 'csharp', name: 'C#', monaco: 'csharp', ext: ['cs', 'csx'], color: '--syn-string' },
  { id: 'php', name: 'PHP', monaco: 'php', ext: ['php', 'phtml'], color: '--syn-keyword' },
  { id: 'ruby', name: 'Ruby', monaco: 'ruby', ext: ['rb', 'rake', 'gemspec'], names: ['gemfile', 'rakefile'], color: '--syn-property' },
  { id: 'swift', name: 'Swift', monaco: 'swift', ext: ['swift'], color: '--syn-number' },
  { id: 'dart', name: 'Dart', monaco: 'dart', ext: ['dart'], color: '--syn-function' },
  { id: 'lua', name: 'Lua', monaco: 'lua', ext: ['lua'], color: '--syn-function' },
  { id: 'perl', name: 'Perl', monaco: 'perl', ext: ['pl', 'pm'], color: '--syn-function' },
  { id: 'r', name: 'R', monaco: 'r', ext: ['r'], color: '--syn-function' },
  { id: 'julia', name: 'Julia', monaco: 'julia', ext: ['jl'], color: '--syn-keyword' },
  { id: 'haskell', name: 'Haskell', monaco: 'plaintext', ext: ['hs', 'lhs'], color: '--syn-keyword' },
  { id: 'clojure', name: 'Clojure', monaco: 'clojure', ext: ['clj', 'cljs', 'cljc', 'edn'], color: '--syn-string' },
  { id: 'erlang', name: 'Erlang', monaco: 'plaintext', ext: ['erl', 'hrl'], color: '--syn-property' },
  { id: 'elixir', name: 'Elixir', monaco: 'elixir', ext: ['ex', 'exs'], color: '--syn-keyword' },
  { id: 'shell', name: 'Shell', monaco: 'shell', ext: ['sh', 'bash', 'zsh', 'fish', 'ksh'], names: ['.bashrc', '.zshrc', '.profile', '.bash_profile', '.bash_aliases'], color: '--syn-string', icon: 'terminal' },
  { id: 'powershell', name: 'PowerShell', monaco: 'powershell', ext: ['ps1', 'psm1', 'psd1'], color: '--syn-function', icon: 'terminal' },
  { id: 'bat', name: 'Batch', monaco: 'bat', ext: ['bat', 'cmd'], color: '--syn-meta', icon: 'terminal' },
  { id: 'sql', name: 'SQL', monaco: 'sql', ext: ['sql'], color: '--syn-type' },
  { id: 'yaml', name: 'YAML', monaco: 'yaml', ext: ['yml', 'yaml'], color: '--syn-attr' },
  { id: 'toml', name: 'TOML', monaco: 'ini', ext: ['toml'], names: ['cargo.lock'], color: '--syn-number' },
  { id: 'ini', name: 'INI', monaco: 'ini', ext: ['ini', 'cfg', 'conf', 'properties', 'env'], names: ['.env', '.editorconfig', '.gitconfig', '.npmrc'], color: '--syn-meta' },
  { id: 'xml', name: 'XML', monaco: 'xml', ext: ['xml', 'svg', 'xsd', 'xsl', 'xslt', 'plist', 'csproj', 'fsproj', 'vbproj', 'props', 'targets', 'resx', 'xaml'], color: '--syn-tag' },
  { id: 'dockerfile', name: 'Dockerfile', monaco: 'dockerfile', ext: ['dockerfile'], names: ['dockerfile', 'containerfile'], color: '--syn-function' },
  { id: 'makefile', name: 'Makefile', monaco: 'plaintext', ext: ['mk', 'mak'], names: ['makefile', 'gnumakefile'], color: '--syn-meta' },
  { id: 'cmake', name: 'CMake', monaco: 'plaintext', ext: ['cmake'], names: ['cmakelists.txt'], color: '--syn-meta' },
  { id: 'diff', name: 'Diff', monaco: 'plaintext', ext: ['diff', 'patch'], color: '--syn-meta' },
  { id: 'nginx', name: 'Nginx', monaco: 'plaintext', ext: [], names: ['nginx.conf'], color: '--syn-function' },
  { id: 'protobuf', name: 'Protocol Buffers', monaco: 'protobuf', ext: ['proto'], color: '--syn-function' },
  { id: 'graphql', name: 'GraphQL', monaco: 'graphql', ext: ['graphql', 'gql'], color: '--syn-keyword' },
  { id: 'wast', name: 'WebAssembly Text', monaco: 'plaintext', ext: ['wat', 'wast'], color: '--syn-meta' },
  { id: 'gitignore', name: 'Ignore file', monaco: 'plaintext', ext: [], names: ['.gitignore', '.dockerignore', '.npmignore', '.stignore', '.gitattributes'], color: '--syn-comment' },
  { id: 'plaintext', name: 'Plain Text', monaco: 'plaintext', ext: ['txt', 'text', 'log', 'csv', 'tsv'], names: ['license', 'licence', 'readme', 'authors', 'changelog'], color: '--fg-muted', icon: 'file-text' },
];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
const byExt = new Map();
const byName = new Map();
for (const lang of LANGUAGES) {
  for (const e of lang.ext) if (!byExt.has(e)) byExt.set(e, lang);
  for (const n of lang.names || []) byName.set(n, lang);
}

/** Viewer kinds decided by extension (must agree with the server's mime.rs). */
const VIEWERS = {
  image: ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico'],
  video: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'],
  pdf: ['pdf'],
};
const ARCHIVES = ['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst', 'jar', 'war', 'deb', 'rpm', 'iso', 'dmg'];
const BINARIES = ['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'class', 'pyc', 'wasm', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'db', 'sqlite'];

/** The language entry for a path (plaintext when unknown). */
export function languageFor(path) {
  const name = basename(path).toLowerCase();
  return byName.get(name) || byExt.get(extname(path)) || (name.startsWith('dockerfile') ? byId.get('dockerfile') : null) || byId.get('plaintext');
}

export function languageById(id) {
  return byId.get(id) || byId.get('plaintext');
}

/** "image" | "video" | "audio" | "pdf" | null */
export function viewerFor(path) {
  const ext = extname(path);
  for (const [kind, exts] of Object.entries(VIEWERS)) if (exts.includes(ext)) return kind;
  return null;
}

/** Icon name and color variable for a file in the tree and tabs. */
export function fileIcon(path) {
  const ext = extname(path);
  const viewer = viewerFor(path);
  if (viewer === 'image') return { icon: 'image', color: '--syn-string' };
  if (viewer === 'video') return { icon: 'video', color: '--syn-keyword' };
  if (viewer === 'audio') return { icon: 'audio', color: '--syn-keyword' };
  if (viewer === 'pdf') return { icon: 'pdf', color: '--danger' };
  if (ext === 'svg') return { icon: 'image', color: '--syn-tag' };
  if (ARCHIVES.includes(ext)) return { icon: 'archive', color: '--syn-meta' };
  if (BINARIES.includes(ext)) return { icon: 'file-binary', color: '--fg-subtle' };
  const lang = languageFor(path);
  return { icon: lang.icon || (lang.id === 'plaintext' ? 'file-text' : 'file-code'), color: lang.color };
}
