import { readFile, writeFile, readdir, stat, rename, unlink, rm } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { search, findRecent } from './search.js';
import { appendEntry, getDailySoFar, quickJournal } from './journal.js';
import { listContexts, loadContext } from './context.js';
import { spawnAgent } from './agent.js';
import { checkEmail, readEmail, sendEmail } from './email.js';
import { setCredential, getCredential } from './credentials.js';
import { loadCustomTools, getCustomTools, createCustomTool, deleteCustomTool, listCustomTools, readCustomToolSource, setBuiltinNames } from './custom-tools.js';
import { listSkills, readSkill, writeSkill, deleteSkill } from './skills.js';
import { createCron, listCronJobs, updateCron, enableCron, disableCron, deleteCron, describeCron } from './crons.js';
import { notifyUser } from './notify.js';
import { webSearch } from './web-search.js';
import { remember, recall, listMemories } from './memories.js';
import { formatBudgetStatus } from './cost-tracker.js';
import config from '../config.js';

// Resolve a path that can target vault (default) or workspace (ws:// prefix)
function resolvePath(path) {
  const p = (path || '').trim();
  if (p.startsWith('ws://')) {
    return { root: config.workspaceDir, relPath: p.slice(5).replace(/^\/+/, '') };
  }
  return { root: config.vault, relPath: p.replace(/^\/+/, '') };
}

// --- Tool definitions ---
// Each tool: { name, description, parameters (JSON Schema), execute(args, session) }

