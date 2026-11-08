/**
 * Entry point of the separate xterm.js bundle (assets/app/xterm/), fetched
 * the first time a terminal is opened.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export { FitAddon, Terminal };
