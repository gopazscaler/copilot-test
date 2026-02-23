const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COPILOT_URL = 'https://m365.cloud.microsoft/chat/';
const QUESTION = 'what is the weather in boston today';
const DEBUG = true;
const PARALLELISM = Number.parseInt(process.env.PARALLELISM || '', 10) > 0
  ? Number.parseInt(process.env.PARALLELISM, 10)
  : 2;
const TMP_DIR = path.join(process.cwd(), 'tmp');
const HAR_TEMP_PATH = path.join(TMP_DIR, 'copilot_debug_tmp.har');
const RUN_TIMESTAMP = formatFileTimestamp();
const HAR_OUTPUT_PREFIX = path.join(TMP_DIR, `copilot_debug_${RUN_TIMESTAMP}_`);
const HAR_FLUSH_WAIT_MS = 15000;
const WS_LOG_TEMP_PATH = path.join(TMP_DIR, 'copilot_ws_tmp.log');
const WS_LOG_OUTPUT_PREFIX = path.join(TMP_DIR, `copilot_ws_${RUN_TIMESTAMP}_`);
const WS_HAR_OUTPUT_PREFIX = path.join(TMP_DIR, `copilot_ws_har_${RUN_TIMESTAMP}_`);

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const CONSOLE_LOG_PATH = path.join(TMP_DIR, `copilot_console_${RUN_TIMESTAMP}.log`);
const consoleLogStream = fs.createWriteStream(CONSOLE_LOG_PATH, { flags: 'a' });

function writeConsoleLog(text) {
  if (!consoleLogStream.destroyed) {
    consoleLogStream.write(text);
  }
}

function closeConsoleLog() {
  if (consoleLogStream.destroyed) return Promise.resolve();
  return new Promise((resolve) => consoleLogStream.end(resolve));
}

function out(msg) {
  const line = msg + '\n';
  process.stdout.write(line);
  writeConsoleLog(line);
}

function streamOut(msg) {
  process.stdout.write(msg);
  writeConsoleLog(msg);
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function nowIso() {
  return new Date().toISOString();
}

function formatWsPayload(payload) {
  if (Buffer.isBuffer(payload)) {
    return { text: payload.toString('base64'), encoding: 'base64' };
  }
  const text = String(payload ?? '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { text: JSON.stringify(JSON.parse(trimmed), null, 2), encoding: 'json' };
    } catch {}
  }
  return { text, encoding: 'text' };
}

function createWsLogger() {
  const stream = fs.createWriteStream(WS_LOG_TEMP_PATH, { flags: 'a' });

  const write = (line) => {
    stream.write(line + '\n');
  };
  const close = () => new Promise((resolve) => stream.end(resolve));
  return { write, close };
}

