import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import config from '../config.js';

function memoriesDir() {
  return join(config.vault, config.memoriesDir);
}

function slugify(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function topicPath(topic) {
  return join(memoriesDir(), `${slugify(topic)}.md`);
}

/**
 * Store a memory — creates/overwrites a markdown file in the vault's Memories/ dir.
 * @param {string} topic - Memory topic (becomes filename)
 * @param {string} content - Memory content (markdown)
 * @returns {string} Confirmation message
 */
export async function remember(topic, content) {
  const dir = memoriesDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const path = topicPath(topic);
  const header = `# ${topic}\n\n`;
  await writeFile(path, header + content, 'utf-8');
  return `Remembered "${topic}" → ${config.memoriesDir}/${slugify(topic)}.md`;
}

/**
 * Recall a memory by topic.
 * @param {string} topic - Memory topic to recall
 * @returns {string} Memory content or not-found message
 */
export async function recall(topic) {
  const path = topicPath(topic);
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return `No memory found for "${topic}".`;
  }
}

/**
 * List all memories with first-line previews.
 * @returns {string} Formatted list of memories
 */
export async function listMemories() {
  const dir = memoriesDir();
  if (!existsSync(dir)) return 'No memories stored yet.';

  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
    if (files.length === 0) return 'No memories stored yet.';

    const entries = [];
    for (const file of files.sort()) {
      const content = await readFile(join(dir, file), 'utf-8');
      const firstContentLine = content.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
      const name = file.replace(/\.md$/, '');
      entries.push(`${name} — ${firstContentLine.trim().slice(0, 80)}`);
    }
    return entries.join('\n');
  } catch (err) {
    return `Error listing memories: ${err.message}`;
  }
}
