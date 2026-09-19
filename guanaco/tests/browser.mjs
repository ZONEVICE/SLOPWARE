/** Optional Chromium DevTools smoke runner. Node is a test tool, never an app server.
 * Start Python on port 8000 and Chromium with --remote-debugging-port=9228 first.
 * Run: node tests/browser.mjs [--inspect | --status | --features | --finish]
 */
import fs from 'node:fs/promises';
const base = process.env.GUANACO_TEST_URL || 'http://localhost:8000';
const debug = process.env.GUANACO_DEBUG_URL || 'http://127.0.0.1:9228';
const pages = await (await fetch(`${debug}/json/list`)).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve));
let next = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) { const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (expression, timeout = 15000) => {
  const started = Date.now();
  while (!await evaluate(expression)) { if (Date.now() - started > timeout) throw new Error(`Timed out: ${expression}`); await sleep(100); }
};
const check = (condition, message) => { if (!condition) throw new Error(message); console.log(`PASS ${message}`); };
// Store-driven UI updates are intentionally batched into animation frames.
// Let both the click and the resulting render finish before inspecting controls.
const click = text => evaluate(`(() => { const node = [...document.querySelectorAll('button,a')].find(node => node.textContent.trim() === ${JSON.stringify(text)} && node.getClientRects().length); if (!node) throw Error('Missing visible action: ' + ${JSON.stringify(text)}); node.click(); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))); })()`);
const fill = (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error('Missing field'); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', {bubbles:true})); })()`);
const screenshot = async name => fs.writeFile(`/tmp/guanaco-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
const reload = async () => {
  await evaluate('window.beforeTestReload = true');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`!window.beforeTestReload && document.readyState === 'complete' && !!document.querySelector('#new-request')`);
};

async function finishChecks() {
  await click('Orchestrator');
  await waitFor(`!document.querySelector('#orchestrator-view').hidden`);
  await reload();
  check(await evaluate(`document.querySelector('.request-card.is-custom')!==null`), 'Conversations and custom settings survive reload');
  await evaluate(`(() => {const filter=document.querySelector('[aria-label="Filter conversations"]');filter.value='completed';filter.dispatchEvent(new Event('change'));const search=document.querySelector('[aria-label="Search conversations"]');search.value='No matching conversation';search.dispatchEvent(new Event('input'));})()`);
  await click('+ New request');
  await waitFor(`document.activeElement === document.querySelector('.request-card:last-child textarea')`);
  check(await evaluate(`!document.querySelector('.request-card:last-child').hidden && document.querySelector('[aria-label="Filter conversations"]').value === 'all' && !document.querySelector('[aria-label="Search conversations"]').value`), 'New request reveals and focuses its window despite previous search or filters');
  await evaluate(`document.querySelector('.request-card:last-child [aria-label="Delete conversation"]').click()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Mobile orchestrator has no horizontal overflow');
  await screenshot('mobile');
  await click('Chat'); await waitFor(`!document.querySelector('#chat-view').hidden`);
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Mobile chat has no horizontal overflow');
  await click('Configuration'); await waitFor(`!document.querySelector('#settings-view').hidden`);
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), 'Mobile settings have no horizontal overflow');
  await send('Page.navigate', { url: `${base}/tests/` });
  await waitFor(`window.testsDone !== undefined`);
  const results = await evaluate('window.testsDone');
  for (const test of results.tests) console.log(`${test.status.toUpperCase()} core: ${test.name}${test.error ? ': '+test.error : ''}`);
  check(results.failed===0, `${results.passed} isolated core tests pass`);
  check(errors.length===0, 'No uncaught browser exceptions');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base });
  console.log('Browser verification complete. Screenshots: /tmp/guanaco-*.png');
}

