import { startPanel } from './panel/server.js';
import { startTelegramBot } from './channels/telegram.js';
import { runHeartbeat } from './heartbeat.js';
import { runCronTick } from './crons.js';
import { appendEntry } from './journal.js';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLIST_LABEL = 'com.betterbot.gateway';
const PLIST_PATH = join(homedir(), 'Library/LaunchAgents', `${PLIST_LABEL}.plist`);
const LOG_DIR = join(homedir(), 'Library/Logs/betterbot');
const LOG_PATH = join(LOG_DIR, 'gateway.log');
const PID_PATH = join(config.dataDir, 'gateway.pid');

// Shared gateway state — accessible from the API for hot-reload
export const gatewayState = {
  running: false,
  startedAt: null,
  heartbeatTimer: null,
  heartbeatIntervalMs: 0,
  cronTimer: null,
  telegramStop: null,
  server: null,
  lastHeartbeat: null,
  heartbeatCount: 0,
  lastCronCheck: null,
  cronRunCount: 0,
  // TUI state
  log: [],
  telegramBotName: null,
  port: null,
  cronJobCount: 0,
  lastHeartbeatResult: null,
  onUpdate: null,
  _runHeartbeat: null,
  _runCronTick: null,
};

const MAX_LOG_ENTRIES = 50;

function logEvent(text) {
  gatewayState.log.push({ time: new Date(), text });
  if (gatewayState.log.length > MAX_LOG_ENTRIES) {
    gatewayState.log.shift();
  }
  gatewayState.onUpdate?.();
  // Always log to console when not a TTY (LaunchAgent → log file)
  if (!process.stdout.isTTY) {
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    console.log(`[${ts}] ${text}`);
  }
}

let heartbeatRunning = false;
async function runHeartbeatTick() {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  try {
    const result = await runHeartbeat();
    gatewayState.lastHeartbeat = new Date().toISOString();
    gatewayState.heartbeatCount++;
    gatewayState.lastHeartbeatResult = result;
    if (result.events > 0) {
      logEvent(`Heartbeat: ${result.events} events, ${result.actions.length} actions`);
      for (const a of result.actions) {
        logEvent(`  [${a.action}] ${a.event}`);
      }
    } else {
      logEvent(`Heartbeat: 0 events`);
    }
  } catch (err) {
    logEvent(`Heartbeat error: ${err.message}`);
  } finally {
    heartbeatRunning = false;
  }
  gatewayState.onUpdate?.();
}

