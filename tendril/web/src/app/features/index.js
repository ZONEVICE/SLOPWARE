/**
 * Features of the workbench, registered in this order.
 *
 * **Extension point.** A feature is a module exporting `register(app)`
 * that adds commands (`app.commands.register`), menu entries
 * (`app.menus.add`), toolbar buttons (`app.toolbar.add`), status bar items
 * (`app.statusbar.add`), sidebar views (`app.sidebar.addView`) and bus
 * listeners. Adding a feature is one new file plus one line here; removing
 * it is deleting that line.
 */
import * as autosave from './autosave.js';
import * as edit from './edit.js';
import * as file from './file.js';
import * as find from './find.js';
import * as git from './git.js';
import * as help from './help.js';
import * as keybar from './keybar.js';
import * as markdown from './markdown.js';
import * as preferences from './preferences.js';
import * as quickopen from './quickopen.js';
import * as selection from './selection.js';
import * as session from './session.js';
import * as split from './split.js';
import * as status from './status.js';
import * as terminal from './terminal.js';
import * as tools from './tools.js';
import * as view from './view.js';

export const FEATURES = [file, edit, selection, view, split, markdown, find, quickopen, terminal, git, tools, preferences, help, status, autosave, keybar, session];
