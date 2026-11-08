/**
 * Entry point of the separate Monaco bundle (built by web/build.mjs into
 * assets/app/monaco/). It is fetched only when the user picks Monaco.
 *
 * The editor API, every editor contribution (find, folding, multi-cursor,
 * suggestions...) and every language: Monarch grammars load lazily per
 * language, and CSS/HTML/JSON/TypeScript get their language services
 * through web workers served from assets/app/monaco/workers/.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';
import 'monaco-editor/languages/register.all.js';

export default monaco;
