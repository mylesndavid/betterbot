import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import config, { defaults, userConfigPath } from '../../config.js';
import { listCredentials, setCredential, removeCredential } from '../credentials.js';
import { Session } from '../session.js';
import { listContexts } from '../context.js';
import { getDailySoFar } from '../journal.js';
import { runHeartbeat } from '../heartbeat.js';
import { listSkills } from '../skills.js';
import { listCustomTools } from '../custom-tools.js';
import { listCronJobs } from '../crons.js';
import { checkCapabilities } from '../capabilities.js';
import { gatewayState, reloadHeartbeatInterval } from '../gateway.js';

// --- Helpers ---

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function parseJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadUserOverrides() {
  try {
    return JSON.parse(readFileSync(userConfigPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveUserOverrides(overrides) {
  const dir = dirname(userConfigPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(userConfigPath, JSON.stringify(overrides, null, 2), 'utf-8');
}

// --- Heartbeat state ---

const heartbeatStatePath = `${config.dataDir}/heartbeat-state.json`;

function loadHeartbeatState() {
  try {
    return JSON.parse(readFileSync(heartbeatStatePath, 'utf-8'));
  } catch {
    return { lastRun: null };
  }
}

// --- Active sessions for chat ---

const activeSessions = new Map();

// --- Session stats helper ---

function computeSessionStats(messages) {
  let totalChars = 0;
  let toolCalls = 0;
  const toolNames = {};

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') totalChars += (block.text || '').length;
        else if (block.type === 'tool_use') {
          toolCalls++;
          toolNames[block.name] = (toolNames[block.name] || 0) + 1;
          totalChars += JSON.stringify(block.input || {}).length;
        } else if (block.type === 'tool_result') {
          totalChars += String(block.content || '').length;
        }
      }
    }
    // OpenAI format
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCalls++;
        const name = tc.function?.name || tc.name || '?';
        toolNames[name] = (toolNames[name] || 0) + 1;
      }
    }
  }

  return { totalChars, estTokens: Math.ceil(totalChars / 4), toolCalls, toolNames };
}

// --- Route handler ---

