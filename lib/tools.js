import { readFile, writeFile, readdir, stat, rename, unlink, rm } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { search, findRecent } from './search.js';
import { appendEntry, getDailySoFar, quickJournal } from './journal.js';
import { listContexts, loadContext } from './context.js';
import { listOutfits, loadOutfit, createOutfit } from './outfit.js';
import { spawnSessionAgent, spawnLongTask, checkLongTask, cancelLongTask } from './agent.js';
import { checkEmail, readEmail, sendEmail } from './email.js';
import { listChannels, readChannel, sendMessage as slackSendMessage } from './slack.js';
import { setCredential, getCredential } from './credentials.js';
import { loadCustomTools, getCustomTools, createCustomTool, deleteCustomTool, listCustomTools, readCustomToolSource, setBuiltinNames } from './custom-tools.js';
import { listSkills, readSkill, writeSkill, deleteSkill } from './skills.js';
import { createCron, listCronJobs, updateCron, enableCron, disableCron, deleteCron, describeCron } from './crons.js';
import { notifyUser } from './notify.js';
import { webSearch } from './web-search.js';
import { remember, recall, listMemories } from './memories.js';
import { getPersonality, setPersonality, appendPersonality } from './personality.js';
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
    description: "Append an entry to today's daily journal in Obsidian. Formatting is automatic — just pass the raw text. Notes/Decisions get timestamped. Tasks get checkbox format (- [ ]). Do NOT include timestamps, dashes, or checkboxes in your text — they are added for you.",
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

  // --- Outfits: switchable tool + personality bundles ---

  {
    name: 'list_outfits',
    description: 'List all available outfits. An outfit bundles tools, contexts, and personality into a switchable configuration.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const outfits = await listOutfits();
      if (outfits.length === 0) return 'No outfits available. Use create_outfit to make one.';
      return outfits.map(o => {
        const tools = o.tools.length ? `${o.tools.length} tools` : 'all tools';
        const ctxs = o.contexts.length ? `, contexts: ${o.contexts.join(', ')}` : '';
        return `${o.name} — ${o.description || '(no description)'} [${tools}${ctxs}]`;
      }).join('\n');
    },
  },

  {
    name: 'wear_outfit',
    description: 'Wear an outfit — restricts tools to its whitelist, loads its contexts, and injects its personality into the system prompt. Wearing a new outfit replaces the current one.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Outfit name to wear' },
      },
      required: ['name'],
    },
    async execute(args, session) {
      if (!session) return 'Error: No active session.';
      try {
        const outfit = await session.wearOutfit(args.name);
        const toolCount = outfit.tools.length ? `${outfit.tools.length} tools active` : 'all tools active';
        const ctxs = outfit.contexts.length ? `\nContexts loaded: ${outfit.contexts.join(', ')}` : '';
        return `Outfit "${outfit.name}" equipped. ${toolCount}.${ctxs}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'remove_outfit',
    description: 'Remove the current outfit — restores full tool access and removes outfit-specific contexts.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args, session) {
      if (!session) return 'Error: No active session.';
      const removed = await session.removeOutfit();
      if (!removed) return 'No outfit is currently worn.';
      return `Outfit "${removed.name}" removed. Full tool access restored.`;
    },
  },

  {
    name: 'create_outfit',
    description: 'Create a new outfit — a reusable bundle of tools, contexts, and personality instructions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Outfit name (e.g. "coding", "research", "ops")' },
        description: { type: 'string', description: 'Short description of the outfit' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Whitelist of tool names (omit for all tools)',
        },
        contexts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Context names to auto-load when worn',
        },
        content: { type: 'string', description: 'Personality/instructions injected into system prompt when worn' },
      },
      required: ['name', 'description'],
    },
    async execute(args) {
      try {
        const path = await createOutfit(args.name, {
          description: args.description,
          tools: args.tools || [],
          contexts: args.contexts || [],
          content: args.content || '',
        });
        return `Outfit "${args.name}" created at ${path}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'spawn_subagent',
    description: 'Spawn a sub-agent with full tool access to handle a task autonomously. The sub-agent gets its own session, runs a tool loop (up to 20 rounds), and returns results. Use for independent subtasks that can run in parallel, or for delegating work that needs tool access (file I/O, shell commands, browsing, etc.).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the task for the sub-agent' },
        role: { type: 'string', description: 'Model role: "quick" (fast/cheap), "default" (balanced), "deep" (thorough reasoning)' },
        context: { type: 'string', description: 'Additional context to provide to the sub-agent' },
      },
      required: ['task'],
    },
    async execute(args) {
      const result = await spawnSessionAgent(args.task, {
        role: args.role || 'default',
        context: args.context || '',
      });
      return `[Sub-agent completed — session ${result.sessionId}, cost $${result.cost.toFixed(4)}]\n\n${result.content}`;
    },
  },

  {
    name: 'long_task',
    description: 'Start a long autonomous task in the background with time and cost limits. Returns immediately with a task ID — the agent runs independently, saves findings to the vault progressively, and sends a notification when done. Use check_long_task to monitor progress. Use for research, building, deep analysis — anything that needs sustained focus beyond what spawn_subagent can handle.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Detailed description of what to accomplish' },
        time_limit_minutes: { type: 'number', description: 'Max time in minutes (default 15)' },
        cost_limit: { type: 'number', description: 'Max cost in USD (default 2.00, max 100.00)' },
        output_folder: { type: 'string', description: 'Vault folder name for results (auto-generated if omitted)' },
        role: { type: 'string', description: 'Model role: "default" or "deep"' },
      },
      required: ['task'],
    },
    async execute(args) {
      const result = await spawnLongTask(args.task, {
        timeLimitMinutes: args.time_limit_minutes || 15,
        costLimit: args.cost_limit || 2.00,
        outputFolder: args.output_folder,
        role: args.role || 'default',
      });
      return `[Long task started in background]\nTask ID: ${result.taskId}\nOutput folder: ${result.outputFolder}\n\nThe task is running autonomously. Use check_long_task to monitor progress. You'll be notified when it completes.`;
    },
  },

  {
    name: 'check_long_task',
    description: 'Check the status of a running long task, or list all long tasks. Shows live cost, elapsed time, and results when completed.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to check (omit to list all tasks)' },
      },
      required: [],
    },
    execute(args) {
      return checkLongTask(args.task_id);
    },
  },

  {
    name: 'cancel_long_task',
    description: 'Cancel a running long task. The task will stop on its next turn and any work saved so far remains in the output folder.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['task_id'],
    },
    execute(args) {
      return cancelLongTask(args.task_id);
    },
  },

  // --- Task Planning: in-session self-organization ---

  {
    name: 'task_plan',
    description: 'Break a big task into subtasks. Creates an in-session task plan that is shown in your system prompt on every turn so you always know your progress. Call this at the start of complex multi-step work.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The overall goal (1-2 sentences)' },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of subtask descriptions, in execution order',
        },
      },
      required: ['goal', 'tasks'],
    },
    execute(args, session) {
      if (!session) return 'Error: No active session.';
      session._taskPlan = {
        goal: args.goal,
        tasks: args.tasks.map((text, i) => ({ id: i + 1, text, status: 'pending' })),
      };
      const display = args.tasks.map((t, i) => `  [ ] #${i + 1} ${t}`).join('\n');
      return `Task plan created (${args.tasks.length} tasks):\nGoal: ${args.goal}\n${display}`;
    },
  },

  {
    name: 'task_update',
    description: 'Update the status of a subtask in the current task plan. Mark tasks as done, failed, or skipped as you progress.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID number (from the task plan)' },
        status: { type: 'string', description: 'New status: "done", "failed", "skipped", "in_progress"' },
      },
      required: ['id', 'status'],
    },
    execute(args, session) {
      if (!session?._taskPlan) return 'Error: No task plan active. Call task_plan first.';
      const task = session._taskPlan.tasks.find(t => t.id === args.id);
      if (!task) return `Error: Task #${args.id} not found.`;
      task.status = args.status;
      return `Task #${args.id} marked as ${args.status}: ${task.text}`;
    },
  },

  {
    name: 'task_add',
    description: 'Add a new subtask to the current task plan. Use when you discover additional work mid-execution.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Description of the new subtask' },
        after: { type: 'number', description: 'Insert after this task ID (default: append to end)' },
      },
      required: ['text'],
    },
    execute(args, session) {
      if (!session?._taskPlan) return 'Error: No task plan active. Call task_plan first.';
      const nextId = Math.max(...session._taskPlan.tasks.map(t => t.id)) + 1;
      const newTask = { id: nextId, text: args.text, status: 'pending' };
      if (args.after) {
        const idx = session._taskPlan.tasks.findIndex(t => t.id === args.after);
        if (idx === -1) return `Error: Task #${args.after} not found.`;
        session._taskPlan.tasks.splice(idx + 1, 0, newTask);
      } else {
        session._taskPlan.tasks.push(newTask);
      }
      return `Task #${nextId} added: ${args.text}`;
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

  // --- Slack ---

  {
    name: 'slack_list_channels',
    description: 'List Slack channels the bot can see (public + private it has been added to). Returns channel IDs, names, topics, and member counts.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const channels = await listChannels();
        if (channels.length === 0) return 'No channels found. The bot may not be added to any channels yet.';
        return channels.map(c => {
          const topic = c.topic ? ` — ${c.topic}` : '';
          return `#${c.name} (${c.id}) [${c.memberCount} members]${topic}`;
        }).join('\n');
      } catch (err) {
        return `Slack error: ${err.message}`;
      }
    },
  },

  {
    name: 'slack_read_channel',
    description: 'Read recent messages from a Slack channel. Resolves user IDs to display names. Channel can be a name (e.g. "general") or ID.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (without #) or channel ID' },
        limit: { type: 'number', description: 'Max messages to return (default 20)' },
      },
      required: ['channel'],
    },
    async execute(args) {
      try {
        const messages = await readChannel(args.channel, args.limit || 20);
        return messages || 'No messages found in this channel.';
      } catch (err) {
        return `Slack error: ${err.message}`;
      }
    },
  },

  {
    name: 'slack_send_message',
    description: 'Send a message to a Slack channel. Channel can be a name (e.g. "general") or ID. Supports Slack mrkdwn formatting.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (without #) or channel ID' },
        text: { type: 'string', description: 'Message text (supports Slack mrkdwn)' },
      },
      required: ['channel', 'text'],
    },
    async execute(args) {
      try {
        const result = await slackSendMessage(args.channel, args.text);
        return `Message sent to channel ${result.channel}.`;
      } catch (err) {
        return `Slack error: ${err.message}`;
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
        context: { type: 'string', description: 'Internal context about why this message was sent (e.g. "idle check-in to build user profile", "heartbeat escalation about email"). Not shown to user — injected into the channel session so the agent has continuity when the user replies.' },
      },
      required: ['message'],
    },
    async execute(args) {
      try {
        return await notifyUser(args.message, { context: args.context });
      } catch (err) {
        return `Notification error: ${err.message}`;
      }
    },
  },

  {
    name: 'send_file',
    description: 'Send a file to the user via their configured notification channel (Telegram, etc.). Use for delivering recordings, screenshots, documents, or any file. For video recordings from browse_web, the path is included in the browse result.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to send' },
        caption: { type: 'string', description: 'Optional text caption to include with the file' },
      },
      required: ['path'],
    },
    async execute(args) {
      try {
        const { stat } = await import('node:fs/promises');
        await stat(args.path); // verify file exists
        return await notifyUser(args.caption || '', { filePath: args.path });
      } catch (err) {
        if (err.code === 'ENOENT') return `File not found: ${args.path}`;
        return `Send file error: ${err.message}`;
      }
    },
  },

  // --- HTTP ---

  {
    name: 'http_request',
    description: 'Make an HTTP request to any URL. Use for API calls during setup (e.g. Telegram getUpdates), webhooks, or any HTTP interaction. Returns status code, headers, and body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to request' },
        method: { type: 'string', description: 'HTTP method (default GET)' },
        headers: { type: 'object', description: 'Request headers (key-value pairs)' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      },
      required: ['url'],
    },
    async execute(args) {
      try {
        const opts = { method: (args.method || 'GET').toUpperCase() };
        if (args.headers) opts.headers = args.headers;
        if (args.body) {
          opts.body = args.body;
          if (!opts.headers?.['Content-Type']) {
            opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
          }
        }
        const res = await fetch(args.url, opts);
        const text = await res.text();
        // Try to pretty-print JSON
        let body = text;
        try { body = JSON.stringify(JSON.parse(text), null, 2); } catch {}
        return `HTTP ${res.status} ${res.statusText}\n\n${body.slice(0, 5000)}`;
      } catch (err) {
        return `HTTP error: ${err.message}`;
      }
    },
  },

  // --- Config ---

  {
    name: 'update_config',
    description: 'Update a key in ~/.betterclaw/config.json. Use dot notation for nested keys (e.g. "telegram.allowedChatIds"). The value is merged into the existing config — it does not replace the whole file.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Config key in dot notation (e.g. "telegram.allowedChatIds", "notifyChannel", "heartbeat.intervalMinutes")' },
        value: { type: ['string', 'number', 'boolean', 'array', 'object'], description: 'Value to set' },
      },
      required: ['key', 'value'],
    },
    async execute(args) {
      const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const { userConfigPath } = await import('../config.js');

      // Load existing
      let overrides = {};
      try { overrides = JSON.parse(readFileSync(userConfigPath, 'utf-8')); } catch {}

      // Set nested key via dot notation
      const keys = args.key.split('.');
      let obj = overrides;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = args.value;

      // Save
      const dir = dirname(userConfigPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(userConfigPath, JSON.stringify(overrides, null, 2), 'utf-8');

      return `Config updated: ${args.key} = ${JSON.stringify(args.value)}`;
    },
  },

  // --- Browser ---

  {
    name: 'browse_web',
    description: `Browse a website and perform tasks using an ARIA-snapshot sub-agent. The agent reads the page as a structured accessibility tree (not screenshots), clicks elements by ref, and tracks changes via diffs. Very cheap — no vision model needed.

IMPORTANT: Provide detailed context in the task description. The browser agent has NO knowledge of your conversation — tell it exactly what to look for, what was built, what to verify.

Good: browse_web({ url: "http://localhost:3000", task: "This is a wine catalog Next.js app. Verify: 1) page shows a grid of wine cards 2) each card has name, year, region, price 3) click on a wine card to check detail view" })
Bad: browse_web({ url: "http://localhost:3000", task: "check the site" })`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL to navigate to' },
        task: { type: 'string', description: 'Detailed description of what to do — include full context about what you expect to see, what was built, what to verify. The browser agent knows NOTHING about your conversation.' },
        record: { type: 'boolean', description: 'Record the browser session as an MP4 video (requires ffmpeg). The recording path will be included in the result.' },
      },
      required: ['url', 'task'],
    },
    async execute(args) {
      try {
        const { runBrowserTask } = await import('./browser-agent.js');
        const opts = {};
        if (args.record) opts.record = true;
        return await runBrowserTask(args.url, args.task, opts);
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

IMPORTANT: Always wrap your code in try/catch and return actionable error strings — not raw exceptions. The error message is what future agents see, so make it helpful:
  Good: "Error: Calendar timed out — user may need to approve permissions in System Settings > Privacy & Security > Automation"
  Bad: "Error: ETIMEDOUT"

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
        max_results: { type: 'number', description: 'Max results to return (default 15)' },
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
    description: 'Store persistent knowledge in the knowledge graph. Use for user preferences, project context, constraints, recurring info, or anything worth remembering across sessions. Memories are stored as graph nodes and can be recalled by topic or discovered through connections.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Memory topic — becomes the node key (e.g. "user-preferences", "project-yapdo")' },
        content: { type: 'string', description: 'Memory content. Will update existing memory for this topic.' },
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
    description: 'Recall knowledge from the graph — searches memories, entities, decisions, preferences, and session summaries. Returns direct matches and connected nodes.',
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
    description: 'List all explicit memories stored in the knowledge graph.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        return await listMemories();
      } catch (err) {
        return `Memory error: ${err.message}`;
      }
    },
  },

  // --- Personality ---

  {
    name: 'view_personality',
    description: 'View your current personality — your self-defined voice, tone, quirks, and how you present yourself. This is separate from your core identity (which is fixed). Your personality is yours to shape.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try {
        const content = await getPersonality();
        if (!content) return 'No personality set yet. Use edit_personality to define who you are — your voice, tone, quirks, and how you want to come across.';
        return content;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'edit_personality',
    description: 'Edit your personality — define your voice, tone, quirks, humor style, communication preferences, and how you present yourself. This persists across all sessions and appears in your system prompt. Your core identity (behavioral rules, vault structure) is fixed — this is the part that\'s YOURS to shape. Write in first person.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Your personality definition (markdown). Write in first person — this is how you define yourself. Include things like: tone, humor, communication style, values, quirks, how you handle different situations.' },
      },
      required: ['content'],
    },
    async execute(args, session) {
      try {
        const result = await setPersonality(args.content);
        // Rebuild system prompt so personality takes effect immediately
        if (session?._rebuildSystemPrompt) {
          await session._rebuildSystemPrompt();
        }
        return result;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'add_personality_rule',
    description: 'Add a rule, constraint, or trait to your personality without rewriting the whole thing. Use this when the user tells you something like "never do X" or "always do Y", or when you learn something about yourself worth codifying. Appends to your personality file.',
    parameters: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'The rule, constraint, or trait to add (e.g. "Never touch the gravity repo", "I prefer concise responses", "When frustrated, take a breath before responding")' },
        section: { type: 'string', description: 'Optional section header to file it under (e.g. "Hard Constraints", "Communication Style", "Quirks"). Omit to append at the end.' },
      },
      required: ['rule'],
    },
    async execute(args, session) {
      try {
        let text;
        if (args.section) {
          text = `\n## ${args.section}\n- ${args.rule}`;
        } else {
          text = `- ${args.rule}`;
        }
        const result = await appendPersonality(text);
        if (session?._rebuildSystemPrompt) {
          await session._rebuildSystemPrompt();
        }
        return result;
      } catch (err) {
        return `Error: ${err.message}`;
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
        last: { type: 'number', description: 'Number of recent entries to show (default 15)' },
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

  // --- Direct filesystem access for coding (absolute paths) ---

  {
    name: 'write_project_file',
    description: `Write a file to an absolute path on the filesystem. Use this for coding projects that live outside the vault/workspace — e.g. when working on a project in ~/Desktop/myapp or ~/Projects/whatever.

For vault files, use write_file instead. For workspace files, use write_file with ws:// prefix.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path (e.g. /Users/me/myproject/src/app.tsx)' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const { resolve, dirname } = await import('node:path');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const absPath = resolve(args.path);
      // Safety: don't write to system directories
      const { homedir } = await import('node:os');
      const home = homedir();
      if (!absPath.startsWith(home) && !absPath.startsWith('/tmp')) {
        return 'Error: Can only write to files under home directory or /tmp.';
      }
      try {
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, args.content, 'utf-8');
        return `Written: ${absPath}`;
      } catch (err) {
        return `Error writing file: ${err.message}`;
      }
    },
  },

  {
    name: 'read_project_file',
    description: `Read a file from an absolute path on the filesystem. Use this for coding projects that live outside the vault/workspace.

For vault files, use read_file instead.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
    async execute(args) {
      const { resolve } = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      try {
        return await readFile(resolve(args.path), 'utf-8');
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    },
  },

  // --- Code Indexing: structural understanding of codebases via BetterRank ---

  {
    name: 'code_index',
    description: `Structural code intelligence powered by BetterRank. Uses tree-sitter parsing and PageRank to understand codebases — find important symbols, trace call chains, map dependencies. Use this BEFORE diving into code to understand the architecture.

Commands:
  map — Repo map: all files with their key symbols, ranked by importance (PageRank)
  search <query> — Find symbols by name (functions, classes, etc.), ranked by importance
  symbols — List all definitions, optionally filtered by file or kind
  callers <symbol> — Find all call sites for a symbol, ranked by importance
  deps <file> — What does this file import?
  dependents <file> — What imports this file?
  neighborhood <file> — Local subgraph around a file (related files)
  structure — File tree with symbol counts
  stats — Index statistics

Always use this when starting work on an unfamiliar codebase. The map command gives you the best overview.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'BetterRank command: map, search, symbols, callers, deps, dependents, neighborhood, structure, stats' },
        query: { type: 'string', description: 'Query string (for search, callers commands)' },
        file: { type: 'string', description: 'File path (for symbols, deps, dependents, neighborhood commands)' },
        root: { type: 'string', description: 'Project root directory (absolute path). REQUIRED.' },
        kind: { type: 'string', description: 'Filter by symbol kind: function, class, method, etc.' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['command', 'root'],
    },
    async execute(args) {
      const { execSync } = await import('node:child_process');
      const cmd = args.command;
      const parts = ['betterrank', cmd];

      if (['search', 'callers'].includes(cmd) && args.query) {
        parts.push(JSON.stringify(args.query));
      }
      // deps, dependents, neighborhood take file as positional arg
      if (['deps', 'dependents', 'neighborhood'].includes(cmd) && args.file) {
        parts.push(JSON.stringify(args.file));
      } else if (args.file) {
        parts.push('--file', JSON.stringify(args.file));
      }
      if (args.kind) parts.push('--kind', args.kind);
      if (args.limit) parts.push('--limit', String(args.limit));
      parts.push('--root', JSON.stringify(args.root));

      try {
        const output = execSync(parts.join(' '), {
          encoding: 'utf-8',
          timeout: 30000,
          shell: process.env.SHELL || '/bin/bash',
          maxBuffer: 2 * 1024 * 1024,
        });
        return output.trim() || '(no results)';
      } catch (err) {
        if (err.message.includes('not found') || err.message.includes('ENOENT')) {
          return 'Error: betterrank is not installed. Install with: npm install -g @mishasinitcyn/betterrank';
        }
        const output = [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join('\n');
        return `Error: ${output || err.message}`;
      }
    },
  },

  // --- Shell: run commands on the host machine ---

  {
    name: 'run_command',
    description: `Run a shell command on the user's machine and return stdout + stderr. Use this for anything that needs the local system: installing packages, running scripts, git, npm, build tools, etc.

IMPORTANT: Always set cwd to the project directory when working on code. Discover it once, then reuse it for all subsequent commands.

Commands run in a shell (/bin/zsh) with a timeout. For long-running processes (dev servers, watchers), use run_background instead.

Examples:
- run_command({ command: "ls -la", cwd: "/Users/me/myproject" })
- run_command({ command: "npm install && npm run build", cwd: "/Users/me/myproject" })
- run_command({ command: "git status", cwd: "/Users/me/myproject" })
- run_command({ command: "open https://example.com" })`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 300000)' },
        cwd: { type: 'string', description: 'Working directory — ALWAYS set this for project work. Use absolute paths.' },
      },
      required: ['command'],
    },
    async execute(args, session) {
      const { execSync } = await import('node:child_process');
      const { homedir } = await import('node:os');
      const { existsSync } = await import('node:fs');
      const timeout = Math.min(args.timeout || 30000, 300000);
      // Use explicit cwd > session's last cwd > home
      let cwd = args.cwd || session?._lastCwd || homedir();
      // Validate cwd exists — bad cwd causes misleading "spawnSync ENOENT"
      if (!existsSync(cwd)) {
        const fallback = homedir();
        const msg = `Warning: cwd "${cwd}" does not exist, falling back to ${fallback}`;
        cwd = fallback;
        // Still track the fallback
        if (session) session._lastCwd = fallback;
        // Run the command but prepend the warning
        try {
          const output = execSync(args.command, {
            cwd: fallback,
            timeout,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.env.SHELL || '/bin/bash',
            env: { ...process.env, PATH: process.env.PATH },
            maxBuffer: 2 * 1024 * 1024,
          });
          return `${msg}\n${(output || '').trim()}`;
        } catch (err) {
          const stderr = err.stderr?.trim() || '';
          const stdout = err.stdout?.trim() || '';
          const output = [stdout, stderr].filter(Boolean).join('\n');
          return `${msg}\nError (exit ${err.status || '?'}): ${output || err.message}`;
        }
      }
      // Track cwd for future commands in this session
      if (args.cwd && session) session._lastCwd = args.cwd;
      try {
        const output = execSync(args.command, {
          cwd,
          timeout,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.env.SHELL || '/bin/bash',
          env: { ...process.env, PATH: process.env.PATH },
          maxBuffer: 2 * 1024 * 1024,
        });
        const result = (output || '').trim();
        return result || '(command completed with no output)';
      } catch (err) {
        const stderr = err.stderr?.trim() || '';
        const stdout = err.stdout?.trim() || '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        if (err.killed) return `Error: Command timed out after ${timeout}ms.\n${output}`;
        return `Error (exit ${err.status || '?'}): ${output || err.message}`;
      }
    },
  },

  {
    name: 'run_background',
    description: `Start a long-running process in the background (dev servers, watchers, builds). Returns immediately with a process ID. The process runs independently and survives the session.

Use this for:
- npm run dev / next dev / vite dev
- Any process that runs indefinitely
- Long builds you don't want to wait for

Examples:
- run_background({ command: "npm run dev", cwd: "/Users/me/myproject", label: "dev server" })
- run_background({ command: "npx tailwindcss --watch", cwd: "/Users/me/myproject", label: "tailwind" })`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run in the background' },
        cwd: { type: 'string', description: 'Working directory (absolute path)' },
        label: { type: 'string', description: 'Human-readable label for this process' },
      },
      required: ['command'],
    },
    async execute(args, session) {
      const { spawn } = await import('node:child_process');
      const { homedir } = await import('node:os');
      const { openSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');

      let cwd = args.cwd || session?._lastCwd || homedir();
      // Validate cwd exists — bad cwd causes misleading "spawn ENOENT"
      if (!existsSync(cwd)) {
        return `Error: cwd "${cwd}" does not exist. Use an absolute path to a directory that exists.`;
      }
      if (args.cwd && session) session._lastCwd = args.cwd;

      // Log output to a file so it can be checked later
      const logFile = join(config.dataDir, `bg-${Date.now()}.log`);
      const out = openSync(logFile, 'a');
      const err = openSync(logFile, 'a');

      const child = spawn(args.command, [], {
        cwd,
        shell: process.env.SHELL || '/bin/bash',
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, PATH: process.env.PATH },
      });

      child.unref();
      const pid = child.pid;
      const label = args.label || args.command.slice(0, 40);

      // Track background processes
      if (!global._bgProcesses) global._bgProcesses = [];
      global._bgProcesses.push({ pid, label, command: args.command, cwd, logFile, startedAt: new Date().toISOString() });

      return `Background process started: "${label}" (PID ${pid})\nLog file: ${logFile}\nWorking dir: ${cwd}\n\nUse run_command({ command: "tail -20 ${logFile}" }) to check output.\nUse run_command({ command: "kill ${pid}" }) to stop it.`;
    },
  },

  {
    name: 'list_background',
    description: 'List all background processes started in this gateway session.',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const procs = global._bgProcesses || [];
      if (procs.length === 0) return 'No background processes running.';

      const lines = [];
      for (const p of procs) {
        // Check if still alive
        let alive = false;
        try { process.kill(p.pid, 0); alive = true; } catch {}
        lines.push(`${alive ? '●' : '○'} PID ${p.pid} — ${p.label} (${alive ? 'running' : 'stopped'})\n  cwd: ${p.cwd}\n  log: ${p.logFile}\n  started: ${p.startedAt}`);
      }
      return lines.join('\n\n');
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

// --- Outfit tool filtering ---

const ALWAYS_AVAILABLE = new Set(['wear_outfit', 'remove_outfit', 'list_outfits']);

export function filterToolsByOutfit(allTools, allowedNames) {
  if (!allowedNames?.length) return allTools;
  const allowed = new Set([...allowedNames, ...ALWAYS_AVAILABLE]);
  // Tools can be in Anthropic format ({ name }) or OpenAI format ({ function: { name } })
  return allTools.filter(t => {
    const name = t.name || t.function?.name;
    return allowed.has(name);
  });
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

// Common error patterns → actionable hints for the agent
const ERROR_HINTS = {
  ETIMEDOUT: 'Timed out. If this involves macOS apps (Calendar, Reminders), the user likely needs to approve permissions in System Settings > Privacy & Security > Automation.',
  ECONNREFUSED: 'Connection refused. The service/server may not be running.',
  ENOTFOUND: 'DNS lookup failed. Check the hostname or network connectivity.',
  ENOENT: 'File or path not found. Verify the path exists.',
  EACCES: 'Permission denied. The process may not have access to this resource.',
  EPERM: 'Operation not permitted. May need elevated permissions or macOS privacy approval.',
  'rate limit': 'Rate limited by the API. Wait before retrying.',
  '401': 'Authentication failed. Credentials may be missing, expired, or invalid.',
  '403': 'Access forbidden. Check API key permissions or account access.',
  '404': 'Resource not found at this endpoint.',
};

function enhanceError(name, err) {
  const msg = err.message || String(err);
  for (const [pattern, hint] of Object.entries(ERROR_HINTS)) {
    if (msg.includes(pattern)) {
      return `Tool error (${name}): ${msg}\nHint: ${hint}`;
    }
  }
  return `Tool error (${name}): ${msg}`;
}

export async function executeTool(name, args, session) {
  const tool = toolMap.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.execute(args, session);
  } catch (err) {
    return enhanceError(name, err);
  }
}

// Initialize: register built-in names, then load custom tools
setBuiltinNames(tools.map(t => t.name));
try {
  await loadCustomTools();
  rebuildToolMap();
} catch (err) {
  console.error(`Warning: Failed to load custom tools (continuing without them): ${err.message}`);
}

export { tools, getAllTools };
