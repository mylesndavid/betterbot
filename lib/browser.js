// Zero-dependency Chrome DevTools Protocol client
// Uses WebSocket (Node 22+ built-in, or undici fallback) and child_process to launch Chrome
// Supports ARIA snapshots for text-based browsing (no vision model needed)

import { spawn } from 'node:child_process';
import { platform, homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';

// WebSocket: built-in on Node 22+, fallback to undici on Node 20-21
let WS = globalThis.WebSocket;
if (!WS) {
  try {
    const undici = await import('undici');
    WS = undici.WebSocket;
  } catch {
    // Will error at browser launch time with a clear message
  }
}

// ──────────────────────────────────────────────────────────
// Find Chrome binary
// ──────────────────────────────────────────────────────────

const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findChrome() {
  const paths = CHROME_PATHS[platform()] || [];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// CDP Client
// ──────────────────────────────────────────────────────────

class CDPClient {
  constructor(ws) {
    this._ws = ws;
    this._id = 0;
    this._callbacks = new Map();

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this._callbacks.has(msg.id)) {
        const { resolve, reject } = this._callbacks.get(msg.id);
        this._callbacks.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._callbacks.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    this._ws.close();
  }
}

// ──────────────────────────────────────────────────────────
// AX Tree → ARIA Snapshot converter
// ──────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
]);

const SKIP_ROLES = new Set([
  'none', 'presentation', 'InlineTextBox', 'LineBreak',
  'StaticText', 'RootWebArea', 'ignored',
]);

/**
 * Convert CDP accessibility tree to Playwright-style ARIA snapshot text.
 * Returns { snapshot, refMap } where refMap maps ref IDs to backendDOMNodeIds.
 */
function axTreeToSnapshot(nodes) {
  if (!nodes || nodes.length === 0) return { snapshot: '', refMap: new Map() };

  // Build parent→children map
  const childMap = new Map();
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.parentId != null) {
      if (!childMap.has(node.parentId)) childMap.set(node.parentId, []);
      childMap.get(node.parentId).push(node.nodeId);
    }
  }

  const refMap = new Map(); // ref string → backendDOMNodeId
  let refCounter = 0;
  const lines = [];

  function renderNode(nodeId, depth) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value || '';
    const name = node.name?.value || '';
    const children = childMap.get(nodeId) || [];

    // Always skip InlineTextBox (leaf-level rendering detail)
    if (role === 'InlineTextBox' || role === 'LineBreak') return;

    // Skip roles that don't produce output, but always recurse into children
    if (SKIP_ROLES.has(role) || role === 'none') {
      for (const cid of children) renderNode(cid, depth);
      return;
    }

    // Map CDP roles to standard ARIA roles
    const mappedRole = mapRole(role);
    if (!mappedRole) {
      for (const cid of children) renderNode(cid, depth);
      return;
    }

    // Skip ignored nodes that aren't structural parents
    if (node.ignored && children.length === 0) return;

    const indent = '  '.repeat(depth);
    let ref = '';

    // Assign refs to interactive elements and content with names
    if (INTERACTIVE_ROLES.has(mappedRole) || (name && mappedRole !== 'generic' && mappedRole !== 'text')) {
      refCounter++;
      const refId = `e${refCounter}`;
      ref = ` [ref=${refId}]`;
      if (node.backendDOMNodeId) {
        refMap.set(refId, node.backendDOMNodeId);
      }
    }

    const nameStr = name ? ` "${name}"` : '';
    lines.push(`${indent}- ${mappedRole}${nameStr}${ref}`);

    for (const cid of children) {
      renderNode(cid, depth + 1);
    }
  }

  // Find root node (first node, or node with no parent)
  const root = nodes.find(n => n.parentId == null) || nodes[0];
  if (root) {
    const children = childMap.get(root.nodeId) || [];
    for (const cid of children) {
      renderNode(cid, 0);
    }
  }

  return { snapshot: lines.join('\n'), refMap };
}

