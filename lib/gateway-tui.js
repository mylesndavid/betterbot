// Gateway TUI Dashboard — live-updating terminal UI for interactive use
// Raw ANSI, no dependencies. Falls back to plain logging when not a TTY.

const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const moveTo = (r, c) => `${ESC}${r};${c}H`;

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const write = s => process.stdout.write(s);

function getTermSize() {
  return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

function padRight(str, len) {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, len - stripped.length);
  return str + ' '.repeat(pad);
}

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(totalSec % 60).padStart(2, '0')}s`;
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return 'never';
  const diff = Date.now() - new Date(isoStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

let state = null;
let uptimeInterval = null;
let renderScheduled = false;

// View mode: 'dashboard' or 'logs'
let viewMode = 'dashboard';
let logScrollOffset = 0;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  // Batch renders to avoid flickering on rapid updates
  setImmediate(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!state) return;
  if (viewMode === 'logs') {
    renderLogsView();
  } else {
    renderDashboard();
  }
}

function renderDashboard() {
  const { rows, cols } = getTermSize();
  const w = Math.min(cols, 80);
  const pad = 2;

  write(CLEAR + HIDE_CURSOR);

  // Header
  const uptime = state.startedAt
    ? formatUptime(Date.now() - new Date(state.startedAt).getTime())
    : '...';
  const title = `${c.bold} BetterClaw Gateway${c.reset}`;
  const uptimeStr = `${c.dim}\u25b2 ${uptime}${c.reset}`;
  // Title left, uptime right
  write(moveTo(1, pad) + title);
  write(moveTo(1, cols - uptime.length - 3) + uptimeStr);

  // Separator
  write(moveTo(2, pad) + c.dim + '\u2500'.repeat(w - 2) + c.reset);

  // Services
  let row = 4;

  // Panel
  const panelStatus = state.server
    ? `${c.green}\u2713${c.reset} :${state.port || '3333'}`
    : `${c.dim}\u2013 off${c.reset}`;
  write(moveTo(row, pad + 1) + padRight(`Panel`, 17) + panelStatus);
  row++;

  // Telegram
  const tgStatus = state.telegramStop
    ? `${c.green}\u2713${c.reset} ${state.telegramBotName ? '@' + state.telegramBotName : 'connected'}`
    : `${c.dim}\u2013 off${c.reset}`;
  write(moveTo(row, pad + 1) + padRight(`Telegram`, 17) + tgStatus);
  row++;

  // Heartbeat
  const hbIntervalMin = Math.round(state.heartbeatIntervalMs / 60000);
  const hbLast = formatTimeAgo(state.lastHeartbeat);
  const hbStatus = state.heartbeatTimer
    ? `${c.green}\u2713${c.reset} every ${hbIntervalMin}m  ${c.dim}\u00b7${c.reset}  #${state.heartbeatCount}  ${c.dim}\u00b7${c.reset}  last ${hbLast}`
    : `${c.dim}\u2013 off${c.reset}`;
  write(moveTo(row, pad + 1) + padRight(`Heartbeat`, 17) + hbStatus);
  row++;

  // Crons
  const cronJobCount = state.cronJobCount || 0;
  const cronLast = formatTimeAgo(state.lastCronCheck);
  const cronStatus = state.cronTimer
    ? `${c.green}\u2713${c.reset} ${cronJobCount} jobs  ${c.dim}\u00b7${c.reset}  #${state.cronRunCount}  ${c.dim}\u00b7${c.reset}  last ${cronLast}`
    : `${c.dim}\u2013 off${c.reset}`;
  write(moveTo(row, pad + 1) + padRight(`Crons`, 17) + cronStatus);
  row++;

  // Separator + Activity header
  row++;
  write(moveTo(row, pad) + c.dim + '\u2500'.repeat(w - 2) + c.reset);
  row++;
  write(moveTo(row, pad + 1) + `${c.bold}Activity${c.reset}`);
  row++;
  write(moveTo(row, pad) + c.dim + '\u2500'.repeat(w - 2) + c.reset);
  row++;

  // Activity log — fill remaining space minus footer
  const logAreaHeight = rows - row - 2;
  const log = state.log || [];
  const visibleLog = log.slice(-Math.max(0, logAreaHeight));

  for (let i = 0; i < logAreaHeight; i++) {
    const entry = visibleLog[i];
    if (entry) {
      const time = `${c.dim}${formatTime(entry.time)}${c.reset}`;
      // Indent sub-entries (lines starting with spaces or brackets)
      const text = entry.text.startsWith('  ')
        ? `${c.dim}${entry.text}${c.reset}`
        : entry.text;
      const line = `${time}  ${text}`;
      write(moveTo(row + i, pad + 1) + padRight(line, w - 4));
    } else {
      write(moveTo(row + i, pad + 1) + ' '.repeat(w - 4));
    }
  }

  // Footer
  write(moveTo(rows, pad) + c.dim + padRight(
    '  q quit \u00b7 r heartbeat \u00b7 c crons \u00b7 l logs',
    w - 2
  ) + c.reset);
}