export async function handleAPI(req, res, pathname) {
  try {
    // GET /api/status — dashboard data
    if (pathname === '/api/status' && req.method === 'GET') {
      const [sessions, contexts, creds, journal, skills, customTools, crons] = await Promise.all([
        Session.list(),
        listContexts(),
        listCredentials(),
        getDailySoFar(),
        listSkills(),
        listCustomTools(),
        listCronJobs(),
      ]);
      const hbState = loadHeartbeatState();
      return json(res, {
        sessions: sessions.length,
        contexts: contexts.length,
        credentials: creds,
        skills: skills.length,
        customTools: customTools.length,
        crons: { total: crons.length, enabled: crons.filter(c => c.enabled).length },
        gateway: {
          running: gatewayState.running,
          startedAt: gatewayState.startedAt,
          heartbeatInterval: gatewayState.heartbeatIntervalMs / 60000,
          lastHeartbeat: gatewayState.lastHeartbeat,
          heartbeatCount: gatewayState.heartbeatCount,
        },
        heartbeat: {
          lastRun: hbState.lastRun,
          intervalMinutes: config.heartbeat?.intervalMinutes || 15,
        },
        journal: journal || '',
      });
    }

    // GET /api/gateway — gateway status
    if (pathname === '/api/gateway' && req.method === 'GET') {
      const crons = await listCronJobs();
      return json(res, {
        running: gatewayState.running,
        startedAt: gatewayState.startedAt,
        pid: process.pid,
        uptime: gatewayState.startedAt ? Math.floor((Date.now() - new Date(gatewayState.startedAt).getTime()) / 1000) : 0,
        heartbeat: {
          intervalMinutes: gatewayState.heartbeatIntervalMs / 60000,
          lastRun: gatewayState.lastHeartbeat,
          count: gatewayState.heartbeatCount,
        },
        crons: {
          total: crons.length,
          enabled: crons.filter(c => c.enabled).length,
          lastCheck: gatewayState.lastCronCheck,
          runCount: gatewayState.cronRunCount,
        },
        telegram: !!gatewayState.telegramStop,
      });
    }

    // GET /api/browse?path= — directory browser
    if (pathname === '/api/browse' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      let browsePath = url.searchParams.get('path') || homedir();
      browsePath = browsePath.replace(/^~/, homedir());

      try {
        const entries = readdirSync(browsePath)
          .filter(name => {
            if (name.startsWith('.')) return false;
            try { return statSync(join(browsePath, name)).isDirectory(); }
            catch { return false; }
          })
          .sort()
          .slice(0, 50)
          .map(name => ({ name, path: join(browsePath, name) }));

        const home = homedir();
        const bookmarks = [
          { label: 'Home', path: home },
          { label: 'Documents', path: join(home, 'Documents') },
          { label: 'Desktop', path: join(home, 'Desktop') },
          { label: 'iCloud Drive', path: join(home, 'Library/Mobile Documents') },
          { label: 'iCloud Obsidian', path: join(home, 'Library/Mobile Documents/iCloud~md~obsidian/Documents') },
        ].filter(b => existsSync(b.path));

        return json(res, {
          current: browsePath,
          parent: dirname(browsePath),
          entries,
          bookmarks,
        });
      } catch {
        return error(res, 'Cannot read directory', 400);
      }
    }

    // GET /api/config
    if (pathname === '/api/config' && req.method === 'GET') {
      const overrides = loadUserOverrides();
      return json(res, { defaults, overrides, current: config });
    }

    // POST /api/config — save config AND hot-reload gateway
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseJSON(req);
      const overrides = loadUserOverrides();
      for (const key of Object.keys(body)) {
        if (body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) {
          overrides[key] = { ...(overrides[key] || {}), ...body[key] };
        } else {
          overrides[key] = body[key];
        }
      }
      saveUserOverrides(overrides);

      // Hot-reload: if heartbeat interval changed, update the running gateway
      if (body.heartbeat?.intervalMinutes && gatewayState.running) {
        reloadHeartbeatInterval(body.heartbeat.intervalMinutes);
      }

      return json(res, { ok: true, overrides });
    }

    // GET /api/creds
    if (pathname === '/api/creds' && req.method === 'GET') {
      const creds = await listCredentials();
      return json(res, creds);
    }

    // POST /api/creds/:name
    if (pathname.startsWith('/api/creds/') && req.method === 'POST') {
      const name = pathname.slice('/api/creds/'.length);
      const body = await parseJSON(req);
      if (!body.value) return error(res, 'Missing value');
      await setCredential(name, body.value);
      return json(res, { ok: true, name });
    }

    // DELETE /api/creds/:name
    if (pathname.startsWith('/api/creds/') && req.method === 'DELETE') {
      const name = pathname.slice('/api/creds/'.length);
      await removeCredential(name);
      return json(res, { ok: true, name });
    }

    // GET /api/skills
    if (pathname === '/api/skills' && req.method === 'GET') {
      const skills = await listSkills();
      return json(res, skills);
    }

    // GET /api/custom-tools
    if (pathname === '/api/custom-tools' && req.method === 'GET') {
      const tools = await listCustomTools();
      return json(res, tools);
    }

    // GET /api/crons
    if (pathname === '/api/crons' && req.method === 'GET') {
      const crons = await listCronJobs();
      return json(res, crons);
    }

    // GET /api/capabilities
    if (pathname === '/api/capabilities' && req.method === 'GET') {
      const caps = await checkCapabilities();
      return json(res, caps);
    }

    // POST /api/heartbeat/run — run heartbeat now
    if (pathname === '/api/heartbeat/run' && req.method === 'POST') {
      const result = await runHeartbeat();
      return json(res, result);
    }

    // GET /api/sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = await Session.list();
      // Enrich with stats (read each session's messages for tool call counts)
      const enriched = [];
      for (const s of sessions) {
        try {
          const raw = await readFile(join(config.sessionsDir, `${s.id}.json`), 'utf-8');
          const data = JSON.parse(raw);
          const stats = computeSessionStats(data.messages || []);
          const cost = data.metadata?.cost || null;
          enriched.push({ ...s, stats, cost });
        } catch {
          enriched.push(s);
        }
      }
      return json(res, enriched);
    }

    // GET /api/contexts
    if (pathname === '/api/contexts' && req.method === 'GET') {
      const contexts = await listContexts();
      return json(res, contexts);
    }

    // POST /api/chat/new — create new session
    if (pathname === '/api/chat/new' && req.method === 'POST') {
      const session = new Session();
      await session.init();
      activeSessions.set(session.id, session);
      return json(res, { id: session.id });
    }

    // POST /api/chat/context — load/unload context
    if (pathname === '/api/chat/context' && req.method === 'POST') {
      const body = await parseJSON(req);
      const session = activeSessions.get(body.sessionId);
      if (!session) return error(res, 'Session not found', 404);
      if (body.action === 'load') {
        await session.loadContext(body.name);
      } else if (body.action === 'unload') {
        await session.unloadContext(body.name);
      }
      await session.save();
      return json(res, { ok: true, contexts: session.contexts });
    }

    // POST /api/chat — send message, stream response via SSE
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await parseJSON(req);
      let session = activeSessions.get(body.sessionId);

      if (!session && body.sessionId) {
        try {
          session = await Session.resume(body.sessionId);
          activeSessions.set(session.id, session);
        } catch {
          return error(res, 'Session not found', 404);
        }
      }
      if (!session) return error(res, 'No session. Create one first.', 400);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      try {
        for await (const event of session.sendStream(body.message)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      }
      res.end();
      return;
    }

    // GET /api/sessions/:id — full session message history with stats
    if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = pathname.slice('/api/sessions/'.length);
      // Path traversal guard
      if (id.includes('/') || id.includes('..') || id.includes('\\')) {
        return error(res, 'Invalid session ID', 400);
      }
      const sessionPath = join(config.sessionsDir, `${id}.json`);
      try {
        const raw = await readFile(sessionPath, 'utf-8');
        const session = JSON.parse(raw);
        // Also try to load history archive
        const historyPath = join(config.sessionsDir, `${id}.history.jsonl`);
        let history = [];
        try {
          const histRaw = await readFile(historyPath, 'utf-8');
          history = histRaw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        } catch {}
        // Compute stats
        const allMsgs = [...history, ...(session.messages || [])];
        const stats = computeSessionStats(allMsgs);
        const cost = session.metadata?.cost || null;
        return json(res, { ...session, history, stats, cost });
      } catch {
        return error(res, 'Session not found', 404);
      }
    }

    // GET /api/heartbeat/audit — heartbeat audit log
    if (pathname === '/api/heartbeat/audit' && req.method === 'GET') {
      const auditPath = join(config.dataDir, 'heartbeat-audit.json');
      try {
        const raw = await readFile(auditPath, 'utf-8');
        return json(res, JSON.parse(raw));
      } catch {
        return json(res, []);
      }
    }

    // GET /api/costs — cost log (daily spend, 30 days)
    if (pathname === '/api/costs' && req.method === 'GET') {
      const costPath = join(config.dataDir, 'cost-log.json');
      try {
        const raw = await readFile(costPath, 'utf-8');
        const all = JSON.parse(raw);
        // Return last 30 days, sorted newest first
        const entries = Object.entries(all)
          .sort(([a], [b]) => b.localeCompare(a))
          .slice(0, 30)
          .map(([date, data]) => ({ date, ...data }));
        return json(res, entries);
      } catch {
        return json(res, []);
      }
    }

    // GET /api/gateway/log — live gateway activity ring buffer
    if (pathname === '/api/gateway/log' && req.method === 'GET') {
      const log = (gatewayState.log || []).map(entry => ({
        time: entry.time.toISOString(),
        text: entry.text,
      }));
      return json(res, log);
    }

    // 404
    error(res, 'Not found', 404);

  } catch (err) {
    error(res, err.message, 500);
  }
}