function createWsHarRecorder() {
  const connections = [];
  const pending = [];
  const wsMap = new WeakMap();

  const findPending = (url) => pending.findLast((item) => item.url === url && !item.response);

  const recordRequest = (url, headers) => {
    pending.push({ url, request: { headers, time: nowIso() } });
  };

  const recordResponse = (url, status, headers) => {
    const item = findPending(url) || { url, request: { headers: {}, time: nowIso() } };
    item.response = { status, headers, time: nowIso() };
    if (!pending.includes(item)) pending.push(item);
  };

  const attachWebSocket = (ws, url) => {
    const pendingItem = findPending(url);
    const connection = {
      id: `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url,
      request: pendingItem?.request || { headers: {}, time: nowIso() },
      response: pendingItem?.response || null,
      messages: [],
      openTime: nowIso(),
      closeTime: null,
    };
    connections.push(connection);
    wsMap.set(ws, connection);
    return connection;
  };

  const recordFrame = (ws, direction, payload) => {
    const connection = wsMap.get(ws);
    if (!connection) return;
    const formatted = formatWsPayload(payload);
    connection.messages.push({
      time: nowIso(),
      direction,
      encoding: formatted.encoding,
      payload: formatted.text,
    });
  };

  const recordClose = (ws) => {
    const connection = wsMap.get(ws);
    if (connection) {
      connection.closeTime = nowIso();
    }
  };

  const buildHarLike = () => {
    return {
      log: {
        version: '1.2',
        creator: { name: 'copilot_test', version: '1.0' },
        entries: connections.map((conn) => ({
          startedDateTime: conn.request.time,
          time: 0,
          request: {
            method: 'GET',
            url: conn.url,
            httpVersion: 'HTTP/1.1',
            headers: Object.entries(conn.request.headers || {}).map(([name, value]) => ({ name, value })),
            headersSize: -1,
            bodySize: 0,
          },
          response: conn.response
            ? {
                status: conn.response.status,
                statusText: '',
                httpVersion: 'HTTP/1.1',
                headers: Object.entries(conn.response.headers || {}).map(([name, value]) => ({ name, value })),
                headersSize: -1,
                bodySize: 0,
              }
            : {
                status: 0,
                statusText: '',
                httpVersion: 'HTTP/1.1',
                headers: [],
                headersSize: -1,
                bodySize: 0,
              },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          _webSocketMessages: conn.messages.map((msg) => ({
            time: msg.time,
            type: msg.direction,
            data: msg.payload,
            encoding: msg.encoding,
          })),
        })),
      },
    };
  };

  const finalize = () => buildHarLike();

  return { recordRequest, recordResponse, attachWebSocket, recordFrame, recordClose, finalize };
}

function finalizeWsHarLike(wsHarRecorder) {
  if (!wsHarRecorder) return null;
  const harLike = wsHarRecorder.finalize();
  const baseName = `${WS_HAR_OUTPUT_PREFIX}`;

  let outputPath = `${baseName}.json`;
  let counter = 1;
  while (fs.existsSync(outputPath)) {
    outputPath = `${baseName}_${counter}.json`;
    counter += 1;
  }
  fs.writeFileSync(outputPath, JSON.stringify(harLike, null, 2), 'utf8');
  return outputPath;
}

function logWsLines(wsLogger, label, lines) {
  if (!wsLogger) return;
  lines.forEach((line) => {
    wsLogger.write(`[${formatTimestamp()}] [${label}] ${line}`);
  });
}

async function finalizeWsLog(logger) {
  if (!logger) return null;
  await logger.close().catch(() => {});
  if (!fs.existsSync(WS_LOG_TEMP_PATH)) {
    out(`[WARN] WS log temp file not found at ${WS_LOG_TEMP_PATH}`);
    return null;
  }

  const baseName = `${WS_LOG_OUTPUT_PREFIX}`;

  let outputPath = `${baseName}.log`;
  let counter = 1;
  while (fs.existsSync(outputPath)) {
    outputPath = `${baseName}_${counter}.log`;
    counter += 1;
  }

  try {
    fs.renameSync(WS_LOG_TEMP_PATH, outputPath);
  } catch (err) {
    out(`[WARN] WS log rename failed: ${err?.message || err}`);
    fs.copyFileSync(WS_LOG_TEMP_PATH, outputPath);
  }

  return outputPath;
}

async function finalizeHarFile(timeoutMs = HAR_FLUSH_WAIT_MS) {
  const start = Date.now();
  while (!fs.existsSync(HAR_TEMP_PATH) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!fs.existsSync(HAR_TEMP_PATH)) {
    out(`[WARN] HAR temp file not found at ${HAR_TEMP_PATH}`);
    return null;
  }

  let lastSize = -1;
  let stableCount = 0;
  while (Date.now() - start < timeoutMs) {
    const size = fs.statSync(HAR_TEMP_PATH).size;
    if (size === lastSize) {
      stableCount += 1;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const baseName = `${HAR_OUTPUT_PREFIX}`;

  let outputPath = `${baseName}.har`;
  let counter = 1;
  while (fs.existsSync(outputPath)) {
    outputPath = `${baseName}_${counter}.har`;
    counter += 1;
  }
  try {
    fs.renameSync(HAR_TEMP_PATH, outputPath);
  } catch (err) {
    out(`[WARN] HAR rename failed: ${err?.message || err}`);
    fs.copyFileSync(HAR_TEMP_PATH, outputPath);
  }
  return outputPath;
}

function streamWithTimestamp(delta, state) {
  const parts = String(delta).split('\n');
  parts.forEach((part, idx) => {
    if (state.needsPrefix) {
      const label = state.label ? `[${state.label}] ` : '';
      streamOut(`[${formatTimestamp()}] ${label}`);
      state.needsPrefix = false;
    }
    streamOut(part);

    if (idx < parts.length - 1) {
      streamOut('\n');
      state.needsPrefix = true;
    }
  });
}

function looksLikeSsoOrLogin(url) {
  const u = (url || '').toLowerCase();
  return (
    u.includes('login.microsoftonline.com') ||
    u.includes('login.live.com') ||
    u.includes('/adfs/') ||
    u.includes('sso') ||
    u.includes('saml') ||
    u.includes('oauth') ||
    u.includes('signin') ||
    u.includes('account.activedirectory')
  );
}

async function firstUsable(page, locatorFactories, timeoutMs = 1500) {
  for (const makeLocator of locatorFactories) {
    const loc = makeLocator();
    try {
      if (await loc.first().isVisible({ timeout: timeoutMs }).catch(() => false)) {
        return loc.first();
      }
      const count = await loc.count().catch(() => 0);
      if (count > 0) return loc.first();
    } catch {}
  }
  return null;
}

async function dumpInputDiagnostics(page) {
  if (!DEBUG) return;

  const summarize = async (root, label) => {
    const summary = {};
    for (const selector of [
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      'input[type="text"]',
      '[role="textbox"]',
    ]) {
      summary[selector] = await root.locator(selector).count().catch(() => 0);
    }
    out(`[DEBUG] ${label} input counts: ${JSON.stringify(summary)}`);
  };

  out(`[DEBUG] Page URL: ${page.url()}`);
  await summarize(page, 'page');

  const frames = page.frames();
  out(`[DEBUG] Frame count: ${frames.length}`);
  for (const frame of frames) {
    const url = frame.url();
    await summarize(frame, `frame ${url || '<no url>'}`);
  }
}

async function dumpPageState(page) {
  if (!DEBUG) return;

  try {
    const title = await page.title().catch(() => '<unknown>');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 400);
    out(`[DEBUG] Page title: ${title}`);
    out(`[DEBUG] Body snippet: ${snippet || '<empty>'}`);
  } catch {}

  try {
    await page.screenshot({ path: 'copilot_debug.png', fullPage: true });
    out('[DEBUG] Screenshot saved to copilot_debug.png');
  } catch {}

  try {
    const html = await page.content().catch(() => '');
    fs.writeFileSync('copilot_debug.html', html || '', 'utf8');
    out('[DEBUG] HTML saved to copilot_debug.html');
  } catch {}
}

async function getCounts(page, selectors) {
  const counts = {};
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    counts[selector] = count;
  }
  return counts;
}

async function waitForNewMessage(page, selectors, previousCounts, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const selector of selectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      const prev = previousCounts?.[selector] ?? 0;
      if (count > prev) {
        return loc.nth(count - 1);
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function waitForInputCleared(input, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await readInputValue(input);
    if (value !== null && value.trim() === "") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitForStableText(loc, timeoutMs = 30000, stableMs = 1200) {
  const start = Date.now();
  let last = "";
  let lastChange = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await loc.innerText().catch(() => "");
    if (text !== last) {
      last = text;
      lastChange = Date.now();
    }
    if (text.trim() && Date.now() - lastChange >= stableMs) return text.trim();
    await new Promise((r) => setTimeout(r, 300));
  }

  return last.trim();
}

function looksLikeInterim(text) {
  const t = (text || '').toLowerCase();
  return (
    t.length < 20 ||
    t.includes('generating response') ||
    t.includes("i'll search") ||
    t.includes('searching') ||
    t.endsWith('...')
  );
}

async function hasStopButton(page) {
  const stop = await firstUsable(page, [
    () => page.getByRole('button', { name: /stop/i }),
    () => page.locator('[aria-label*="stop" i]'),
    () => page.locator('[data-testid*="stop" i]'),
  ], 600);

  return Boolean(stop);
}

async function waitForFinalText(loc, timeoutMs = 45000, stableMs = 800) {
  const start = Date.now();
  let last = '';
  let lastChange = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await loc.innerText().catch(() => '');
    if (text !== last) {
      last = text;
      lastChange = Date.now();
    }

    const stable = Date.now() - lastChange >= stableMs;
    if (stable && text.trim() && !looksLikeInterim(text)) return text.trim();

    await new Promise((r) => setTimeout(r, 400));
  }

  return last.trim();
}

function inputLocatorFactories(root) {
  return [
    () => root.locator('textarea'),
    () => root.locator('textarea[placeholder]'),
    () => root.getByPlaceholder('Message Copilot'),
    () => root.getByPlaceholder(/message copilot/i),
    () => root.locator('div[contenteditable="true"]'),
    () => root.locator('[contenteditable="true"][aria-label]'),
    () => root.locator('[aria-label*="Message" i]'),
    () => root.locator('[data-placeholder*="Message" i]'),
    () => root.getByRole('textbox'),
    () => root.locator('div[role="textbox"]'),
    () => root.locator('input[type="text"]'),
  ];
}

async function findDeepInputHandle(root) {
  const handle = await root.evaluateHandle(() => {
    const matches = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const aria = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const dataPlaceholder = el.getAttribute('data-placeholder') || '';
      const contentEditable = el.getAttribute('contenteditable') || '';

      if (tag === 'textarea') return true;
      if (tag === 'input' && el.getAttribute('type') === 'text') return true;
      if (contentEditable === 'true') return true;
      if (role.toLowerCase() === 'textbox') return true;

      const combined = `${aria} ${placeholder} ${dataPlaceholder}`.toLowerCase();
      return combined.includes('message') && combined.includes('copilot');
    };

    const walk = (rootNode) => {
      const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (matches(node)) return node;
        if (node.shadowRoot) {
          const found = walk(node.shadowRoot);
          if (found) return found;
        }
        node = walker.nextNode();
      }
      return null;
    };

    return walk(document);
  });

  return handle.asElement();
}

async function readInputValue(input) {
  if (input?.kind === 'locator') {
    return input.target
      .evaluate((el) => ("value" in el ? el.value : el.textContent) || "")
      .catch(() => null);
  }
  if (input?.kind === 'handle') {
    return input.target
      .evaluate((el) => ("value" in el ? el.value : el.textContent) || "")
      .catch(() => null);
  }
  return null;
}

async function setInputValue(input, text) {
  if (input?.kind === 'locator') {
    await input.target.click().catch(() => {});
    await input.target.fill(text).catch(async () => {
      await input.target.type(text, { delay: 5 });
    });
    return;
  }

  if (input?.kind === 'handle') {
    await input.target.click().catch(() => {});
    await input.target.evaluate((el, value) => {
      if ('value' in el) {
        el.value = value;
      } else {
        el.textContent = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  }
}

async function pressEnter(input, page) {
  if (input?.kind === 'locator') {
    await input.target.press('Enter');
    return true;
  }
  if (input?.kind === 'handle') {
    await page.keyboard.press('Enter');
    return true;
  }
  return false;
}

async function findChatInput(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inputOnPage = await firstUsable(page, inputLocatorFactories(page), 1500);
    if (inputOnPage) return { kind: 'locator', target: inputOnPage };

    const deepOnPage = await findDeepInputHandle(page);
    if (deepOnPage) return { kind: 'handle', target: deepOnPage };

    for (const frame of page.frames()) {
      const inputInFrame = await firstUsable(frame, inputLocatorFactories(frame), 1000);
      if (inputInFrame) return { kind: 'locator', target: inputInFrame };

      const deepInFrame = await findDeepInputHandle(frame);
      if (deepInFrame) return { kind: 'handle', target: deepInFrame };
    }

    await page.waitForTimeout(500);
  }
  return null;
}

async function ensureCopilotReady(page, headless, allowLoginRequired = false) {
  await page.goto(COPILOT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait briefly for any redirect to SSO/login
  await page.waitForTimeout(1500);

  const currentUrl = page.url();
  if (looksLikeSsoOrLogin(currentUrl)) {
    if (headless) {
      if (allowLoginRequired) return true;
      throw new Error(`Redirected to SSO/login in headless mode: ${currentUrl}`);
    }

    out('[INFO] Please complete SSO in the opened browser window.');
    out('[INFO] Waiting for you to return to Copilot Chat...');

    await page.waitForURL((url) => !looksLikeSsoOrLogin(url.toString()), {
      timeout: 5 * 60 * 1000,
    });
  }

  await page.waitForTimeout(1500);
  return false;
}

async function askOnce(workerId, page) {
  const input = await findChatInput(page, 35000);

  if (!input) {
    await dumpInputDiagnostics(page);
    await dumpPageState(page);
    throw new Error('Could not locate chat input. UI may have changed or page not fully loaded.');
  }

  const transcriptRoot = page.locator('main, [role="main"], body').first();
  const messageSelectors = [
    'article',
    '[data-testid*="message" i]',
    '[class*="message" i]',
    '[role="article"]',
  ];
  const messageSelector = messageSelectors.join(', ');
  const beforeCounts = await getCounts(page, messageSelectors);

  out(`[${formatTimestamp()}] [WORKER-${workerId}] Sending question: "${QUESTION}"`);

  await setInputValue(input, QUESTION);

  let sent = false;
  try {
    sent = await pressEnter(input, page);
  } catch {}

  if (!sent) {
    const sendBtn = await firstUsable(page, [
      () => page.getByRole('button', { name: /send/i }),
      () => page.locator('button:has-text("Send")'),
      () => page.locator('[aria-label*="Send" i]'),
    ], 2500);

    if (!sendBtn) {
      throw new Error('Could not send message (no Send button found and Enter did not work).');
    }
    await sendBtn.click();
  }

  const inputCleared = await waitForInputCleared(input, 8000);
  if (!inputCleared) {
    out(`[WARN] [WORKER-${workerId}] Input did not clear after send; send might have failed. Continuing to wait for response.`);
  }

  const timeoutMs = 70000;
  const start = Date.now();
  let response = null;
  let streamedText = '';
  let streamStarted = false;
  const streamState = { needsPrefix: true, label: `W${workerId}` };

  while (Date.now() - start < timeoutMs) {
    const current = await transcriptRoot.innerText().catch(() => '');
    const lower = current.toLowerCase();

    if (lower.includes('connection closed') || lower.includes('disconnected')) {
      throw new Error('connection closed');
    }
    if (lower.includes('something went wrong') || lower.includes('try again')) {
      throw new Error('something went wrong / try again (detected in UI)');
    }

    const messageList = page.locator(messageSelector);
    const newMessage = await waitForNewMessage(page, messageSelectors, beforeCounts, 2000);
    const count = await messageList.count().catch(() => 0);
    const lastMessage = newMessage || (count > 0 ? messageList.nth(count - 1) : null);

    const stillStreaming = await hasStopButton(page);
    if (lastMessage) {
      const liveText = await lastMessage.innerText().catch(() => '');
      if (liveText && liveText !== streamedText) {
        const delta = liveText.startsWith(streamedText)
          ? liveText.slice(streamedText.length)
          : `\n${liveText}`;
        if (!streamStarted) {
          streamStarted = true;
        }
        streamWithTimestamp(delta, streamState);
        streamedText = liveText;
      }
    }

    if (lastMessage && !stillStreaming) {
      const text = await waitForFinalText(lastMessage, 20000, 600);
      if (text && !text.toLowerCase().includes(QUESTION.toLowerCase())) {
        response = text;
        break;
      }
    }

    await page.waitForTimeout(800);
  }

  if (!response) {
    throw new Error('Timed out waiting for a response.');
  }

  if (!streamStarted) {
    out(`[${formatTimestamp()}] [W${workerId}] ${response.trim()}`);
  } else {
    streamOut('\n');
  }
}

async function askLoop(workerId, ctx, shared, headless, wsLogger, wsHarRecorder) {
  const page = await ctx.newPage();
  attachWebSocketLogging(page, wsLogger, wsHarRecorder, workerId);
  await ensureCopilotReady(page, headless, false);

  while (!shared.abort) {
    try {
      await askOnce(workerId, page);
      await page.waitForTimeout(500);
    } catch (err) {
      if (shared.abort) return;
      throw err;
    }
  }
}

function attachWebSocketLogging(page, wsLogger, wsHarRecorder, workerId) {
  if (!wsLogger) return;
  const label = `W${workerId}`;
  const writeLines = (lines) => logWsLines(wsLogger, label, lines);

  page.on('request', (req) => {
    const headers = req.headers();
    const upgrade = headers?.upgrade || headers?.Upgrade || '';
    const hasWsKey = Boolean(headers?.['sec-websocket-key'] || headers?.['Sec-WebSocket-Key']);
    if (req.resourceType() === 'websocket' || String(upgrade).toLowerCase() === 'websocket' || hasWsKey) {
      writeLines([
        `WS REQ ${req.url()}`,
        `WS REQ HEADERS ${JSON.stringify(headers, null, 2)}`,
      ]);
      wsHarRecorder?.recordRequest(req.url(), headers);
    }
  });

  page.on('response', (res) => {
    const req = res.request();
    const headers = res.headers();
    const upgrade = headers?.upgrade || headers?.Upgrade || '';
    const hasWsAccept = Boolean(headers?.['sec-websocket-accept'] || headers?.['Sec-WebSocket-Accept']);
    if (req.resourceType() === 'websocket' || String(upgrade).toLowerCase() === 'websocket' || hasWsAccept) {
      writeLines([
        `WS RESP ${res.url()} status=${res.status()}`,
        `WS RESP HEADERS ${JSON.stringify(headers, null, 2)}`,
      ]);
      wsHarRecorder?.recordResponse(res.url(), res.status(), headers);
    }
  });

  page.on('websocket', (ws) => {
    writeLines([`WS OPEN ${ws.url()}`]);
    wsHarRecorder?.attachWebSocket(ws, ws.url());
    ws.on('framesent', (frame) => {
      const payload = formatWsPayload(frame.payload);

      const payloadLines = payload.text.split('\n').map((line) => `  ${line}`);
      writeLines([
        `WS SENT ${ws.url()} encoding=${payload.encoding}`,
        ...payloadLines,
      ]);
      wsHarRecorder?.recordFrame(ws, 'send', frame.payload);
    });
    ws.on('framereceived', (frame) => {
      const payload = formatWsPayload(frame.payload);

      const payloadLines = payload.text.split('\n').map((line) => `  ${line}`);
      writeLines([
        `WS RECV ${ws.url()} encoding=${payload.encoding}`,
        ...payloadLines,
      ]);
      wsHarRecorder?.recordFrame(ws, 'receive', frame.payload);
    });
    ws.on('close', () => {
      writeLines([`WS CLOSE ${ws.url()}`]);
      wsHarRecorder?.recordClose(ws);
    });
  });
}

(async () => {
  const userDataDir = './.pw-profile';

  const envHeadless = process.env.HEADLESS;
  const LOGIN_ONLY = String(process.env.LOGIN_ONLY || '').toLowerCase() === '1'
    || String(process.env.LOGIN_ONLY || '').toLowerCase() === 'true';
  const AUTH_CHECK_ONLY = String(process.env.AUTH_CHECK_ONLY || '').toLowerCase() === '1'
    || String(process.env.AUTH_CHECK_ONLY || '').toLowerCase() === 'true';
  // Toggle this to false for the first run so you can complete SSO interactively.
  const HEADLESS = AUTH_CHECK_ONLY
    ? true
    : LOGIN_ONLY
      ? false
      : envHeadless
        ? envHeadless.toLowerCase() !== 'false'
        : true;

  const shared = { abort: false };
  let ctx = null;
  let shuttingDown = false;
  let sigintRequested = false;
  const enableArtifacts = !LOGIN_ONLY && !AUTH_CHECK_ONLY;
  const wsLogger = enableArtifacts ? createWsLogger() : null;
  const wsHarRecorder = enableArtifacts ? createWsHarRecorder() : null;

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shared.abort = true;

    if (reason) {
      out(`[INFO] Shutting down: ${reason}`);
    }

    const existedBefore = enableArtifacts && fs.existsSync(HAR_TEMP_PATH);
    if (enableArtifacts) {
      out(`[INFO] HAR temp exists before close: ${existedBefore}`);
    }

    if (ctx) {
      await ctx.close().catch((err) => {
        out(`[WARN] Context close failed: ${err?.message || err}`);
      });
    }

    if (enableArtifacts) {
      const existedAfter = fs.existsSync(HAR_TEMP_PATH);
      out(`[INFO] HAR temp exists after close: ${existedAfter}`);

      const harPath = await finalizeHarFile();
      if (harPath) {
        out(`[INFO] HAR saved: ${harPath}`);
      }

      const wsLogPath = await finalizeWsLog(wsLogger);
      if (wsLogPath) {
        out(`[INFO] WS log saved: ${wsLogPath}`);
      }

      const wsHarPath = finalizeWsHarLike(wsHarRecorder);
      if (wsHarPath) {
        out(`[INFO] WS HAR-like JSON saved: ${wsHarPath}`);
      }
    }

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {}
    }

    await closeConsoleLog();
  };

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', async (chunk) => {
      if (chunk.includes(3)) {
        process.exitCode = 130;
        sigintRequested = true;
        await shutdown('SIGINT');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(process.exitCode);
      }
    });
  } else {
    process.once('SIGINT', async () => {
      process.exitCode = 130;
      sigintRequested = true;
      await shutdown('SIGINT');
    });
  }

  try {
    if (enableArtifacts) {
      out(`[INFO] HAR temp path: ${HAR_TEMP_PATH}`);
    }

    if (LOGIN_ONLY) {
      out('[INFO] LOGIN_ONLY enabled. A browser will open for SSO; the script will exit after login.');
    }
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: HEADLESS,
      viewport: { width: 1280, height: 800 },
      recordHar: enableArtifacts ? { path: HAR_TEMP_PATH, content: 'omit' } : undefined,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    if (AUTH_CHECK_ONLY) {
      const page = await ctx.newPage();
      const loginRequired = await ensureCopilotReady(page, true, true);
      if (loginRequired) {
        out('[INFO] Auth check: login required.');
        await shutdown('auth-check:login-required');
        process.exit(2);
      }
      out('[INFO] Auth check: existing session valid.');
      await shutdown('auth-check:ok');
      process.exit(0);
    }

    if (LOGIN_ONLY) {
      const page = await ctx.newPage();
      attachWebSocketLogging(page, wsLogger, wsHarRecorder, 0);
      await ensureCopilotReady(page, false, false);
      out('[INFO] Login complete. Closing browser and exiting.');
      await shutdown('login-only');
      process.exit(0);
    }

    const workers = Array.from({ length: PARALLELISM }, (_, idx) =>
      askLoop(idx + 1, ctx, shared, HEADLESS, wsLogger, wsHarRecorder)
    );
    await Promise.all(workers);
  } catch (e) {
    const msg = e?.message ? e.message : String(e);
    out(`[ERROR] ${msg}`);
    process.exitCode = 1;
    await shutdown('failure');
    process.exit(1);
  } finally {
    if (!shuttingDown) {
      await shutdown('finalize');
    }
  }
})();