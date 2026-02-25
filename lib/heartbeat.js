import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { findRecent, search } from './search.js';
import { getDailySoFar, appendEntry, ensureDaily } from './journal.js';
import { createProvider } from './provider.js';
import { Session } from './session.js';
import config from '../config.js';

const STATE_FILE = join(config.dataDir, 'heartbeat-state.json');

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  } catch {
    return { lastRun: null, lastInboxCheck: null, seenGitHub: [], handledEvents: {} };
  }
}

// Simple hash for event dedup
function eventKey(summary) {
  const normalized = summary.toLowerCase().replace(/\d{1,2}:\d{2}/g, '').trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// Annotate events with their handling history so the triage model can decide
function localDateStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function annotateEvents(events, state) {
  if (!state.handledEvents) state.handledEvents = {};
  const today = localDateStr();

  for (const event of events) {
    const key = eventKey(event.summary);
    const prev = state.handledEvents[key];
    if (prev && prev.date === today) {
      event._prior = prev; // attach history for triage context
    }
  }
}

// Check if there are any genuinely new events (not just retries)
function hasNewContext(events) {
  return events.some(e => !e._prior);
}

// Mark events as handled
function markHandled(items, state, outcome, reason) {
  if (!state.handledEvents) state.handledEvents = {};
  const today = localDateStr();

  for (const item of items) {
    const summary = item.summary || item.event || String(item);
    const key = eventKey(summary);
    const prev = state.handledEvents[key];
    state.handledEvents[key] = {
      date: today,
      outcome,
      reason: reason || prev?.reason,
      attempts: (prev?.attempts || 0) + 1,
      lastAttempt: new Date().toISOString(),
    };
  }

  // Prune entries older than today
  for (const [k, v] of Object.entries(state.handledEvents)) {
    if (v.date !== today) delete state.handledEvents[k];
  }
}

async function saveState(state) {
  if (!existsSync(config.dataDir)) {
    await mkdir(config.dataDir, { recursive: true });
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// Check for new files in inbox
async function checkInbox(state) {
  const inboxDir = join(config.vault, config.para.inbox);
  const minutesSinceLastCheck = state.lastInboxCheck
    ? (Date.now() - new Date(state.lastInboxCheck).getTime()) / 60000
    : 60;

  const newFiles = await findRecent(inboxDir, Math.ceil(minutesSinceLastCheck));
  return newFiles.map(f => ({
    type: 'inbox',
    summary: `New file: ${f.file.split('/').pop()}`,
    path: f.file,
  }));
}

// Check daily note for open tasks
// Supports routing tags: #main (escalate directly), #act (ACT directly)
async function checkTasks() {
  const daily = await getDailySoFar();
  if (!daily) return [];

  const tasks = [];
  const taskRegex = /- \[ \] (.+)/g;
  let match;
  while ((match = taskRegex.exec(daily)) !== null) {
    const text = match[1];
    // Parse routing tags
    let route = null;
    let cleanText = text;
    const tagMatch = text.match(/#(main|act|escalate)\b/i);
    if (tagMatch) {
      route = tagMatch[1].toLowerCase();
      if (route === 'escalate') route = 'main'; // alias
      cleanText = text.replace(/#(main|act|escalate)\s*/i, '').trim();
    }
    tasks.push({
      type: 'task',
      summary: `Open task: ${cleanText}`,
      originalText: text, // preserve for checkbox marking
      route, // null = normal triage, 'main' = skip to escalation, 'act' = skip to ACT
    });
  }
  return tasks;
}

// Check off a task in the daily journal (- [ ] → - [x])
async function checkOffTask(originalText) {
  const { dailyPath } = await import('./journal.js');
  const path = dailyPath();
  try {
    let content = await readFile(path, 'utf-8');
    const unchecked = `- [ ] ${originalText}`;
    const checked = `- [x] ${originalText}`;
    if (content.includes(unchecked)) {
      content = content.replace(unchecked, checked);
      await writeFile(path, content, 'utf-8');
    }
  } catch { /* non-fatal */ }
}

// Check GitHub notifications (if gh CLI available)
// Returns only NEW notifications not seen in previous heartbeats
async function checkGitHub(state) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { stdout } = await exec('gh', ['api', 'notifications', '--jq', '.[] | .id + "|" + .subject.title'], {
      timeout: 10000,
    });

    const seenSet = new Set(state.seenGitHub || []);
    const allNotifs = stdout.trim().split('\n').filter(Boolean).map(line => {
      const pipe = line.indexOf('|');
      return { id: line.slice(0, pipe), title: line.slice(pipe + 1) };
    });

    // Filter to only unseen notifications
    const newNotifs = allNotifs.filter(n => !seenSet.has(n.id));

    // Update seen set (keep last 200 to prevent unbounded growth)
    const allIds = allNotifs.map(n => n.id);
    state.seenGitHub = allIds.slice(-200);

    return newNotifs.slice(0, 10).map(n => ({
      type: 'github',
      summary: `GitHub: ${n.title}`,
      _id: n.id,
    }));
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════
// TIER 1: Cheap triage — router model, no tools, ~512 tokens
// Classifies events into IGNORE / LOG / ALERT / ACT / ESCALATE
// ══════════════════════════════════════════════════════════

async function triageEvents(events) {
  if (events.length === 0) return [];

  let provider;
  try {
    provider = createProvider('router');
  } catch {
    provider = createProvider('quick');
  }

  const eventList = events.map(e => {
    let line = `- [${e.type}] ${e.summary}`;
    if (e._prior) {
      line += ` [PREVIOUSLY ${e._prior.outcome.toUpperCase()}: ${e._prior.reason || 'no details'} — attempt #${e._prior.attempts}]`;
    }
    return line;
  }).join('\n');

  const result = await provider.chat([
    {
      role: 'system',
      content: `Classify events. Respond ONLY with a JSON array.
Each item: {"event":"...","action":"IGNORE|LOG|ALERT|ACT|ESCALATE","reason":"..."}

IGNORE = noise, not worth tracking. Also use for previously attempted events where nothing has changed.
LOG = worth noting in the journal, no action needed
ALERT = notify user immediately (macOS notification)
ACT = needs a lightweight agent to handle it (file an inbox item, check something, simple task)
ESCALATE = needs full agent with conversation history (complex, multi-step, references past context, or critical)

For [idle] events: the user hasn't been in touch for a while. Consider whether there's something genuinely useful to say — a goal follow-up, something from the journal to check on, a warm check-in, or interesting news. If the user profile is thin or empty, ACT to start building it — the agent can't be useful without knowing the user. Otherwise, IGNORE is fine most of the time.

Events marked [PREVIOUSLY ...] were already attempted. IGNORE them UNLESS new events in this batch suggest the situation has changed (e.g. a new email arrived that might unblock a waiting task, a new file appeared, etc.). Use your judgment.`
    },
    { role: 'user', content: eventList },
  ], { maxTokens: 512 });

  try {
    const jsonMatch = result.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch { /* parse error */ }

  return events.map(e => ({ event: e.summary, action: 'LOG', reason: 'triage fallback' }));
}

// ══════════════════════════════════════════════════════════
// TIER 2: Lightweight agent — disposable session with tools + daily note
// No session history. Handles the task and gets thrown away.
// Uses quick model to keep costs low.
// ══════════════════════════════════════════════════════════

async function actOnEvents(actEvents) {
  const actions = [];
  const failedEvents = [];

  // Get today's daily note for context
  const daily = await getDailySoFar();
  const dailyContext = daily
    ? `\n\nToday's journal so far:\n${daily.replace(/^---[\s\S]*?---\s*/, '').slice(0, 2000)}`
    : '';

  // Batch all ACT items into one disposable session
  const eventList = actEvents.map(e => `- ${e.event} (${e.reason})`).join('\n');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  // Fresh session — no history, uses quick model
  const session = new Session({ role: 'quick' });
  await session.init();

  // Check if this batch includes idle events — if so, add proactive guidance
  const hasIdleEvent = actEvents.some(e => e.event.includes('No user contact'));

  const p = config.para;
  const idleGuidance = hasIdleEvent ? `

IDLE CHECK-IN — You have downtime. Pick ONE of these based on what feels right:

a) **Share something interesting**: Use web_search to find recent news, launches, or developments related to the user's interests or industry. If you find something genuinely cool, notify_user() with a brief take + link. "Did you see OpenAI launched X today?" is the vibe. Don't send generic news — make it specific to what they care about.

b) **Build the user profile**: Use recall() to review what you know about the user. If it's thin, ask them a low-pressure question via notify_user() — "Hey, random one — what podcasts are you into lately?" or "What's the project you're most excited about right now?" Store what you learn with remember(). The goal is to know them well enough that (a) gets better over time.

c) **Warm check-in**: If the journal shows they were stressed, had a big day, or mentioned something specific, follow up on that. "How'd that meeting go?" > "Hey, how are you?"

d) **Do nothing**: If you don't have anything genuinely useful to say, that's fine. Don't force it. Silence is better than noise.

CRITICAL:
- You MUST call notify_user() to send the message — the user can't see your text responses, only tool calls reach them.
- You MUST call remember() to store anything you learned about the user (interests, projects, preferences, context). If you read their files and learned something, remember it. This is how you get smarter over time.
- Only send ONE notify_user() per idle check-in.` : '';

  const prompt = `HEARTBEAT — ${timeStr}

Events to handle:
${eventList}
${dailyContext}${idleGuidance}

RULES:
1. Try to handle these with your tools. Give it a real shot.
2. Be HONEST about results. If a search returns nothing, say so. If a tool errors, say so. If you don't have access to something, say so. NEVER claim you did something you didn't.
3. If you can't complete a task — respond with ESCALATE: followed by what you tried and why it didn't work. This hands it to the full agent who has more context and capabilities.
4. Do NOT create journal tasks that already exist — the heartbeat manages task checkboxes automatically. Only journal genuinely new findings to the Notes section.
5. Do NOT spawn sub-agents — if you need that level of help, escalate.
6. Vault folders: ${p.inbox}/, ${p.projects}/, ${p.resources}/, ${config.dailyNotesDir}/. Use these paths when writing files. Use remember() for persistent knowledge (goes to the graph, not the vault).`;

  let responseText = '';
  let toolErrors = 0;
  const auditLog = []; // Raw record of what actually happened

  for await (const event of session.sendStream(prompt)) {
    if (event.type === 'text') {
      responseText += event.text;
    } else if (event.type === 'tool_start') {
      const call = `${event.name}(${Object.values(event.arguments || {}).join(', ').slice(0, 80)})`;
      actions.push({ action: 'act_tool', event: call });
      auditLog.push({ tool: event.name, args: event.arguments, result: null });
    } else if (event.type === 'tool_result') {
      const r = (event.result || '');
      // Attach result to the last audit entry
      if (auditLog.length > 0) {
        auditLog[auditLog.length - 1].result = r.slice(0, 500);
      }
      const rl = r.toLowerCase();
      if (rl.startsWith('error') || rl.includes('not found') || rl.includes('failed') || rl.includes('no such file')) {
        toolErrors++;
      }
    }
  }

  // Write audit log to disk so the full agent can review what ACT actually did
  if (auditLog.length > 0) {
    const auditPath = join(config.dataDir, 'heartbeat-audit.json');
    let existing = [];
    try { existing = JSON.parse(await readFile(auditPath, 'utf-8')); } catch {}
    existing.push({
      timestamp: now.toISOString(),
      tier: 'ACT',
      model: config.models?.quick?.model || 'quick',
      events: actEvents.map(e => e.event),
      toolCalls: auditLog,
      response: responseText.slice(0, 500),
      toolErrors,
    });
    // Keep last 50 entries
    if (existing.length > 50) existing = existing.slice(-50);
    await writeFile(auditPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  if (responseText.trim()) {
    actions.push({ action: 'acted', event: responseText.slice(0, 200) });
  }

  // If the agent reported ESCALATE or tools had errors, bubble up for escalation
  const needsEscalation = responseText.includes('ESCALATE:') || toolErrors > 0;
  if (needsEscalation) {
    const failureContext = responseText.includes('ESCALATE:')
      ? responseText.split('ESCALATE:').slice(1).join('; ').trim()
      : `${toolErrors} tool error(s) during ACT`;
    for (const e of actEvents) {
      failedEvents.push({ event: e.event, reason: `ACT failed: ${failureContext.slice(0, 200)}` });
    }
  }

  // Session is not saved — it's disposable
  return { actions, failedEvents };
}

// ══════════════════════════════════════════════════════════
// TIER 3: Full agent — persistent session with history + tools
// Only for things that truly need ongoing context.
// Uses default model. Session persists across heartbeats.
// ══════════════════════════════════════════════════════════

async function escalateToAgent(escalatedEvents) {
  const sessionIdFile = join(config.dataDir, 'heartbeat-session-id');
  let session;

  // Resume persistent heartbeat session
  try {
    const sessionId = (await readFile(sessionIdFile, 'utf-8')).trim();
    session = await Session.resume(sessionId);
  } catch {
    session = new Session({ role: 'default' });
    await session.init();
    if (!existsSync(config.dataDir)) await mkdir(config.dataDir, { recursive: true });
    await writeFile(sessionIdFile, session.id, 'utf-8');
  }

  const eventList = escalatedEvents.map(e => `- ${e.event} (${e.reason})`).join('\n');
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  const prompt = `HEARTBEAT ESCALATION — ${timeStr}

These events were escalated because a lightweight agent couldn't handle them:

${eventList}

A quick agent already tried and failed. You have full tools, context, and sub-agents.
- Try to handle what you can.
- ALWAYS notify_user() with a summary of what you did and any decisions needed. The user expects to know when you act autonomously.
- Do NOT create journal tasks that already exist — the heartbeat manages task checkboxes automatically. Only add NEW follow-up tasks if genuinely new work is discovered.
- Log important results to the journal Notes section. Don't log noise.`;

  const actions = [];
  let responseText = '';

  for await (const event of session.sendStream(prompt)) {
    if (event.type === 'text') {
      responseText += event.text;
    } else if (event.type === 'tool_start') {
      actions.push({ action: 'escalate_tool', event: `${event.name}(${Object.values(event.arguments || {}).join(', ').slice(0, 50)})` });
    }
  }

  if (responseText.trim()) {
    actions.push({ action: 'escalated', event: responseText.slice(0, 200) });
  }

  return actions;
}

// ══════════════════════════════════════════════════════════
// Main heartbeat loop
// ══════════════════════════════════════════════════════════

export async function runHeartbeat() {
  // Run doctor first — validates tools, cleans quarantine, ensures dirs exist
  try {
    const { runDoctorHeadless } = await import('./doctor.js');
    await runDoctorHeadless();
  } catch {}

  // Ensure today's daily note exists (creates from template if not)
  await ensureDaily();

  const state = await loadState();
  const events = [];

  const sources = config.heartbeat.sources;

  if (sources.includes('inbox')) {
    events.push(...await checkInbox(state));
  }
  if (sources.includes('tasks')) {
    events.push(...await checkTasks());
  }
  if (sources.includes('github')) {
    events.push(...await checkGitHub(state));
  }

  // Idle awareness — give triage a chance to think even when nothing happened
  if (events.length === 0 && config.heartbeat?.proactive !== false) {
    const lastContact = state.lastUserContact ? new Date(state.lastUserContact) : null;
    if (lastContact) {
      const hoursSinceContact = (Date.now() - lastContact.getTime()) / 3600000;
      const hour = new Date().getHours();
      const isWakingHours = hour >= 9 && hour <= 21;

      if (isWakingHours && hoursSinceContact > 2) {
        const daily = await getDailySoFar();
        const journalSnippet = daily
          ? daily.replace(/^---[\s\S]*?---\s*/, '').slice(0, 500)
          : '(no journal entries today)';

        // Pull user profile context from knowledge graph (cheap — just a file read)
        let profileContext = '';
        try {
          const graphRaw = await readFile(join(config.dataDir, 'graph', 'graph.json'), 'utf-8');
          const graph = JSON.parse(graphRaw);
          const bits = [];
          for (const [, attrs] of Object.entries(graph.nodes || {})) {
            if (attrs.type === 'person') bits.push(`Person: ${attrs.name}`);
            else if (attrs.type === 'preference') bits.push(`Preference: ${attrs.text || attrs.name}`);
            else if (attrs.type === 'entity') bits.push(`Interest/Entity: ${attrs.name}`);
            else if (attrs.type === 'memory') bits.push(`Memory: ${attrs.name} — ${(attrs.text || '').slice(0, 100)}`);
          }
          if (bits.length > 0) profileContext = `\nUser profile: ${bits.join('; ')}`;
        } catch {}

        // Count meaningful profile nodes (persons, preferences, memories — not sessions/entities)
        let profileDepth = 0;
        try {
          const graphRaw2 = await readFile(join(config.dataDir, 'graph', 'graph.json'), 'utf-8');
          const g = JSON.parse(graphRaw2);
          for (const [, a] of Object.entries(g.nodes || {})) {
            if (['person', 'preference', 'memory'].includes(a.type)) profileDepth++;
          }
        } catch {}

        events.push({
          type: 'idle',
          summary: `No user contact in ${Math.round(hoursSinceContact)} hours. Today's journal: ${journalSnippet}${profileContext}`,
          // Skip triage and go straight to ACT when profile is thin — can't be useful without knowing the user
          route: profileDepth < 5 ? 'act' : null,
        });
      }
    }
  }

  // Nothing → silent exit
  if (events.length === 0) {
    state.lastRun = new Date().toISOString();
    state.lastInboxCheck = new Date().toISOString();
    await saveState(state);
    return { events: 0, actions: [] };
  }

  // Split out pre-routed events (tagged with #main, #act) from events needing triage
  const preRouted = events.filter(e => e.route);
  const needsTriage = events.filter(e => !e.route);

  // Annotate ALL events with handling history
  annotateEvents(events, state);

  // Pre-routed events that were already handled today get skipped too
  const freshPreRouted = preRouted.filter(e => !e._prior);

  // If nothing new anywhere, skip entirely
  if (freshPreRouted.length === 0 && !hasNewContext(needsTriage)) {
    state.lastRun = new Date().toISOString();
    state.lastInboxCheck = new Date().toISOString();
    await saveState(state);
    return { events: 0, skipped: events.length, actions: [] };
  }

  const actions = [];
  const toAct = [];
  const toEscalate = [];

  // Pre-routed events skip triage entirely
  for (const event of freshPreRouted) {
    const item = { event: event.summary, reason: `routed via #${event.route} tag` };
    if (event.route === 'main') {
      toEscalate.push(item);
    } else if (event.route === 'act') {
      toAct.push(item);
    }
  }

  // TIER 1: Cheap triage for remaining events
  const triaged = needsTriage.length > 0 ? await triageEvents(needsTriage) : [];

  for (const item of triaged) {
    switch (item.action) {
      case 'IGNORE':
      case 'LOG':
        markHandled([item], state, 'ignored', item.reason);
        actions.push({ action: 'ignored', event: item.event });
        break;

      case 'ALERT': {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const exec = promisify(execFile);
          await exec('osascript', ['-e', `display notification "${item.event.replace(/"/g, '\\"')}" with title "${config.agentName}"`]);
        } catch { /* notification failed */ }
        markHandled([item], state, 'alerted', item.reason);
        actions.push({ action: 'alerted', event: item.event });
        break;
      }

      case 'ACT':
        toAct.push(item);
        break;

      case 'ESCALATE':
        toEscalate.push(item);
        break;

      default:
        // Unknown action — just ignore, don't journal
        actions.push({ action: 'ignored', event: item.event });
    }
  }

  // TIER 2: Lightweight disposable agent (quick model, has tools + daily note, no history)
  if (toAct.length > 0) {
    try {
      const { actions: actActions, failedEvents } = await actOnEvents(toAct);
      actions.push(...actActions);
      markHandled(toAct, state, 'acted', 'handled by ACT agent');
      // If ACT had failures, escalate them to the full agent
      if (failedEvents.length > 0) {
        toEscalate.push(...failedEvents);
      }
    } catch (err) {
      // Whole ACT session crashed — escalate everything
      markHandled(toAct, state, 'act_crashed', err.message);
      for (const item of toAct) {
        toEscalate.push({ event: item.event, reason: `ACT crashed: ${err.message}` });
      }
      actions.push({ action: 'error', event: err.message });
    }
  }

  // TIER 3: Full agent (default model, persistent session, full context)
  if (toEscalate.length > 0) {
    try {
      const escalatedActions = await escalateToAgent(toEscalate);
      actions.push(...escalatedActions);
      markHandled(toEscalate, state, 'escalated', 'handled by full agent');
    } catch (err) {
      markHandled(toEscalate, state, 'escalation_failed', err.message);
      await appendEntry(`Escalation failed: ${err.message}`, 'Notes');
      actions.push({ action: 'error', event: err.message });
    }
  }

  // Check off handled tasks in the journal so they don't get re-picked up
  const handledTaskEvents = [...toAct, ...toEscalate];
  for (const item of handledTaskEvents) {
    // Find the original event to get originalText
    const source = events.find(e => e.originalText && item.event.includes(e.summary.replace('Open task: ', '')));
    if (source?.originalText) {
      await checkOffTask(source.originalText);
    }
  }

  // If an idle event was acted on, reset the contact timer so we don't re-trigger
  const idleWasHandled = events.some(e => e.type === 'idle') &&
    [...toAct, ...toEscalate].some(item => item.event.includes('No user contact'));
  if (idleWasHandled) {
    state.lastUserContact = new Date().toISOString();
  }

  state.lastRun = new Date().toISOString();
  state.lastInboxCheck = new Date().toISOString();
  await saveState(state);

  return { events: events.length, actions };
}