function renderLogsView() {
  const { rows, cols } = getTermSize();
  const w = Math.min(cols, 120);
  const pad = 2;

  write(CLEAR + HIDE_CURSOR);

  // Header
  write(moveTo(1, pad) + `${c.bold} Gateway Logs${c.reset}`);
  const log = state.log || [];
  const countStr = `${c.dim}${log.length} entries${c.reset}`;
  write(moveTo(1, cols - log.length.toString().length - 10) + countStr);

  // Separator
  write(moveTo(2, pad) + c.dim + '\u2500'.repeat(w - 2) + c.reset);

  // Log area — full height minus header (2) and footer (2)
  const logAreaHeight = rows - 4;
  const maxOffset = Math.max(0, log.length - logAreaHeight);
  // Clamp scroll offset
  if (logScrollOffset > maxOffset) logScrollOffset = maxOffset;
  if (logScrollOffset < 0) logScrollOffset = 0;

  const visibleLog = log.slice(logScrollOffset, logScrollOffset + logAreaHeight);

  for (let i = 0; i < logAreaHeight; i++) {
    const entry = visibleLog[i];
    const lineRow = 3 + i;
    if (entry) {
      const time = `${c.dim}${formatTime(entry.time)}${c.reset}`;
      const text = entry.text.startsWith('  ')
        ? `${c.dim}${entry.text}${c.reset}`
        : entry.text;
      const line = `${time}  ${text}`;
      write(moveTo(lineRow, pad + 1) + padRight(line, w - 4));
    } else {
      write(moveTo(lineRow, pad + 1) + ' '.repeat(w - 4));
    }
  }

  // Scroll indicator
  const scrollInfo = log.length > logAreaHeight
    ? ` ${logScrollOffset + 1}-${Math.min(logScrollOffset + logAreaHeight, log.length)} of ${log.length}`
    : '';

  // Footer
  write(moveTo(rows, pad) + c.dim + padRight(
    `  esc/l back \u00b7 \u2191\u2193 scroll \u00b7 home/end jump${scrollInfo}`,
    w - 2
  ) + c.reset);
}

function handleKeypress(buf) {
  const key = buf.toString();

  if (key === 'q' || key === '\x03') {
    // Graceful shutdown — send SIGINT to trigger the existing handler
    stopTUI();
    process.kill(process.pid, 'SIGINT');
    return;
  }

  // Toggle logs view
  if (key === 'l') {
    if (viewMode === 'logs') {
      viewMode = 'dashboard';
    } else {
      viewMode = 'logs';
      // Start scrolled to bottom
      const log = state?.log || [];
      const { rows } = getTermSize();
      const logAreaHeight = rows - 4;
      logScrollOffset = Math.max(0, log.length - logAreaHeight);
    }
    scheduleRender();
    return;
  }

  // Escape returns to dashboard from logs
  if (key === '\x1b' && viewMode === 'logs') {
    viewMode = 'dashboard';
    scheduleRender();
    return;
  }

  // Arrow keys in logs view
  if (viewMode === 'logs') {
    // Up arrow: \x1b[A
    if (key === '\x1b[A') {
      logScrollOffset = Math.max(0, logScrollOffset - 1);
      scheduleRender();
      return;
    }
    // Down arrow: \x1b[B
    if (key === '\x1b[B') {
      logScrollOffset++;
      scheduleRender();
      return;
    }
    // Page Up: \x1b[5~
    if (key === '\x1b[5~') {
      const { rows } = getTermSize();
      logScrollOffset = Math.max(0, logScrollOffset - (rows - 4));
      scheduleRender();
      return;
    }
    // Page Down: \x1b[6~
    if (key === '\x1b[6~') {
      const { rows } = getTermSize();
      logScrollOffset += rows - 4;
      scheduleRender();
      return;
    }
    // Home: \x1b[H or \x1b[1~
    if (key === '\x1b[H' || key === '\x1b[1~') {
      logScrollOffset = 0;
      scheduleRender();
      return;
    }
    // End: \x1b[F or \x1b[4~
    if (key === '\x1b[F' || key === '\x1b[4~') {
      const log = state?.log || [];
      const { rows } = getTermSize();
      logScrollOffset = Math.max(0, log.length - (rows - 4));
      scheduleRender();
      return;
    }
    return; // Consume other keys in logs view
  }

  if (key === 'r') {
    // Force heartbeat — call the exposed runner if available
    if (state?._runHeartbeat) {
      state._runHeartbeat();
    }
    return;
  }

  if (key === 'c') {
    // Force cron tick
    if (state?._runCronTick) {
      state._runCronTick();
    }
    return;
  }
}

export function startGatewayTUI(gatewayState) {
  state = gatewayState;

  // Set up the onUpdate callback
  state.onUpdate = scheduleRender;

  // Raw mode for keyboard input
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleKeypress);
  }

  // Uptime counter — re-render every second
  uptimeInterval = setInterval(scheduleRender, 1000);

  // Re-render on terminal resize
  process.stdout.on('resize', scheduleRender);

  // Initial render
  render();
}

export function stopTUI() {
  if (uptimeInterval) {
    clearInterval(uptimeInterval);
    uptimeInterval = null;
  }

  if (process.stdin.setRawMode) {
    process.stdin.removeListener('data', handleKeypress);
    process.stdin.setRawMode(false);
  }

  process.stdout.removeListener('resize', scheduleRender);

  write(SHOW_CURSOR + CLEAR);
  state = null;
  viewMode = 'dashboard';
  logScrollOffset = 0;
}
