import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import config from '../config.js';

const RULES_PATH = join(config.dataDir, 'rules.md');

export async function getUserRules() {
  try {
    const content = await readFile(RULES_PATH, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function listRules() {
  const content = await getUserRules();
  if (!content) return [];
  return content.split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean);
}

export async function addRule(rule) {
  const rules = await listRules();
  rules.push(rule.trim());
  await writeFile(RULES_PATH, rules.map(r => `- ${r}`).join('\n') + '\n', 'utf-8');
  return rules;
}

export async function removeRule(index) {
  const rules = await listRules();
  if (index < 0 || index >= rules.length) throw new Error(`Invalid rule index: ${index}`);
  const removed = rules.splice(index, 1)[0];
  await writeFile(RULES_PATH, rules.length > 0 ? rules.map(r => `- ${r}`).join('\n') + '\n' : '', 'utf-8');
  return removed;
}