async function featureChecks() {
  await click('Configuration');
  await waitFor(`!!document.querySelector('#settings-view [name=model]')`);
  const imported = await evaluate(`({...JSON.parse(localStorage.getItem('guanaco.config.v1')),temperature:0.731,numPredict:80,numCtx:2048,think:true,stop:['\\nUser:', '  END_BOUNDARY  ']})`);
  const importJSON = async content => evaluate(`(() => {const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(content)}],'settings.json',{type:'application/json'}));const input=document.querySelector('#import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await importJSON(JSON.stringify(imported));
  await waitFor(`JSON.parse(localStorage.getItem('guanaco.config.v1')).temperature===0.731`);
  check(await evaluate(`document.querySelector('#settings-view [name=think]').checked`), 'Valid JSON import applies all global configuration fields');
  await click('Save global configuration');
  check(await evaluate(`document.querySelector('#settings-view form').checkValidity()`), 'Imported arbitrary decimal values can be resaved');
  check(JSON.stringify(await evaluate(`JSON.parse(localStorage.getItem('guanaco.config.v1')).stop`))===JSON.stringify(imported.stop), 'Saving imported stop sequences preserves exact spaces and embedded newlines');
  const before = await evaluate(`localStorage.getItem('guanaco.config.v1')`);
  await importJSON('{invalid-json'); await sleep(250);
  check(await evaluate(`localStorage.getItem('guanaco.config.v1')`)===before, 'Malformed JSON import does not mutate saved settings');
  await evaluate(`window.downloadBlob=null;window.originalCreateObjectURL=URL.createObjectURL;URL.createObjectURL=(blob)=>{window.downloadBlob=blob;return window.originalCreateObjectURL(blob)};window.originalAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(!this.download)window.originalAnchorClick.call(this);};`);
  await click('↓ Export JSON');
  const exported = await evaluate(`(async () => JSON.parse(await window.downloadBlob.text()))()`);
  check(exported.schema==='guanaco.configuration'&&exported.version===1&&exported.config.temperature===0.731, 'Export button creates the portable versioned JSON blob');
  await evaluate(`URL.createObjectURL=window.originalCreateObjectURL;HTMLAnchorElement.prototype.click=window.originalAnchorClick;`);
  await click('Orchestrator'); await click('+ New request');
  await fill('.request-card:last-child textarea', 'What is one plus one? Answer with a number.');
  await evaluate(`document.querySelector('.request-card:last-child .card-compose').requestSubmit()`);
  await evaluate(`document.querySelector('.request-card:last-child .card-title').click()`);
  await waitFor(`!document.querySelector('#chat-view').hidden`);
  await waitFor(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).turns.at(-1).status==='completed'`,120000);
  check(await evaluate(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).turns.at(-1).thinking.length>0`), 'Real Qwen Think mode returns a separate thinking stream');
  check(await evaluate(`!document.querySelector('.thinking-block').hidden`), 'Chat displays the separate model thinking section');
  await screenshot('thinking');
  await click('Configuration'); await click('Restore default settings');
  await waitFor(`document.querySelector('#confirm-dialog').open`); await click('Restore defaults');
  await waitFor(`JSON.parse(localStorage.getItem('guanaco.config.v1')).numPredict===2048`);
  check(await evaluate(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).config.temperature===0.731`), 'Restore defaults preserves existing conversation settings');
  await click('Chat');
  await click('⚙ Chat configuration');
  await waitFor(`document.querySelector('#config-dialog').open`); await click('Use current global defaults');
  await waitFor(`!document.querySelector('#config-dialog').open`);
  check(await evaluate(`document.querySelector('.chat-header .badge.global')!==null`), 'A chat can return to current global defaults');
  // Use a mocked stream to exercise an active cancellation and retry through UI.
  await evaluate(`window.liveFetch=window.fetch;window.fakeAttempts=0;window.fetch=async (url,options)=>{if(!String(url).endsWith('/api/chat'))return window.liveFetch(url,options);window.fakeAttempts++;if(window.fakeAttempts===1)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));return new Response('{"message":{"content":"Recovered successfully"},"done":false}\\n{"done":true,"eval_count":2}\\n');};`);
  await fill('.composer textarea','Exercise cancellation and retry.'); await evaluate(`document.querySelector('.composer').requestSubmit()`);
  await waitFor(`window.fakeAttempts===1`); await click('Stop generation');
  await waitFor(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).turns.at(-1).status==='cancelled'`);
  await waitFor(`[...document.querySelectorAll('button')].some(node => node.textContent === 'Retry request' && node.getClientRects().length)`);
  await click('Retry request');
  await waitFor(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).turns.at(-1).status==='completed'`);
  await waitFor(`document.querySelector('.message.assistant:last-child')?.textContent.includes('Recovered successfully')`);
  check(await evaluate(`window.fakeAttempts===2 && document.querySelector('.message.assistant:last-child').textContent.includes('Recovered successfully')`), 'Active cancellation and retry use the latest job and recover in the chat UI');
  await evaluate(`window.fetch=window.liveFetch`);
  check(errors.length===0, 'No uncaught browser exceptions in extended feature checks');
}

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.setLifecycleEventsEnabled', { enabled: true });
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(await evaluate(`({url:location.href,stop:JSON.parse(localStorage.getItem('guanaco.config.v1'))?.stop,formStop:document.querySelector('[name=stop]')?.value,workspace:JSON.parse(localStorage.getItem('guanaco.workspace.v1'))?.chats.map(chat=>({title:chat.title,turns:chat.turns.map(turn=>({status:turn.status,error:turn.error,length:turn.content.length,thinking:turn.thinking.length,metrics:turn.metrics}))})),visible:document.body.innerText.slice(-1500)})`),null,2));
    ws.close(); process.exit(0);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base });
  await waitFor(`!!document.querySelector('#new-request')`);
  await reload();
  await waitFor(`document.querySelector('#connection-label').textContent !== 'Connecting…'`);
  if (process.argv.includes('--inspect')) {
    console.log(await evaluate(`({title:document.title,connection:document.querySelector('#connection-label').textContent,overflow:document.documentElement.scrollWidth>innerWidth,errors:document.body.innerText.includes('undefined'),cards:[...document.querySelectorAll('.request-card')].map(n=>n.className),storage:JSON.parse(localStorage.getItem('guanaco.workspace.v1'))?.chats.map(c=>({id:c.id,mode:c.configMode,status:c.turns.at(-1)?.status})),notices:[...document.querySelectorAll('.toast')].map(n=>n.textContent)})`));
    await screenshot('desktop');
  } else if (process.argv.includes('--features')) {
    await featureChecks();
  } else if (process.argv.includes('--finish')) {
    await finishChecks();
  } else {
    // Clear at the next document's start: clearing before reload would let the
    // old page's pagehide save restore its previous test workspace afterward.
    const resetScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.removeItem('guanaco.config.v1'); localStorage.removeItem('guanaco.workspace.v1');` });
    await reload();
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: resetScript.identifier });
    await waitFor(`document.querySelector('#connection-label').textContent === 'Ollama connected'`);
    check(true, 'Real Ollama connects from the browser with CORS');
    await click('Configuration');
    await waitFor(`[...document.querySelector('#settings-view select[name=model]')?.options || []].some(option => option.value === 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0' && !option.textContent.includes('(saved selection)'))`);
    check(await evaluate(`document.querySelector('#settings-view select[name=model]').value === 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0'`), 'Model dropdown loads installed models and selects the small Qwen model');
    await fill('#settings-view [name=numPredict]', '160');
    await fill('#settings-view [name=systemPrompt]', 'Give a concise helpful answer.');
    await click('Save global configuration');
    check(await evaluate(`JSON.parse(localStorage.getItem('guanaco.config.v1')).numPredict===160`), 'Global settings save to localStorage');
    await screenshot('settings');
    await click('Orchestrator');
    await click('+ New request');
    await fill('.request-card textarea', 'What is 2 plus 2? Answer briefly.');
    await evaluate(`document.querySelector('.card-compose').requestSubmit()`);
    await waitFor(`document.querySelector('.request-card .badge.running') !== null`);
    await click('+ New request');
    await fill('.request-card:last-child textarea', 'Name one primary color.');
    await evaluate(`document.querySelector('.request-card:last-child .card-compose').requestSubmit()`);
    await waitFor(`!!document.querySelector('.badge.queued')`);
    check(await evaluate(`document.querySelectorAll('.request-card .badge.running').length===1`), 'Second request queues behind exactly one active generation');
    await screenshot('queue');
    await evaluate(`document.querySelector('.request-card:last-child .card-title').click()`);
    await waitFor(`!document.querySelector('#chat-view').hidden`);
    check(await evaluate(`document.querySelector('.status-banner').textContent.includes('queue')`), 'Queued window opens as a full chat before its response');
    await fill('.composer textarea', 'What color did you just name?');
    await evaluate(`document.querySelector('.composer').requestSubmit()`);
    await waitFor(`document.querySelectorAll('.message.user').length===2`);
    check(true, 'Follow-up joins shared queue while a different conversation runs');
    await waitFor(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).jobs.filter(job=>job.status==='completed').length===3`, 180000);
    check(await evaluate(`document.querySelectorAll('.message.assistant').length===2 && [...document.querySelectorAll('.message.assistant .message-content')].every(node=>node.textContent.length>10)`), 'Three live Qwen requests finish and chat history remains visible');
    await screenshot('chat');
    await click('⚙ Chat configuration');
    await waitFor(`document.querySelector('#config-dialog').open`);
    await fill('#config-dialog [name=temperature]', '0.73');
    await evaluate(`document.querySelector('#config-dialog [name=think]').checked = true`);
    await click('Apply to this conversation');
    await waitFor(`!document.querySelector('#config-dialog').open`);
    check(await evaluate(`document.querySelector('.chat-header .badge.custom')!==null`), 'Per-chat customization shows purple custom badge');
    const snapshot = await evaluate(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.map(chat=>({mode:chat.configMode,temperature:chat.config.temperature,think:chat.config.think}))`);
    check(snapshot[0].temperature===0.7 && snapshot[1].temperature===0.73 && snapshot[1].think, 'Custom configuration affects only the selected conversation');
    await click('Configuration');
    await fill('#settings-view [name=numPredict]', '200'); await click('Save global configuration');
    check(await evaluate(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.every(chat=>chat.config.numPredict===160)`), 'Changing global defaults preserves existing chat snapshots');
    await click('Orchestrator'); await click('+ New request');
    check(await evaluate(`JSON.parse(localStorage.getItem('guanaco.workspace.v1')).chats.at(-1).config.numPredict===200`), 'New chat inherits new global defaults');
    await click('Ⅱ Pause queue');
    await fill('.request-card:last-child textarea', 'This request will be cancelled.');
    await evaluate(`document.querySelector('.request-card:last-child .card-compose').requestSubmit()`);
    await waitFor(`!!document.querySelector('.request-card:last-child .badge.queued')`);
    check(await evaluate(`!document.querySelector('.request-card .badge.running')`), 'Paused queue accepts work without dispatching');
    await evaluate(`document.querySelector('.request-card:last-child .card-footer button').click()`);
    await waitFor(`!!document.querySelector('.request-card:last-child .badge.cancelled')`);
    check(true, 'Queued request cancellation works');
    await click('▶ Resume queue');
    await featureChecks();
    await finishChecks();
  }
} finally { ws.close(); }