function mapRole(cdpRole) {
  const map = {
    'button': 'button', 'link': 'link', 'textbox': 'textbox', 'TextField': 'textbox',
    'checkbox': 'checkbox', 'radio': 'radio', 'combobox': 'combobox',
    'listbox': 'listbox', 'menuitem': 'menuitem', 'option': 'option',
    'searchbox': 'searchbox', 'slider': 'slider', 'spinbutton': 'spinbutton',
    'switch': 'switch', 'tab': 'tab', 'treeitem': 'treeitem',
    'heading': 'heading', 'cell': 'cell', 'gridcell': 'gridcell',
    'columnheader': 'columnheader', 'rowheader': 'rowheader',
    'listitem': 'listitem', 'article': 'article', 'region': 'region',
    'main': 'main', 'navigation': 'navigation', 'dialog': 'dialog',
    'document': 'document', 'group': 'group', 'list': 'list',
    'table': 'table', 'row': 'row', 'generic': 'generic',
    'text': 'text', 'strong': 'strong', 'emphasis': 'emphasis',
    'paragraph': 'text', 'Section': 'region', 'WebArea': 'document',
    'banner': 'banner', 'contentinfo': 'contentinfo',
    'complementary': 'region', 'form': 'group', 'search': 'searchbox',
    'img': 'img', 'image': 'img', 'figure': 'figure',
    'menu': 'menu', 'menubar': 'menubar', 'toolbar': 'toolbar',
    'tablist': 'tablist', 'tree': 'tree', 'grid': 'grid',
    'rowgroup': 'rowgroup', 'status': 'status', 'alert': 'alert',
    'separator': 'separator', 'progressbar': 'progressbar',
  };
  return map[cdpRole] || null;
}

// ──────────────────────────────────────────────────────────
// Browser session
// ──────────────────────────────────────────────────────────

export class Browser {
  constructor() {
    this._process = null;
    this._cdp = null;
    this._port = 9222 + Math.floor(Math.random() * 1000);
    this._refMap = new Map(); // ref → backendDOMNodeId (updated on each snapshot)
  }