const tools = [
  {
    name: 'search_vault',
    description: 'Search the Obsidian vault for notes matching a query. Uses ripgrep for fast full-text search across all markdown files. Returns matching files with line numbers and context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (supports regex)' },
        max_results: { type: 'number', description: 'Max files to return (default 20)' },
      },
      required: ['query'],
    },
    async execute(args) {
      const results = await search(args.query, { maxResults: args.max_results || 20 });
      if (results.length === 0) return 'No matches found.';
      return results.map(r => {
        const relPath = relative(config.vault, r.file);
        const matches = r.matches.map(m => `  L${m.line}: ${m.text}`).join('\n');
        return `${relPath}\n${matches}`;
      }).join('\n\n');
    },
  },

  {
    name: 'read_file',
    description: 'Read the contents of a file. Paths are relative to the vault by default. Use "ws://path" prefix for workspace files (code, projects, builds).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative to vault, or "ws://path" for workspace' },
      },
      required: ['path'],
    },
    async execute(args) {
      const { root, relPath } = resolvePath(args.path);
      const fullPath = resolve(root, relPath);
      if (!fullPath.startsWith(resolve(root))) return 'Error: Invalid path.';
      try {
        return await readFile(fullPath, 'utf-8');
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    },
  },

  {
    name: 'write_file',
    description: 'Write or create a file. Paths are relative to the vault by default. Use "ws://path" prefix for workspace files (code, projects, builds). Use workspace for code — never write code to the vault.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative to vault, or "ws://path" for workspace' },
        content: { type: 'string', description: 'The full content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const { root, relPath } = resolvePath(args.path);
      const fullPath = resolve(root, relPath);
      if (!fullPath.startsWith(resolve(root))) return 'Error: Invalid path.';
      try {
        const { mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, args.content, 'utf-8');
        return `Written: ${args.path}`;
      } catch (err) {
        return `Error writing file: ${err.message}`;
      }
    },
  },

  {
    name: 'list_files',
    description: 'List files in a directory. Paths are relative to the vault by default. Use "ws://path" prefix for workspace directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path — relative to vault, or "ws://path" for workspace (use "ws://" for workspace root)' },
      },
      required: [],
    },
    async execute(args) {
      const { root, relPath } = resolvePath(args.path || '');
      const dirPath = resolve(root, relPath);
      if (!dirPath.startsWith(resolve(root))) return 'Error: Invalid path.';
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const lines = entries.map(e => {
          const suffix = e.isDirectory() ? '/' : '';
          return `${e.name}${suffix}`;
        });
        return lines.join('\n') || 'Empty directory.';
      } catch (err) {
        return `Error listing directory: ${err.message}`;
      }
    },
  },

  {
    name: 'delete_file',
    description: 'Delete a file or empty directory from the vault or workspace. Use "ws://path" prefix for workspace files. Be careful — this is permanent.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path — relative to vault, or "ws://path" for workspace' },
      },
      required: ['path'],
    },
    async execute(args) {
      const { root, relPath } = resolvePath(args.path);
      const fullPath = resolve(root, relPath);
      if (!fullPath.startsWith(resolve(root))) return 'Error: Invalid path.';
      if (!relPath || relPath === '.' || relPath === '/') return 'Error: Cannot delete root directory.';
      try {
        await unlink(fullPath);
        return `Deleted: ${args.path}`;
      } catch (err) {
        if (err.code === 'EISDIR') {
          try {
            await rm(fullPath, { recursive: false });
            return `Deleted directory: ${args.path}`;
          } catch (err2) {
            return `Error: ${err2.message}`;
          }
        }
        return `Error deleting file: ${err.message}`;
      }
    },
  },

  {
    name: 'move_file',
    description: 'Move or rename a file within the vault or workspace. Both paths use the same prefix rules (vault by default, "ws://" for workspace). Creates destination directories automatically.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source file path' },
        to: { type: 'string', description: 'Destination file path' },
      },
      required: ['from', 'to'],
    },
    async execute(args) {
      const src = resolvePath(args.from);
      const dst = resolvePath(args.to);
      const srcFull = resolve(src.root, src.relPath);
      const dstFull = resolve(dst.root, dst.relPath);
      if (!srcFull.startsWith(resolve(src.root))) return 'Error: Invalid source path.';
      if (!dstFull.startsWith(resolve(dst.root))) return 'Error: Invalid destination path.';
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(dstFull), { recursive: true });
        await rename(srcFull, dstFull);
        return `Moved: ${args.from} → ${args.to}`;
      } catch (err) {
        return `Error moving file: ${err.message}`;
      }
    },
  },

  {
    name: 'journal_append',
    description: "Append an entry to today's daily journal in Obsidian. Entries are timestamped automatically.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The journal entry text' },
        section: { type: 'string', description: 'Journal section to append to (default: "Notes"). Options: Notes, Tasks, Decisions. Do NOT create custom sections.' },
      },
      required: ['text'],
    },
    async execute(args) {
      const entry = await appendEntry(args.text, args.section || 'Notes');
      return `Journal entry added: ${entry}`;
    },
  },

  {
    name: 'journal_read',
    description: "Read today's daily journal. Returns the full content of today's daily note.",
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
      },
      required: [],
    },
    async execute(args) {
      const content = await getDailySoFar(args.date);
      return content || 'No journal entry for this date.';
    },
  },

  {
    name: 'find_recent_files',
    description: 'Find recently modified files in the vault (useful for checking inbox or recent activity).',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory relative to vault (default: inbox)' },
        minutes: { type: 'number', description: 'Look back this many minutes (default: 60)' },
      },
      required: [],
    },
    async execute(args) {
      const dir = args.directory ? join(config.vault, args.directory) : undefined;
      const results = await findRecent(dir, args.minutes || 60);
      if (results.length === 0) return 'No recent files found.';
      return results.map(r => {
        const relPath = relative(config.vault, r.file);
        return `${relPath} (modified ${r.modified.toLocaleTimeString()})`;
      }).join('\n');
    },
  },

  {
    name: 'list_contexts',
    description: 'List all available context files that can be loaded into the session.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      const ctxs = await listContexts();
      return ctxs.map(c => {
        const flags = [c.alwaysLoad ? 'auto-loaded' : '', c.type].filter(Boolean).join(', ');
        return `${c.name} (~${c.tokens} tokens) [${flags}]`;
      }).join('\n');
    },
  },

  {
    name: 'load_context',
    description: 'Load a context file into the current session. This adds the context to the system prompt.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Context name to load' },
      },
      required: ['name'],
    },
    async execute(args, session) {
      if (!session) return 'Error: No active session.';
      await session.loadContext(args.name);
      return `Context "${args.name}" loaded into session.`;
    },
  },

  {
    name: 'spawn_subagent',
    description: 'Spawn a sub-agent to handle a specific task autonomously. The sub-agent runs independently, completes the task, and returns results. Use for research, analysis, summarization, or any task that can be delegated.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task for the sub-agent' },
        role: { type: 'string', description: 'Model role to use: "quick" (fast/cheap), "default" (balanced), "deep" (thorough reasoning)' },
        context: { type: 'string', description: 'Additional context to provide to the sub-agent' },
      },
      required: ['task'],
    },
    async execute(args) {
      const result = await spawnAgent(args.task, {
        role: args.role || 'quick',
        additionalContext: args.context || '',
      });
      return result.content;
    },
  },

  {
    name: 'store_credential',
    description: 'Securely store a credential (API key, password, token) in the system Keychain. ALWAYS use this instead of writing secrets to files.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Credential key name (e.g. "google_app_password", "some_api_key")' },
        value: { type: 'string', description: 'The secret value to store' },
      },
      required: ['name', 'value'],
    },
    async execute(args) {
      try {
        await setCredential(args.name, args.value);
        return `Credential "${args.name}" stored securely in Keychain.`;
      } catch (err) {
        return `Error storing credential: ${err.message}`;
      }
    },
  },

  {
    name: 'get_credential',
    description: 'Retrieve a stored credential from the Keychain. Use to check if a credential is configured.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Credential key name' },
      },
      required: ['name'],
    },
    async execute(args) {
      try {
        const val = await getCredential(args.name);
        if (val) return `Credential "${args.name}" is configured (value hidden for security).`;
        return `Credential "${args.name}" is not set.`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'check_email',
    description: 'Check the inbox for recent emails. Returns a list of messages with sender, subject, date, and read status. Use this when the user asks about their email or inbox.',
    parameters: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only show unread messages (default: true)' },
        limit: { type: 'number', description: 'Max messages to return (default: 10)' },
      },
      required: [],
    },
    async execute(args) {
      try {
        const messages = await checkEmail({
          unreadOnly: args.unread_only !== false,
          limit: args.limit || 10,
        });
        if (messages.length === 0) return 'No unread emails.';
        return messages.map((m, i) => {
          const status = m.read ? '📭' : '📬';
          return `${status} #${m.seq} | ${m.from}\n   ${m.subject}\n   ${m.date}`;
        }).join('\n\n');
      } catch (err) {
        return `Email error: ${err.message}`;
      }
    },
  },

  {
    name: 'read_email',
    description: 'Read the full content of a specific email by its sequence number (from check_email results).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Email sequence number from check_email results' },
      },
      required: ['id'],
    },
    async execute(args) {
      try {
        const msg = await readEmail(args.id);
        const parts = [];
        if (msg.from) parts.push(`From: ${msg.from}`);
        if (msg.to) parts.push(`To: ${msg.to}`);
        if (msg.subject) parts.push(`Subject: ${msg.subject}`);
        if (msg.date) parts.push(`Date: ${msg.date}`);
        parts.push('---');
        parts.push(msg.body || '(empty body)');
        return parts.join('\n');
      } catch (err) {
        return `Email error: ${err.message}`;
      }
    },
  },

  {
    name: 'send_email',
    description: 'Send an email. Use when the user asks you to email someone.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'subject', 'body'],
    },
    async execute(args) {
      try {
        const result = await sendEmail(args.to, args.subject, args.body);
        return `Email sent to ${result.to}: "${result.subject}"`;
      } catch (err) {
        return `Send error: ${err.message}`;
      }
    },
  },

  // --- Notifications ---

  {
    name: 'notify_user',
    description: 'Send a notification to the user via their configured channel (Telegram, Slack, etc.). Also injects context into the channel session so if they reply, you have continuity. Use this instead of channel-specific tools like send_telegram_raw.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The notification message to send' },
      },
      required: ['message'],
    },
    async execute(args) {
      try {
        return await notifyUser(args.message);
      } catch (err) {
        return `Notification error: ${err.message}`;
      }
    },
  },

  // --- Browser ---

  {
    name: 'browse_web',
    description: 'Browse a website and perform tasks using an ARIA-snapshot sub-agent. The agent reads the page as a structured accessibility tree (not screenshots), clicks elements by ref, and tracks changes via diffs. Very cheap — no vision model needed. Use for: researching topics, filling forms, checking dashboards, reading pages that need JS rendering, or any web interaction.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL to navigate to' },
        task: { type: 'string', description: 'What to do on the page (e.g., "find the pricing info", "fill out the contact form with...", "extract the main article text")' },
      },
      required: ['url', 'task'],
    },
    async execute(args) {
      try {
        const { runBrowserTask } = await import('./browser-agent.js');
        return await runBrowserTask(args.url, args.task);
      } catch (err) {
        if (err.message.includes('Chrome not found')) {
          return 'Chrome/Chromium is required for browsing. Install Google Chrome, Chromium, or Brave Browser.';
        }
        return `Browser error: ${err.message}`;
      }
    },
  },

  // --- Skills: procedural knowledge the agent can create and reference ---

  {
    name: 'create_skill',
    description: 'Create a reusable skill — a markdown document describing how to do something. Skills persist across sessions and appear in your system prompt. Use for multi-step procedures, API workflows, checklists, or any knowledge you want to remember how to do.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (e.g. "check-paradigm-campaigns", "deploy-to-production")' },
        content: { type: 'string', description: 'Full markdown content: describe the procedure, steps, required credentials, expected outcomes, etc.' },
      },
      required: ['name', 'content'],
    },
    async execute(args) {
      try {
        const result = await writeSkill(args.name, args.content);
        return `Skill created: "${result.name}" at ${result.path}`;
      } catch (err) {
        return `Error creating skill: ${err.message}`;
      }
    },
  },

  {
    name: 'list_skills',
    description: 'List all available skills you have created.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const skills = await listSkills();
        if (skills.length === 0) return 'No skills created yet. Use create_skill to build reusable procedures.';
        return skills.map(s => `${s.name} — ${s.description || '(no description)'}`).join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'load_skill',
    description: 'Load a skill to read its full instructions. Use this when you need to follow a procedure you previously created.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to load' },
      },
      required: ['name'],
    },
    async execute(args) {
      try {
        const content = await readSkill(args.name);
        if (!content) return `Skill "${args.name}" not found. Use list_skills to see available skills.`;
        return content;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'delete_skill',
    description: 'Delete a skill that is no longer needed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to delete' },
      },
      required: ['name'],
    },
    async execute(args) {
      const deleted = await deleteSkill(args.name);
      return deleted ? `Skill "${args.name}" deleted.` : `Skill "${args.name}" not found.`;
    },
  },

  // --- Custom Tools: the agent can build its own executable tools ---

  {
    name: 'create_tool',
    description: `Create a new reusable tool — executable code that becomes a permanent tool you can call in future sessions. Use this when you need to interact with an API, automate a task, or build any capability that doesn't exist yet.

The tool file is a full ES module. You can use any Node.js built-in (import via "imports" param) and fetch().

Example — a weather tool:
  imports: "import { get } from 'node:https';"
  code: "const res = await fetch('https://api.weather.com/...');\\nconst data = await res.json();\\nreturn data.temp;"

Or provide a full module in code (must contain "export default") for full control.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name in snake_case (e.g. "check_weather", "query_notion")' },
        description: { type: 'string', description: 'What the tool does — this is shown in the tool list' },
        parameters: {
          type: 'object',
          description: 'JSON Schema for the tool parameters (type, properties, required)',
        },
        code: { type: 'string', description: 'The async execute function body (has args, session, fetch, and anything from imports). Must return a string. OR a full ES module with "export default { name, description, parameters, execute }".' },
        imports: { type: 'string', description: 'Optional ES module import statements for the top of the file. e.g. "import { connect } from \'node:tls\';"' },
      },
      required: ['name', 'description', 'parameters', 'code'],
    },
    async execute(args) {
      try {
        const result = await createCustomTool(args.name, args.description, args.parameters, args.code, args.imports);
        // Rebuild the tool map so it's immediately available
        rebuildToolMap();
        return `Tool "${result.name}" created and loaded. It's now available for use.`;
      } catch (err) {
        return `Error creating tool: ${err.message}`;
      }
    },
  },

  {
    name: 'list_custom_tools',
    description: 'List all custom tools you have created.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const tools = await listCustomTools();
        if (tools.length === 0) return 'No custom tools created yet. Use create_tool to build new capabilities.';
        return tools.map(t => `${t.name} — ${t.description} (${t.source})`).join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'view_tool_source',
    description: 'View the source code of a custom tool. Useful for debugging or updating.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to view' },
      },
      required: ['name'],
    },
    async execute(args) {
      try {
        const source = await readCustomToolSource(args.name);
        if (!source) return `Custom tool "${args.name}" not found.`;
        return source;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'delete_tool',
    description: 'Delete a custom tool that is no longer needed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to delete' },
      },
      required: ['name'],
    },
    async execute(args) {
      try {
        const deleted = await deleteCustomTool(args.name);
        if (deleted) {
          rebuildToolMap();
          return `Tool "${args.name}" deleted.`;
        }
        return `Tool "${args.name}" not found.`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  // --- Cron Jobs: the agent can schedule its own recurring tasks ---

  {
    name: 'create_cron',
    description: `Create a scheduled cron job that runs automatically at specified times. The gateway executes each cron by spawning a disposable agent that has all your tools and today's journal for context.

Cron schedule uses standard 5-field format: minute hour day-of-month month day-of-week
Examples:
  "0 9 * * *"     — every day at 9:00 AM
  "0 9 * * 1-5"   — weekdays at 9:00 AM
  "*/30 * * * *"   — every 30 minutes
  "0 8 * * 1"     — every Monday at 8:00 AM
  "0 15 * * 5"    — every Friday at 3:00 PM
  "0 9,18 * * *"  — at 9:00 AM and 6:00 PM daily

The "prompt" is what the disposable agent receives as its task. Write it like instructions: "Check my email inbox and summarize unread messages in the journal."`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name (e.g. "Morning email check", "Friday campaign report")' },
        schedule: { type: 'string', description: 'Cron expression: min hour dom month dow (e.g. "0 9 * * 1-5")' },
        prompt: { type: 'string', description: 'Task instructions for the agent that runs this cron. Be specific about what to do and where to log results.' },
      },
      required: ['name', 'schedule', 'prompt'],
    },
    async execute(args) {
      try {
        const cron = await createCron({
          name: args.name,
          schedule: args.schedule,
          prompt: args.prompt,
        });
        const desc = describeCron(cron.schedule);
        return `Cron created: "${cron.name}" (${cron.id})\nSchedule: ${cron.schedule} (${desc})\nThe gateway will run this automatically. Use list_crons to see all scheduled jobs.`;
      } catch (err) {
        return `Error creating cron: ${err.message}`;
      }
    },
  },

  {
    name: 'list_crons',
    description: 'List all scheduled cron jobs with their status, schedule, and last run time.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const crons = await listCronJobs();
        if (crons.length === 0) return 'No cron jobs scheduled. Use create_cron to set up recurring tasks.';
        return crons.map(c => {
          const status = c.enabled ? '✓' : '✗';
          const desc = describeCron(c.schedule);
          const last = c.lastRun ? `last: ${new Date(c.lastRun).toLocaleString()}` : 'never run';
          return `[${status}] ${c.name} (${c.id})\n    ${c.schedule} — ${desc}\n    ${last} · ${c.runCount || 0} runs`;
        }).join('\n\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'update_cron',
    description: 'Update an existing cron job. You can change its name, schedule, prompt, or enabled status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID (from list_crons)' },
        name: { type: 'string', description: 'New name (optional)' },
        schedule: { type: 'string', description: 'New cron schedule (optional)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        enabled: { type: 'boolean', description: 'Enable or disable (optional)' },
      },
      required: ['id'],
    },
    async execute(args) {
      try {
        const { id, ...updates } = args;
        const cron = await updateCron(id, updates);
        if (!cron) return `Cron "${id}" not found. Use list_crons to see available jobs.`;
        return `Cron "${cron.name}" (${cron.id}) updated.\nSchedule: ${cron.schedule} (${describeCron(cron.schedule)})\nEnabled: ${cron.enabled}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'enable_cron',
    description: 'Enable a disabled cron job so it starts running again.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
      },
      required: ['id'],
    },
    async execute(args) {
      const cron = await enableCron(args.id);
      if (!cron) return `Cron "${args.id}" not found.`;
      return `Cron "${cron.name}" enabled. It will run on schedule: ${cron.schedule} (${describeCron(cron.schedule)})`;
    },
  },

  {
    name: 'disable_cron',
    description: 'Disable a cron job so it stops running (but keeps the configuration for later re-enabling).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
      },
      required: ['id'],
    },
    async execute(args) {
      const cron = await disableCron(args.id);
      if (!cron) return `Cron "${args.id}" not found.`;
      return `Cron "${cron.name}" disabled. Use enable_cron to re-enable it.`;
    },
  },

  {
    name: 'delete_cron',
    description: 'Permanently delete a cron job.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron job ID' },
      },
      required: ['id'],
    },
    async execute(args) {
      const deleted = await deleteCron(args.id);
      if (!deleted) return `Cron "${args.id}" not found.`;
      return `Cron deleted.`;
    },
  },

  // --- Web Search ---

  {
    name: 'web_search',
    description: 'Search the web for current information, news, research, etc. Auto-detects which search provider is configured (Tavily, Perplexity, or Brave). Much cheaper and faster than browse_web for simple lookups.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results to return (default 5)' },
      },
      required: ['query'],
    },
    async execute(args) {
      try {
        return await webSearch(args.query, args.max_results || 5);
      } catch (err) {
        return `Search error: ${err.message}`;
      }
    },
  },

  // --- Memory ---

  {
    name: 'remember',
    description: 'Store persistent knowledge in the vault\'s Memories/ directory. Use for user preferences, project context, recurring info, or anything worth remembering across sessions. Visible in Obsidian.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Memory topic — becomes the filename (e.g. "user-preferences", "project-yapdo")' },
        content: { type: 'string', description: 'Memory content (markdown). Will overwrite existing memory for this topic.' },
      },
      required: ['topic', 'content'],
    },
    async execute(args) {
      try {
        return await remember(args.topic, args.content);
      } catch (err) {
        return `Memory error: ${err.message}`;
      }
    },
  },

  {
    name: 'recall',
    description: 'Recall a previously stored memory by topic.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Memory topic to recall' },
      },
      required: ['topic'],
    },
    async execute(args) {
      try {
        return await recall(args.topic);
      } catch (err) {
        return `Memory error: ${err.message}`;
      }
    },
  },

  {
    name: 'list_memories',
    description: 'List all stored memories with previews.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        return await listMemories();
      } catch (err) {
        return `Memory error: ${err.message}`;
      }
    },
  },

  // --- Budget ---

  {
    name: 'check_budget',
    description: 'Check today\'s API spend breakdown by model role. Shows total cost, number of calls, and per-role token usage.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        return await formatBudgetStatus();
      } catch (err) {
        return `Budget error: ${err.message}`;
      }
    },
  },

  // --- Session History ---

  {
    name: 'review_session_history',
    description: 'Review raw conversation history from a session that was compacted. Compaction archives full messages to JSONL files — this tool lets you search or browse them.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to review (from the compaction summary message)' },
        query: { type: 'string', description: 'Optional search query to filter messages (case-insensitive). If omitted, returns last 30 messages.' },
      },
      required: ['session_id'],
    },
    async execute(args) {
      try {
        const historyPath = join(config.sessionsDir, `${args.session_id}.history.jsonl`);
        let content;
        try {
          content = await readFile(historyPath, 'utf-8');
        } catch {
          return `No archived history found for session "${args.session_id}".`;
        }

        const lines = content.trim().split('\n').filter(Boolean);
        let messages = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        if (args.query) {
          const q = args.query.toLowerCase();
          messages = messages.filter(m => {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return text.toLowerCase().includes(q);
          });
        } else {
          messages = messages.slice(-30);
        }

        if (messages.length === 0) return args.query ? `No messages matching "${args.query}" in session ${args.session_id}.` : 'No archived messages found.';

        return messages.map(m => {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 500);
          return `[${m.role}] ${content.slice(0, 300)}`;
        }).join('\n\n');
      } catch (err) {
        return `History error: ${err.message}`;
      }
    },
  },

  // --- Heartbeat audit log ---

  {
    name: 'read_heartbeat_audit',
    description: 'Read the raw audit log from recent heartbeat ACT/escalation runs. Shows actual tool calls and results — use this to verify what automated agents actually did vs what they claimed in the journal.',
    parameters: {
      type: 'object',
      properties: {
        last: { type: 'number', description: 'Number of recent entries to show (default 5)' },
      },
    },
    async execute(args) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const auditPath = join(config.dataDir, 'heartbeat-audit.json');
      try {
        const entries = JSON.parse(await readFile(auditPath, 'utf-8'));
        const last = args.last || 5;
        const recent = entries.slice(-last);
        return recent.map(e => {
          const tools = e.toolCalls.map(t => `  ${t.tool}(${JSON.stringify(t.args).slice(0, 100)}) → ${(t.result || 'no result').slice(0, 150)}`).join('\n');
          return `[${e.timestamp}] ${e.tier} (${e.model}) — ${e.events.join(', ')}\nTools:\n${tools}\nErrors: ${e.toolErrors}\nResponse: ${e.response.slice(0, 200)}`;
        }).join('\n\n---\n\n');
      } catch {
        return 'No audit log found yet.';
      }
    },
  },
];

// --- All tools: built-in + custom ---

function getAllTools() {
  // Dedup as a final safety net — built-ins always win
  const seen = new Set(tools.map(t => t.name));
  const safe = [];
  for (const t of getCustomTools()) {
    if (seen.has(t.name)) {
      console.error(`Custom tool "${t.name}" shadowed by built-in — skipping`);
      continue;
    }
    seen.add(t.name);
    safe.push(t);
  }
  return [...tools, ...safe];
}

// --- Format converters ---

// Anthropic format: { name, description, input_schema }
export function getAnthropicTools() {
  return getAllTools().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// OpenAI format: { type: "function", function: { name, description, parameters } }
export function getOpenAITools() {
  return getAllTools().map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// --- Executor ---

let toolMap = new Map(tools.map(t => [t.name, t]));

function rebuildToolMap() {
  toolMap = new Map(getAllTools().map(t => [t.name, t]));
}

export async function executeTool(name, args, session) {
  const tool = toolMap.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(args, session);
  } catch (err) {
    return `Tool error (${name}): ${err.message}`;
  }
}

// Initialize: register built-in names, then load custom tools
setBuiltinNames(tools.map(t => t.name));
await loadCustomTools();
rebuildToolMap();

export { tools, getAllTools };
