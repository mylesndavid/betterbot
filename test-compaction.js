#!/usr/bin/env node

/**
 * Test script to verify compaction and graph extraction.
 * Creates a session with many messages, triggers compaction, and checks if graph was updated.
 */

import { Session } from './lib/session.js';
import { loadGraph } from './lib/graph-memory.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config.js';

async function testCompaction() {
  console.log('🧪 Testing compaction and graph extraction...\n');

  // Create a test session
  const session = new Session();
  await session.init();
  console.log(`✓ Created session: ${session.id}`);

  // Add many messages to trigger compaction (need > maxMessagesBeforeCompact)
  const threshold = config.compaction.maxMessagesBeforeCompact || 30;
  const keep = config.compaction.keepRecentMessages || 10;
  const messagesToAdd = threshold + 5; // Add a few extra to ensure compaction

  console.log(`\n📝 Adding ${messagesToAdd} messages (threshold: ${threshold}, keep: ${keep})...`);

  // Add messages with some meaningful content for graph extraction
  const topics = [
    'working on a project called BetterBot',
    'discussing AI agents and memory systems',
    'planning to add graph memory features',
    'talking about Obsidian vault integration',
    'considering adding a web UI for graph visualization',
  ];

  for (let i = 0; i < messagesToAdd; i++) {
    const topic = topics[i % topics.length];
    const userMsg = `Message ${i + 1}: ${topic}`;
    const assistantMsg = `I understand you're ${topic}. Let me help with that.`;

    session.messages.push({ role: 'user', content: userMsg });
    session.messages.push({ role: 'assistant', content: assistantMsg });

    // Save periodically to simulate real usage
    if (i % 10 === 0) {
      await session.save();
    }
  }

  console.log(`✓ Added ${session.messages.length} messages`);

  // Check graph state before compaction
  const graphBefore = await loadGraph();
  const nodesBefore = graphBefore.nodeCount;
  console.log(`\n📊 Graph state before compaction: ${nodesBefore} nodes`);

  // Trigger compaction manually
  console.log('\n🗜️  Triggering compaction...');
  await session.compact();
  await session.save();

  console.log(`✓ Compaction complete. Messages remaining: ${session.messages.length}`);

  // Wait a bit for async graph extraction (it's fire-and-forget)
  console.log('\n⏳ Waiting for graph extraction...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check graph state after compaction
  const graphAfter = await loadGraph();
  const nodesAfter = graphAfter.nodeCount;
  console.log(`\n📊 Graph state after compaction: ${nodesAfter} nodes`);

  if (nodesAfter > nodesBefore) {
    console.log(`✅ Graph was updated! Added ${nodesAfter - nodesBefore} new nodes`);
  } else {
    console.log(`⚠️  Graph node count unchanged (${nodesBefore} → ${nodesAfter})`);
  }

  // Check if session node exists
  const sessionNodeId = `session:${session.id}`;
  const sessionNode = graphAfter.getNode(sessionNodeId);
  if (sessionNode) {
    console.log(`✅ Session node found in graph: ${sessionNodeId}`);
    console.log(`   Summary: ${sessionNode.summary?.slice(0, 100)}...`);
  } else {
    console.log(`⚠️  Session node not found in graph: ${sessionNodeId}`);
  }

  // Check for entities
  const allNodes = [];
  for (const [id, attrs] of graphAfter._nodes) {
    allNodes.push({ id, ...attrs });
  }
  const entities = allNodes.filter(n => n.type === 'entity');
  const people = allNodes.filter(n => n.type === 'person');
  const decisions = allNodes.filter(n => n.type === 'decision');

  console.log(`\n📈 Graph contents:`);
  console.log(`   Entities: ${entities.length}`);
  console.log(`   People: ${people.length}`);
  console.log(`   Decisions: ${decisions.length}`);
  console.log(`   Sessions: ${allNodes.filter(n => n.type === 'session').length}`);

  if (entities.length > 0) {
    console.log(`\n   Sample entities:`);
    entities.slice(0, 5).forEach(e => {
      console.log(`     - ${e.name} (${e.entityType || 'topic'}, ${e.mentions} mentions)`);
    });
  }

  // Check history archive
  const historyPath = join(config.sessionsDir, `${session.id}.history.jsonl`);
  try {
    const history = await readFile(historyPath, 'utf-8');
    const historyLines = history.trim().split('\n').filter(Boolean);
    console.log(`\n📦 History archive: ${historyLines.length} messages archived`);
  } catch {
    console.log(`\n⚠️  History archive not found (expected if compaction failed)`);
  }

  console.log('\n✨ Test complete!\n');
}

testCompaction().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
