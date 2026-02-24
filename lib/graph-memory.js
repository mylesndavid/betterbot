/**
 * Graph Memory — compaction-powered knowledge graph.
 * Extracts entities/people/decisions from session summaries and stores them
 * in a persistent graph. Provides graph-aware recall for the agent.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { MiniGraph } from './graph.js';
import { createProvider } from './provider.js';
import config from '../config.js';

const GRAPH_DIR = config.graphDir || join(config.dataDir, 'graph');
const GRAPH_PATH = join(GRAPH_DIR, 'graph.json');

// Singleton cache
let _graph = null;

// Write mutex — simple Promise chain to serialize saves
let _writeLock = Promise.resolve();

function withLock(fn) {
  _writeLock = _writeLock.then(fn, fn);
  return _writeLock;
}

/**
 * Load graph from disk (cached singleton).
 */
export async function loadGraph() {
  if (_graph) return _graph;

  try {
    const raw = await readFile(GRAPH_PATH, 'utf-8');
    _graph = MiniGraph.import(JSON.parse(raw));
  } catch {
    _graph = new MiniGraph();
  }

  return _graph;
}

/**
 * Atomic save — write to tmp file, then rename.
 */
async function saveGraph() {
  if (!_graph) return;

  if (!existsSync(GRAPH_DIR)) {
    await mkdir(GRAPH_DIR, { recursive: true });
  }

  const tmp = join(GRAPH_DIR, `graph.tmp.${randomUUID().slice(0, 8)}.json`);
  const data = JSON.stringify(_graph.export(), null, 2);
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, GRAPH_PATH);
}

const EXTRACTION_PROMPT = `Extract structured knowledge from this conversation summary. Return valid JSON only, no markdown fencing.

{
  "entities": [{"name": "...", "type": "topic|project|technology|concept"}],
  "people": ["name"],
  "decisions": ["decision or action item"],
  "relationships": [{"from": "...", "to": "...", "type": "RELATES_TO"}],
  "frustrations": ["thing that broke, confused the user, or wasted time"],
  "preferences": ["explicit user preference, choice, or style decision"]
}

Rules:
- Max 10 entities, 5 people, 5 decisions, 5 relationships, 3 frustrations, 3 preferences
- Only specific, meaningful items — skip generic words
- Entity names should be normalized (lowercase, singular)
- People names as they appear
- Decisions should be concrete actions or choices made
- Frustrations: bugs hit, confusing errors, things that wasted time, workarounds needed
- Preferences: things the user explicitly chose, likes, dislikes, or wants done a certain way`;

/**
 * Extract entities from a compaction summary and add to graph.
 * Fire-and-forget — errors are logged silently, never blocks the agent.
 */