  async launch(opts = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found. Install Chrome or run: claw setup browser');

    const browserConfig = config.browser || {};
    const headless = opts.headless ?? browserConfig.headless ?? true;
    const useProfile = opts.useProfile ?? browserConfig.useProfile ?? false;

    const args = [
      `--remote-debugging-port=${this._port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,900',
    ];

    if (headless) {
      args.push('--headless=new');
    }

    if (useProfile) {
      const chromeProfile = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default');
      if (existsSync(chromeProfile)) {
        this._tempProfile = join(tmpdir(), `betterbot-chrome-${this._port}`);
        mkdirSync(join(this._tempProfile, 'Default'), { recursive: true });
        for (const file of ['Cookies', 'Login Data', 'Web Data', 'Local State']) {
          const src = join(chromeProfile, file);
          if (existsSync(src)) {
            try { cpSync(src, join(this._tempProfile, 'Default', file)); } catch {}
          }
        }
        const parentState = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Local State');
        if (existsSync(parentState)) {
          try { cpSync(parentState, join(this._tempProfile, 'Local State')); } catch {}
        }
        args.push(`--user-data-dir=${this._tempProfile}`);
      }
    }

    args.push('about:blank');

    this._process = spawn(chromePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    await this._waitForDebugger();

    const targets = await this._getTargets();
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('No page target found');

    if (!WS) throw new Error('WebSocket not available. Upgrade to Node 22+ or install the "undici" package.');
    const ws = new WS(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    this._cdp = new CDPClient(ws);

    await this._cdp.send('Page.enable');
    await this._cdp.send('Runtime.enable');
    await this._cdp.send('DOM.enable');
    await this._cdp.send('Accessibility.enable');

    return this;
  }

  async _waitForLoad(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await this._cdp.send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (result.result.value === 'complete') {
          await new Promise(r => setTimeout(r, 2000));
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async _waitForDebugger(retries = 30) {
    for (let i = 0; i < retries; i++) {
      try {
        await this._getTargets();
        return;
      } catch {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    throw new Error('Chrome debugger did not start');
  }

  async _getTargets() {
    const res = await fetch(`http://127.0.0.1:${this._port}/json`);
    return await res.json();
  }

  // ── ARIA Snapshot ──

  /**
   * Get the page's ARIA snapshot as optimized text.
   * Returns { snapshot, refMap } where snapshot is the text tree
   * and refMap maps ref IDs (e1, e2, ...) to backendDOMNodeIds.
   */
  async getSnapshot() {
    const { optimizeAll } = await import('./browser/snapshot-optimizer.js');

    const result = await this._cdp.send('Accessibility.getFullAXTree');
    const { snapshot, refMap } = axTreeToSnapshot(result.nodes);

    this._refMap = refMap;

    // Run through the optimizer pipeline
    const optimized = optimizeAll(snapshot, { maxItems: 15 });
    return optimized;
  }

  // ── Actions ──

  async navigate(url) {
    await this._cdp.send('Page.navigate', { url });
    await this._waitForLoad();
    return `Navigated to ${url}`;
  }

  /**
   * Click an element by its ref ID (e.g. "e5").
   * Resolves the ref to a DOM node and clicks its center.
   */
  async clickRef(ref) {
    const backendNodeId = this._refMap.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref: ${ref}. Available refs: ${[...this._refMap.keys()].slice(0, 10).join(', ')}...`);
    }

    // Resolve backendNodeId to a RemoteObject
    const { object } = await this._cdp.send('DOM.resolveNode', { backendNodeId });

    // Scroll element into view and get its bounding box
    const { model } = await this._cdp.send('DOM.getBoxModel', { backendNodeId });
    if (!model) {
      // Fallback: use JS to scroll into view and get rect
      const evalResult = await this._cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center' });
          const r = this.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        }`,
        returnByValue: true,
      });
      const pos = JSON.parse(evalResult.result.value);
      return await this.click(pos.x, pos.y);
    }

    // model.content is [x1,y1, x2,y2, x3,y3, x4,y4] — compute center
    const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
    const cx = (x1 + x2 + x3 + x4) / 4;
    const cy = (y1 + y2 + y3 + y4) / 4;

    // Scroll into view first
    await this._cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center' }); }`,
    });
    await new Promise(r => setTimeout(r, 200));

    // Re-get box model after scroll
    try {
      const { model: m2 } = await this._cdp.send('DOM.getBoxModel', { backendNodeId });
      if (m2) {
        const [a1, b1, a2, b2, a3, b3, a4, b4] = m2.content;
        const x = (a1 + a2 + a3 + a4) / 4;
        const y = (b1 + b2 + b3 + b4) / 4;
        return await this.click(x, y);
      }
    } catch {}

    return await this.click(cx, cy);
  }

  /**
   * Fill a textbox identified by ref.
   * Focuses the element, clears it, then types the text.
   */
  async fillRef(ref, text) {
    const backendNodeId = this._refMap.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref: ${ref}`);
    }

    const { object } = await this._cdp.send('DOM.resolveNode', { backendNodeId });

    // Focus and clear the element
    await this._cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center' });
        this.focus();
        this.value = '';
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }`,
    });
    await new Promise(r => setTimeout(r, 100));

    // Type the text
    await this.type(text);
    return `Filled ref=${ref} with "${text.slice(0, 50)}"`;
  }

  async click(x, y) {
    await this._cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await this._cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 500));
    return `Clicked at (${Math.round(x)}, ${Math.round(y)})`;
  }

  async type(text) {
    for (const char of text) {
      await this._cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char,
      });
      await this._cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
      });
    }
    return `Typed: "${text.slice(0, 50)}"`;
  }

  async pressKey(key) {
    await this._cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key,
      code: key,
      windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0,
    });
    await this._cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key,
    });
    return `Pressed: ${key}`;
  }

  async scroll(x, y, deltaX = 0, deltaY = -300) {
    await this._cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY,
    });
    await new Promise(r => setTimeout(r, 500));
    return `Scrolled`;
  }

  async screenshot() {
    const result = await this._cdp.send('Page.captureScreenshot', {
      format: 'png',
      quality: 80,
    });
    return result.data;
  }

  async extractText() {
    const result = await this._cdp.send('Runtime.evaluate', {
      expression: 'document.body.innerText',
      returnByValue: true,
    });
    return result.result.value || '';
  }

  async getURL() {
    const result = await this._cdp.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    return result.result.value || '';
  }

  async evaluate(expression) {
    const result = await this._cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluation error');
    }
    return result.result.value;
  }

  async close() {
    if (this._cdp) {
      try { await this._cdp.close(); } catch {}
    }
    if (this._process) {
      this._process.kill();
      this._process = null;
    }
    if (this._tempProfile && existsSync(this._tempProfile)) {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(this._tempProfile, { recursive: true, force: true });
      } catch {}
    }
  }
}
