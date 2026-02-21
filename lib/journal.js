import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import config from '../config.js';

function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function timeStr() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dailyPath(date = todayStr()) {
  return join(config.vault, config.dailyNotesDir, `${date}.md`);
}

async function loadTemplate() {
  const templatePath = join(config.contextsDir, '_daily.md');
  try {
    let content = await readFile(templatePath, 'utf-8');
    content = content.replace(/\{\{date\}\}/g, todayStr());
    content = content.replace(/\{\{day\}\}/g, new Date().toLocaleDateString('en-US', { weekday: 'long' }));
    return content;
  } catch {
    // Fallback template
    return `# ${todayStr()}\n\n## Summary\n\n## Notes\n\n## Decisions\n`;
  }
}

async function ensureDaily(date = todayStr()) {
  const path = dailyPath(date);
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    const template = await loadTemplate();
    await writeFile(path, template, 'utf-8');
  }
  return path;
}

export async function appendEntry(text, section = 'Notes') {
  const path = await ensureDaily();
  let content = await readFile(path, 'utf-8');

  // Tasks section gets checkbox format, everything else gets timestamped
  const isTask = section === 'Tasks';
  const cleaned = text.replace(/^-\s*(\[.\]\s*)?/, '').replace(/^\d{1,2}:\d{2}\s*—?\s*/, '').replace(/^-\s*(\[.\]\s*)?/, '').trim();
  const entry = isTask ? `- [ ] ${cleaned}` : `- ${timeStr()} — ${cleaned}`;
  const sectionHeader = `## ${section}`;
  const idx = content.indexOf(sectionHeader);

  if (idx !== -1) {
    // Find the end of the section header line
    const afterHeader = content.indexOf('\n', idx);
    if (afterHeader !== -1) {
      // Insert after any existing content in this section
      // Find the next ## header or end of file
      const nextSection = content.indexOf('\n## ', afterHeader + 1);
      const insertAt = nextSection !== -1 ? nextSection : content.length;
      content = content.slice(0, insertAt).trimEnd() + '\n' + entry + '\n' + content.slice(insertAt);
    }
  } else {
    // Section doesn't exist, append at end
    content = content.trimEnd() + `\n\n${sectionHeader}\n${entry}\n`;
  }

  await writeFile(path, content, 'utf-8');
  return entry;
}

export async function getDailySoFar(date = todayStr()) {
  const path = dailyPath(date);
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function quickJournal(text) {
  return appendEntry(text, 'Notes');
}

export { ensureDaily, dailyPath, todayStr };