async function runCronTickSafe() {
  try {
    const results = await runCronTick();
    gatewayState.lastCronCheck = new Date().toISOString();
    if (results.length > 0) {
      gatewayState.cronRunCount += results.length;
      for (const r of results) {
        logEvent(`Cron "${r.name}" fired: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      }
    }
    // Update cron job count for TUI display
    try {
      const { listCronJobs } = await import('./crons.js');
      const jobs = await listCronJobs();
      gatewayState.cronJobCount = jobs.filter(j => j.enabled).length;
    } catch {}
  } catch (err) {
    logEvent(`Cron tick error: ${err.message}`);
  }
  gatewayState.onUpdate?.();
}

// Hot-reload heartbeat interval (called from API when config changes)
export function reloadHeartbeatInterval(intervalMinutes) {
  if (gatewayState.heartbeatTimer) {
    clearInterval(gatewayState.heartbeatTimer);
  }
  const ms = (intervalMinutes || 15) * 60 * 1000;
  gatewayState.heartbeatIntervalMs = ms;
  gatewayState.heartbeatTimer = setInterval(runHeartbeatTick, ms);
  logEvent(`Heartbeat: interval changed to ${intervalMinutes}m`);
}

// Migrate ~/.betterclaw → ~/.betterbot (one-time)
async function migrateDataDir() {
  const oldDir = join(homedir(), '.betterclaw');
  const newDir = config.dataDir; // ~/.betterbot
  if (!existsSync(oldDir) || existsSync(join(oldDir, '.migrated'))) return;

  const { readdirSync, cpSync, symlinkSync } = await import('node:fs');
  mkdirSync(newDir, { recursive: true });

  // Copy everything from old to new (don't overwrite existing)
  for (const entry of readdirSync(oldDir)) {
    const src = join(oldDir, entry);
    const dest = join(newDir, entry);
    if (!existsSync(dest)) {
      try { cpSync(src, dest, { recursive: true }); } catch {}
    }
  }

  // Mark as migrated
  writeFileSync(join(oldDir, '.migrated'), new Date().toISOString());
  logEvent('Migrated data from ~/.betterclaw → ~/.betterbot');
}

export async function startGateway(opts = {}) {
  const port = opts.port || 3333;
  gatewayState.port = port;

  logEvent('Gateway starting...');

  // One-time data migration
  try { await migrateDataDir(); } catch {}

  // Check for an existing running gateway
  mkdirSync(config.dataDir, { recursive: true });
  try {
    const existingPid = parseInt(readFileSync(PID_PATH, 'utf-8').trim());
    if (existingPid && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // check if alive (signal 0 = no-op)
        logEvent(`Killing stale gateway (PID ${existingPid})...`);
        process.kill(existingPid, 'SIGTERM');
        // Brief pause to let old process release Telegram polling
        await new Promise(r => setTimeout(r, 2000));
      } catch {
        // Process not running — stale PID file, fine
      }
    }
  } catch { /* no PID file */ }

  // Write PID file
  writeFileSync(PID_PATH, String(process.pid));

  // 1. Start HTTP panel (no browser open in gateway mode)
  gatewayState.server = startPanel({ port, noBrowser: true, onLog: logEvent });
  logEvent(`Panel: http://localhost:${port}`);

  // 2. Start Telegram bot (if token configured)
  try {
    gatewayState.telegramStop = await startTelegramBot();
    gatewayState.telegramBotName = gatewayState.telegramStop.botName || null;
    logEvent(`Telegram: connected${gatewayState.telegramBotName ? ` (@${gatewayState.telegramBotName})` : ''}`);
  } catch (err) {
    logEvent(`Telegram: skipped (${err.message})`);
  }

  // 3. Start heartbeat timer
  const intervalMinutes = config.heartbeat?.intervalMinutes || 15;
  const heartbeatMs = intervalMinutes * 60 * 1000;
  gatewayState.heartbeatIntervalMs = heartbeatMs;
  gatewayState.heartbeatTimer = setInterval(runHeartbeatTick, heartbeatMs);

  // Expose runners for TUI keyboard shortcuts
  gatewayState._runHeartbeat = runHeartbeatTick;
  gatewayState._runCronTick = runCronTickSafe;

  // Run initial heartbeat after a short delay
  setTimeout(runHeartbeatTick, 5000);

  // 4. Start cron scheduler — checks every 60 seconds
  gatewayState.cronTimer = setInterval(runCronTickSafe, 60 * 1000);
  // First cron check after 10s (after heartbeat)
  setTimeout(runCronTickSafe, 10000);

  gatewayState.running = true;
  gatewayState.startedAt = new Date().toISOString();

  // Get initial cron job count
  try {
    const { listCronJobs } = await import('./crons.js');
    const jobs = await listCronJobs();
    gatewayState.cronJobCount = jobs.filter(j => j.enabled).length;
  } catch {}

  logEvent(`Heartbeat: every ${intervalMinutes}m`);
  logEvent('Crons: checking every 60s');
  logEvent('Gateway started');

  // No journal entry for gateway start/stop — avoid clutter

  // Start TUI if running interactively
  if (process.stdout.isTTY) {
    try {
      // Redirect console.log/error through logEvent so stray output
      // from Telegram, heartbeat, etc. goes into the activity log
      // instead of corrupting the TUI
      const origLog = console.log.bind(console);
      const origErr = console.error.bind(console);
      console.log = (...args) => logEvent(args.join(' '));
      console.error = (...args) => logEvent(args.join(' '));

      const { startGatewayTUI } = await import('./gateway-tui.js');
      startGatewayTUI(gatewayState);
    } catch (err) {
      // TUI failed to load — fall back to plain output
      console.log('Gateway running. Press Ctrl+C to stop.');
    }
  } else {
    console.log('Gateway running (non-interactive mode).');
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    // Stop TUI first to restore terminal
    if (process.stdout.isTTY) {
      try {
        const { stopTUI } = await import('./gateway-tui.js');
        stopTUI();
      } catch {}
    }
    logEvent(`Shutting down (${signal})...`);
    clearInterval(gatewayState.heartbeatTimer);
    clearInterval(gatewayState.cronTimer);
    if (gatewayState.telegramStop) gatewayState.telegramStop();
    if (gatewayState.server) gatewayState.server.close();
    try { unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export function installLaunchAgent() {
  let nodePath;
  try {
    nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    nodePath = process.execPath;
  }

  const clawPath = join(__dirname, '..', 'bin', 'betterbot');
  mkdirSync(LOG_DIR, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>--use-system-ca</string>
    <string>${clawPath}</string>
    <string>gateway</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;

  const launchAgentsDir = join(homedir(), 'Library/LaunchAgents');
  mkdirSync(launchAgentsDir, { recursive: true });
  writeFileSync(PLIST_PATH, plist);

  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {}
  execSync(`launchctl load "${PLIST_PATH}"`);

  console.log('LaunchAgent installed:');
  console.log(`  Plist: ${PLIST_PATH}`);
  console.log(`  Logs:  ${LOG_PATH}`);
  console.log('Gateway will start on login and auto-restart if it crashes.');
}

export function uninstallLaunchAgent() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {}

  try {
    unlinkSync(PLIST_PATH);
    console.log('LaunchAgent removed.');
  } catch {
    console.log('LaunchAgent was not installed.');
  }
}

export function gatewayStatus() {
  let pid = null;
  try {
    pid = readFileSync(PID_PATH, 'utf-8').trim();
  } catch {}

  if (pid) {
    try {
      process.kill(Number(pid), 0);
      console.log(`Gateway is running (PID ${pid})`);
    } catch {
      console.log('Gateway is not running (stale PID file)');
    }
  } else {
    console.log('Gateway is not running');
  }

  if (existsSync(PLIST_PATH)) {
    console.log(`LaunchAgent: installed (${PLIST_PATH})`);
  } else {
    console.log('LaunchAgent: not installed');
  }
}

export function gatewayLogs() {
  if (!existsSync(LOG_PATH)) {
    console.log('No gateway logs found.');
    console.log(`Expected at: ${LOG_PATH}`);
    return;
  }

  try {
    execSync(`tail -50 "${LOG_PATH}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Error reading logs: ${err.message}`);
  }
}