export async function extractToGraph(sessionId, summaryText, metadata = {}) {
  await withLock(async () => {
    const graph = await loadGraph();

    // Skip if already extracted
    const nodeId = `session:${sessionId}`;
    if (graph.hasNode(nodeId)) return;

    // Call cheap LLM for extraction
    let extracted;
    try {
      const provider = createProvider('quick');
      const response = await provider.chat([
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: summaryText },
      ], { maxTokens: 1024 });

      // Parse JSON from response — handle fencing and surrounding text
      let jsonStr = response.content.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      // Try to find JSON object if there's surrounding text
      const braceStart = jsonStr.indexOf('{');
      const braceEnd = jsonStr.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd > braceStart) {
        jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
      }
      extracted = JSON.parse(jsonStr);
    } catch {
      // Extraction failed — don't create session node so retry is possible next compaction
      return;
    }

    // Create session node
    graph.addNode(nodeId, {
      type: 'session',
      summary: summaryText.slice(0, 500),
      ...metadata,
    });

    // Link to previous session (temporal chain)
    const sessionNodes = [];
    for (const [id, attrs] of graph._nodes) {
      if (attrs.type === 'session' && id !== nodeId) sessionNodes.push({ id, attrs });
    }
    if (sessionNodes.length > 0) {
      // Find most recent by timestamp
      sessionNodes.sort((a, b) => (b.attrs.timestamp || '').localeCompare(a.attrs.timestamp || ''));
      graph.addEdge(sessionNodes[0].id, nodeId, { type: 'FOLLOWED_BY' });
    }

    // Process entities
    for (const entity of (extracted.entities || []).slice(0, 10)) {
      if (!entity.name) continue;
      const eid = `entity:${entity.name.toLowerCase()}`;
      const existing = graph.getNode(eid);
      graph.mergeNode(eid, {
        type: 'entity',
        entityType: entity.type || 'topic',
        name: entity.name,
        mentions: (existing?.mentions || 0) + 1,
      });
      graph.addEdge(nodeId, eid, { type: 'ABOUT' });
    }

    // Process people
    for (const person of (extracted.people || []).slice(0, 5)) {
      if (!person) continue;
      const pid = `person:${person.toLowerCase()}`;
      const existing = graph.getNode(pid);
      graph.mergeNode(pid, {
        type: 'person',
        name: person,
        mentions: (existing?.mentions || 0) + 1,
      });
      graph.addEdge(nodeId, pid, { type: 'MENTIONS' });
    }

    // Process decisions
    for (const decision of (extracted.decisions || []).slice(0, 5)) {
      if (!decision) continue;
      const hash = createHash('sha256').update(decision).digest('hex').slice(0, 12);
      const did = `decision:${hash}`;
      graph.mergeNode(did, {
        type: 'decision',
        text: decision,
        timestamp: metadata.timestamp,
      });
      graph.addEdge(nodeId, did, { type: 'DECIDED' });
    }

    // Process relationships between entities
    for (const rel of (extracted.relationships || []).slice(0, 5)) {
      if (!rel.from || !rel.to) continue;
      const fromId = `entity:${rel.from.toLowerCase()}`;
      const toId = `entity:${rel.to.toLowerCase()}`;
      // Only link if both entities exist in graph
      if (graph.hasNode(fromId) && graph.hasNode(toId)) {
        graph.addEdge(fromId, toId, { type: rel.type || 'RELATES_TO' });
      }
    }

    // Process frustrations — things that broke or wasted time
    for (const frustration of (extracted.frustrations || []).slice(0, 3)) {
      if (!frustration) continue;
      const hash = createHash('sha256').update(frustration).digest('hex').slice(0, 12);
      const fid = `frustration:${hash}`;
      graph.mergeNode(fid, {
        type: 'frustration',
        text: frustration,
        timestamp: metadata.timestamp,
      });
      graph.addEdge(nodeId, fid, { type: 'FRUSTRATED_BY' });
    }

    // Process preferences — user choices and style decisions
    for (const preference of (extracted.preferences || []).slice(0, 3)) {
      if (!preference) continue;
      const hash = createHash('sha256').update(preference).digest('hex').slice(0, 12);
      const pid = `preference:${hash}`;
      graph.mergeNode(pid, {
        type: 'preference',
        text: preference,
        timestamp: metadata.timestamp,
      });
      graph.addEdge(nodeId, pid, { type: 'PREFERS' });
    }

    await saveGraph();
  });
}

/**
 * Search the graph and return formatted results for recall().
 */
export async function graphRecall(query) {
  const graph = await loadGraph();
  if (graph.nodeCount === 0) return null;

  const matches = graph.search(query);
  if (matches.length === 0) return null;

  // Take top 5 matches, traverse 1 hop from each
  const seen = new Set();
  const sections = [];

  for (const match of matches.slice(0, 5)) {
    const neighborhood = graph.traverse(match.id, 1);
    const lines = [];

    for (const node of neighborhood) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      const a = node.attrs;
      if (a.type === 'session') {
        lines.push(`Session: ${a.summary || '(no summary)'}`);
      } else if (a.type === 'entity') {
        lines.push(`${a.entityType || 'topic'}: ${a.name} (${a.mentions} mention${a.mentions === 1 ? '' : 's'})`);
      } else if (a.type === 'person') {
        lines.push(`Person: ${a.name} (${a.mentions} mention${a.mentions === 1 ? '' : 's'})`);
      } else if (a.type === 'decision') {
        lines.push(`Decision: ${a.text}`);
      } else if (a.type === 'frustration') {
        lines.push(`Pitfall: ${a.text}`);
      } else if (a.type === 'preference') {
        lines.push(`User preference: ${a.text}`);
      }
    }

    if (lines.length > 0) sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return null;
  return `[Graph Memory]\n${sections.join('\n\n')}`;
}
