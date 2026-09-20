/** Optional browser integration checks using Node's built-in WebSocket and CDP.
 * Run only against a disposable Frisbee data directory and Chromium profile.
 * The application itself does not use Node or browser automation libraries.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.argv[2] || process.env.FRISBEE_TEST_URL || 'http://127.0.0.1:8765';
const debug = process.env.FRISBEE_DEBUG_URL || 'http://127.0.0.1:9229';
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'frisbee-browser-'));
const pages = await (await fetch(`${debug}/json/list`)).json();
const page = pages.find(item => item.type === 'page');
if (!page) throw new Error('Start Chromium with a page and remote debugging first.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, {once: true});
  ws.addEventListener('error', reject, {once: true});
});
let nextId = 0;
const pending = new Map(), browserErrors = [], expectedDialogs = [], mediaRequests = [];
// A two-second, solid-blue VP8/WebM fixture. Keeping these synthetic bytes here
// tests real decoding without adding a media tool or another runtime asset.
const videoFixture = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAMiEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEiTbuMU6uEHFO7a1OsggMM7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNTguNzYuMTAwV0GNTGF2ZjU4Ljc2LjEwMESJiECfQAAAAAAAFlSua8WuAQAAAAAAADzXgQFzxYhwWd8jEIWc35yBACK1nIN1bmSGhVZfVlA4g4EBI+ODhAvrwgDgAQAAAAAAAAmwgaC6gVqagQISVMNnQJpzcwEAAAAAAAAnY8CAZ8gBAAAAAAAAGkWjh0VOQ09ERVJEh41MYXZmNTguNzYuMTAwc3MBAAAAAAAAX2PAi2PFiHBZ3yMQhZzfZ8gBAAAAAAAAIkWjh0VOQ09ERVJEh5VMYXZjNTguMTM0LjEwMCBsaWJ2cHhnyKJFo4hEVVJBVElPTkSHlDAwOjAwOjAyLjAwMDAwMDAwMAAAH0O2dUFE54EAo9aBAACA8AUAnQEqoABaAABHCIWFiIWEiAICAnWqA/gCBpoT4Iaqk13EOqpNdxDqqTXcQ6qk13EOqpNdxBgA/v9NEv/8WFfxYV/FhX/xYV/8/M7txfzmAKOYgQDIABECAAEQEAAYABhYL/QACICBAAAAo5iBAZAAEQIAARAQABgAGFgv9AAIgIEAAACjmIECWAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQMgABECAAEQEAAYABhYL/QACICBAAAAo5iBA+gAEQIAARAQABgAGFgv9AAIgIEAAACjmIEEsAARAgABEBAAGAAYWC/0AAiAgQAAAKOXgQV4APEBAAEQEBRgAGFgv9AAIgIEAACjmIEGQAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQcIABECAAEQEAAYABhYL/QACICBAAAAHFO7a5G7j7OBALeK94EB8YIBwvCBAw==';
ws.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.id) {
    const promise = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) promise.reject(new Error(JSON.stringify(data.error)));
    else promise.resolve(data.result);
  }
  if (data.method === 'Runtime.exceptionThrown') browserErrors.push(data.params.exceptionDetails);
  if (data.method === 'Network.requestWillBeSent' && new URL(data.params.request.url).pathname === '/api/preview') mediaRequests.push(data.params.request.url);
  if (data.method === 'Page.javascriptDialogOpening') {
    const response = expectedDialogs.shift();
    if (!response) browserErrors.push({unexpectedDialog: data.params});
    send('Page.handleJavaScriptDialog', response || {accept: false}).catch(error => browserErrors.push(String(error)));
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(expression, timeout = 15000) {
  const started = Date.now();
  while (true) {
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      // A navigation briefly invalidates the old JavaScript execution context.
      if (!/navigated|context was destroyed|Cannot find context/.test(String(error))) throw error;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out: ${expression}\n` + await evaluate('document.body.innerText'));
    }
    await delay(80);
  }
}
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
};
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const fill = (selector, value) => evaluate(`(() => {const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles: true}));})()`);
const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
const rowExpression = name => `[...document.querySelectorAll('#file-list tr')].find(row => [...row.querySelectorAll('button')].some(button => button.textContent.trim() === ${JSON.stringify(name)}))`;
const entryExists = name => `Boolean(${rowExpression(name)})`;
const entryAction = async (name, label) => {
  await waitFor(`!document.querySelector('#directory-view').hidden && !document.querySelector('#refresh-directory').disabled && ${entryExists(name)}`);
  return evaluate(`(() => {const row = ${rowExpression(name)}; if (!row) throw Error('Missing entry'); const button = [...row.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw Error('Missing action'); button.click();})()`);
};
const openEntry = name => entryAction(name, name);
const selectEntry = async name => {
  await waitFor(`!document.querySelector('#directory-view').hidden && !document.querySelector('#refresh-directory').disabled && ${entryExists(name)}`);
  return evaluate(`${rowExpression(name)}.querySelector('input[type=checkbox]').click()`);
};
const screenshot = async label => fs.writeFile(path.join(artifacts, `${label}.png`), Buffer.from((await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false})).data, 'base64'));

async function directoryFeatureChecks(folder) {
  await waitFor(`!document.querySelector('#refresh-directory').disabled`);
  check(await evaluate(`!document.querySelector('#show-previews').checked && document.querySelector('#hide-hidden-folders').checked`), 'Media previews start off and hidden folders start hidden');
  check(await evaluate(`document.querySelectorAll('#file-list img, #file-list video').length === 0`) && mediaRequests.length === 0, 'Listing files does not request media while previews are off');
  expectedDialogs.push({accept: true, promptText: '.hidden-folder'});
  await click('#new-directory');
  await waitFor(`!document.querySelector('#refresh-directory').disabled && document.querySelector('#notice').textContent.includes('Created folder .hidden-folder')`);
  check(!await evaluate(entryExists('.hidden-folder')) && await evaluate(entryExists('.visible-file.txt')), 'Hidden-folder filtering leaves dotfiles visible');
  await click('#hide-hidden-folders');
  await waitFor(entryExists('.hidden-folder'));
  await selectEntry('.hidden-folder');
  await click('#hide-hidden-folders');
  check(!await evaluate(entryExists('.hidden-folder')) && await evaluate(`document.querySelector('#selection-count').textContent`) === '0 selected', 'Hiding a selected folder removes it from the selection');

  await fill('#directory-search', 'FoLdEr');
  check(await evaluate(entryExists('folder-upload')) && !await evaluate(entryExists('draft.txt')), 'Live directory search matches folder names without case sensitivity');
  await click('#hide-hidden-folders');
  check(await evaluate(entryExists('.hidden-folder')), 'Search and the hidden-folder toggle combine');
  await click('#hide-hidden-folders');
  await openEntry('folder-upload');
  await waitFor(`!document.querySelector('#refresh-directory').disabled && document.querySelector('#directory-search').value === '' && ${entryExists('nested')}`);
  check(true, 'Entering a different directory clears its search');
  await evaluate(`[...document.querySelectorAll('#breadcrumbs button')].find(button => button.textContent === ${JSON.stringify(folder)}).click()`);
  await waitFor(`!document.querySelector('#refresh-directory').disabled && ${entryExists('draft.txt')}`);
  check(await evaluate(`document.querySelector('#directory-search').value === ''`), 'Returning from a different directory keeps the search cleared');
  await click('#select-all');
  await fill('#directory-search', 'PiXeL');
  check(await evaluate(`document.querySelectorAll('#file-list tr').length === 1 && document.querySelector('#selection-count').textContent === '1 selected' && document.querySelector('#select-all').checked`), 'Live file search prunes nonmatching selections and selects only visible entries');
  await click('#select-all');
  await click('#refresh-directory');
  await waitFor(`!document.querySelector('#refresh-directory').disabled`);
  check(await evaluate(`document.querySelector('#directory-search').value === 'PiXeL'`) && await evaluate(entryExists('pixel.png')), 'Refreshing the current directory preserves the search');
  await openEntry('pixel.png');
  await waitFor(`document.querySelector('#preview-image').naturalWidth === 1`);
  await click('#back-to-directory');
  await waitFor(`!document.querySelector('#directory-view').hidden && !document.querySelector('#refresh-directory').disabled`);
  check(await evaluate(`document.querySelector('#directory-search').value === 'PiXeL' && document.querySelectorAll('#file-list tr').length === 1`), 'Opening an image and returning preserves the current search');
  await click('#notepad-tab');
  await click('#workspace-tab');
  check(await evaluate(`document.querySelector('#directory-search').value === 'PiXeL'`), 'Notepad visits preserve directory search');
  await fill('#directory-search', 'no matching entry');
  check(await evaluate(`document.querySelectorAll('#file-list tr').length === 0 && document.querySelector('#select-all').disabled && document.querySelector('#delete-selection').disabled`), 'An empty search result cannot select or delete invisible entries');
  await fill('#directory-search', '');
  await click('#show-previews');
  await waitFor(`document.querySelector('#file-list img')?.naturalWidth === 1 && document.querySelector('#file-list video')?.readyState >= 2`);
  check(await evaluate(`document.querySelector('#file-list video').muted && document.querySelector('#file-list video').paused && document.querySelector('#file-list video').videoWidth === 160`), 'Image and video thumbnails decode without autoplay or sound');
  await screenshot('desktop-media-thumbnails');
  for (const [label, width, height] of [['tablet-media', 820, 1180], ['mobile-media', 320, 740]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: true});
    check(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${label} list and search fit the viewport`);
    await screenshot(label);
  }
  await send('Emulation.setDeviceMetricsOverride', {width: 1365, height: 950, deviceScaleFactor: 1, mobile: false});
  await click('#show-previews');
  check(await evaluate(`document.querySelectorAll('#file-list img[src], #file-list video[src]').length === 0`), 'Turning thumbnails off releases their media sources');

  await fill('#directory-search', 'MOVIE');
  await openEntry('movie.webm');
  await waitFor(`!document.querySelector('#video-preview').hidden && document.querySelector('#preview-video').readyState >= 2`);
  check(await evaluate(`document.querySelector('#preview-video').controls && document.querySelector('#preview-video').videoWidth === 160 && document.querySelector('#binary-preview').hidden`), 'Opening a video displays the native player instead of the binary banner');
  const play = await send('Runtime.evaluate', {expression: `document.querySelector('#preview-video').play()`, userGesture: true, awaitPromise: true});
  check(!play.exceptionDetails, 'Native video playback starts successfully');
  await waitFor(`document.querySelector('#preview-video').currentTime > 0.05 && !document.querySelector('#preview-video').paused`);
  await evaluate(`document.querySelector('#preview-video').currentTime = 1`);
  await waitFor(`!document.querySelector('#preview-video').seeking && document.querySelector('#preview-video').currentTime >= 1`);
  check(true, 'Native video seeking works over the preview endpoint');
  await screenshot('video-player');
  await click('#notepad-tab');
  check(await evaluate(`document.querySelector('#preview-video').paused`), 'Notepad navigation pauses video playback');
  await click('#workspace-tab');
  await click('#back-to-directory');
  await waitFor(`!document.querySelector('#directory-view').hidden && !document.querySelector('#refresh-directory').disabled`);
  check(await evaluate(`document.querySelector('#directory-search').value === 'MOVIE' && document.querySelector('#preview-video').paused && !document.querySelector('#preview-video').hasAttribute('src')`), 'Returning from video retains the search and releases playback');
  await fill('#directory-search', '');
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Storage.clearDataForOrigin', {origin: base, storageTypes: 'local_storage'});
  await send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: artifacts});
  await send('Emulation.setDeviceMetricsOverride', {width: 1365, height: 950, deviceScaleFactor: 1, mobile: false});
  await send('Page.navigate', {url: base});
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#open-workspace')`);
  await waitFor(`document.querySelector('#theme-toggle').textContent.includes('Light')`);
  check(await evaluate(`document.documentElement.dataset.theme === 'dark'`), 'Dark theme is the default');
  check(await evaluate(`!document.querySelector('#workspace-form').hidden`), 'Workspace chooser appears before selection');
  await screenshot('desktop-chooser');

  const suffix = Date.now().toString(36);
  const noteName = `browser-note-${suffix}`;
  await click('#notepad-tab');
  await waitFor(`!document.querySelector('#notepad-view').hidden`);
  await fill('#note-name', noteName);
  await fill('#note-editor', 'A note created before opening a workspace.');
  await submit('#note-form');
  await waitFor(`document.querySelector('#note-list').textContent.includes(${JSON.stringify(noteName)})`);
  await fill('#note-editor', 'Edited note with Unicode: café.');
  await submit('#note-form');
  await waitFor(`document.querySelector('#note-edit-status').textContent === 'Saved'`);
  check(await evaluate(`(async () => (await (await fetch('/api/notes?name=' + encodeURIComponent(${JSON.stringify(noteName)}))).json()).content)()`) === 'Edited note with Unicode: café.', 'Notepad creates and edits notes before workspace selection');
  await click('#workspace-tab');
  await submit('#workspace-form');
  await waitFor(`!document.querySelector('#workspace-content').hidden && !document.querySelector('#new-directory').disabled`);
  const folder = `browser-files-${suffix}`;
  expectedDialogs.push({accept: true, promptText: folder});
  await click('#new-directory');
  await waitFor(entryExists(folder));
  await openEntry(folder);
  await waitFor(`document.querySelector('#breadcrumbs').textContent.includes(${JSON.stringify(folder)}) && !document.querySelector('#new-directory').disabled`);

  // Set a real input FileList to exercise the same XHR path as a user upload.
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Original text'], 'draft.txt', {type: 'text/plain'}));
    transfer.items.add(new File(['Visible dotfile'], '.visible-file.txt', {type: 'text/plain'}));
    transfer.items.add(new File([new Uint8Array([77, 90, 0, 1, 2, 255])], 'program.exe', {type: 'application/octet-stream'}));
    const video = Uint8Array.from(atob(${JSON.stringify(videoFixture)}), character => character.charCodeAt(0));
    transfer.items.add(new File([video], 'movie.webm', {type: 'video/webm'}));
    const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII='), character => character.charCodeAt(0));
    transfer.items.add(new File([image], 'pixel.png', {type: 'image/png'}));
    document.querySelector('#files-input').files = transfer.files;
    document.querySelector('#files-input').dispatchEvent(new Event('change', {bubbles: true}));
  })()`);
  await waitFor(entryExists('pixel.png'));
  check(await evaluate(entryExists('draft.txt')) && await evaluate(entryExists('program.exe')), 'Multiple file upload publishes text, image, and binary');
  await waitFor(`!document.querySelector('#refresh-directory').disabled`);
  const folderUpload = path.join(artifacts, 'folder-upload');
  await fs.mkdir(path.join(folderUpload, 'nested'), {recursive: true});
  await fs.writeFile(path.join(folderUpload, 'nested', 'inside.txt'), 'A file inside an uploaded directory.');
  const documentNode = await send('DOM.getDocument');
  const folderInput = await send('DOM.querySelector', {nodeId: documentNode.root.nodeId, selector: '#folder-input'});
  await send('DOM.setFileInputFiles', {nodeId: folderInput.nodeId, files: [folderUpload]});
  await waitFor(entryExists('folder-upload'));
  await openEntry('folder-upload');
  await openEntry('nested');
  await openEntry('inside.txt');
  await waitFor(`document.querySelector('#file-editor').value === 'A file inside an uploaded directory.'`);
  check(true, 'Native folder upload preserves nested directory structure');
  await evaluate(`[...document.querySelectorAll('#breadcrumbs button')].find(button => button.textContent === ${JSON.stringify(folder)}).click()`);
  await waitFor(entryExists('draft.txt'));
  await directoryFeatureChecks(folder);
  await openEntry('draft.txt');
  await waitFor(`!document.querySelector('#text-preview').hidden && document.querySelector('#file-editor').value === 'Original text'`);
  await click('#edit-file');
  await fill('#file-editor', 'Saved through the browser: café.');
  await click('#save-file');
  await waitFor(`document.querySelector('#file-edit-status').textContent === 'No unsaved changes'`);
  await click('#back-to-directory');
  await waitFor(entryExists('draft.txt'));
  await openEntry('draft.txt');
  await waitFor(`document.querySelector('#file-editor').value === 'Saved through the browser: café.'`);
  check(true, 'Text preview, editing, and save persist to disk');
  await click('#notepad-tab');
  await waitFor(`!document.querySelector('#notepad-view').hidden`);
  check(await evaluate(`document.querySelector('#note-editor').value`) === 'Edited note with Unicode: café.', 'Notepad remains accessible from a file preview');
  await click('#workspace-tab');
  await click('#back-to-directory');
  await waitFor(entryExists('program.exe'));
  await openEntry('program.exe');
  await waitFor(`!document.querySelector('#binary-preview').hidden`);
  check(await evaluate(`document.querySelector('#download-file').hasAttribute('href')`), 'Binary files show a download action');
  await click('#back-to-directory');
  await waitFor(entryExists('pixel.png'));
  await openEntry('pixel.png');
  await waitFor(`!document.querySelector('#image-preview').hidden && document.querySelector('#preview-image').naturalWidth === 1`);
  check(true, 'Image preview decodes in the browser');
  await click('#back-to-directory');
  await waitFor(entryExists('draft.txt'));
  expectedDialogs.push({accept: true, promptText: 'renamed.txt'});
  await entryAction('draft.txt', 'Rename');
  await waitFor(entryExists('renamed.txt'));
  expectedDialogs.push({accept: true, promptText: 'destination'});
  await click('#new-directory');
  await waitFor(entryExists('destination'));
  await selectEntry('renamed.txt');
  await selectEntry('program.exe');
  await click('#download-selection');
  const zipDeadline = Date.now() + 15000;
  while (!(await fs.readdir(artifacts)).some(name => name.endsWith('.zip'))) {
    if (Date.now() > zipDeadline) throw new Error('ZIP download did not complete.');
    await delay(100);
  }
  check(true, 'Multi-selection ZIP downloads directly to the browser');
  await waitFor(`!document.querySelector('#move-selection').disabled`);
  await click('#move-selection');
  await fill('#move-destination', `${folder}/destination`);
  await submit('#move-form');
  await waitFor(`document.querySelector('#transfer-message').textContent.toLowerCase().includes('complete') && !document.querySelector('#refresh-directory').disabled`);
  await waitFor(`!(${entryExists('renamed.txt')})`);
  await openEntry('destination');
  await waitFor(entryExists('renamed.txt'));
  check(await evaluate(entryExists('program.exe')), 'Multi-selection move relocates both files and reports completion');
  await screenshot('desktop-workspace');

  for (const [label, width, height] of [['tablet', 820, 1180], ['mobile', 390, 844], ['small-mobile', 320, 640]]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: true});
    check(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${label} workspace has no horizontal overflow`);
    await screenshot(`${label}-workspace`);
    await click('#notepad-tab');
    check(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${label} notepad has no horizontal overflow`);
    await screenshot(`${label}-notepad`);
    await click('#workspace-tab');
  }
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  check(await evaluate(`(() => {const button = document.querySelector('#notepad-tab').getBoundingClientRect(); return button.top >= 0 && button.bottom <= innerHeight;})()`), 'Notepad navigation stays visible while scrolling');
  await evaluate('window.scrollTo(0, 0)');
  await click('#theme-toggle');
  check(await evaluate(`document.documentElement.dataset.theme === 'light'`), 'Light theme toggles');
  await screenshot('mobile-light');

  await click('#select-all');
  expectedDialogs.push({accept: false});
  await click('#delete-selection');
  check(await evaluate(entryExists('renamed.txt')), 'Cancelling delete preserves selected files');
  expectedDialogs.push({accept: true});
  await click('#delete-selection');
  await waitFor(`!(${entryExists('renamed.txt')}) && !(${entryExists('program.exe')})`);
  await click('#notepad-tab');
  expectedDialogs.push({accept: true});
  await click('#delete-note');
  await waitFor(`!document.querySelector('#note-list').textContent.includes(${JSON.stringify(noteName)})`);
  check(true, 'Confirmed deletion removes selected files and notes');
  await send('Page.reload');
  await waitFor(`document.readyState === 'complete' && document.documentElement.dataset.theme === 'light'`);
  check(true, 'Theme preference survives reload');
  check(browserErrors.length === 0, `No uncaught browser errors: ${JSON.stringify(browserErrors)}`);
  check(expectedDialogs.length === 0, 'All destructive actions showed their expected confirmation');
  console.log(`Browser verification complete. Screenshots and ZIP: ${artifacts}`);
} catch (error) {
  await screenshot('failure').catch(() => {});
  console.error(`Browser artifacts: ${artifacts}`);
  throw error;
} finally {
  ws.close();
}
