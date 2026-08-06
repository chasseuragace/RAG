/**
 * One-time migration script: reads conversations/*.json and inserts
 * all messages into Postgres via PostgresThreadManager.
 *
 * Usage:
 *   USE_NEW_CONTEXT=true node scripts/migrate-conversations.js
 *
 * Requires:
 *   - PG_CONNECTION_STRING env var (or default in config.js)
 *   - Postgres service running and accessible
 *   - USE_NEW_CONTEXT=true so the factory returns PostgresThreadManager
 */
const fs = require('fs');
const path = require('path');
const { CONVERSATIONS_DIR } = require('../src/shared/config');
const { PostgresThreadManager } = require('../src/session/postgres-thread-manager');

async function migrate() {
  const manager = new PostgresThreadManager();
  await manager._init();

  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    console.log('No conversations directory found. Nothing to migrate.');
    await manager.close();
    process.exit(0);
  }

  const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No conversation JSON files found. Nothing to migrate.');
    await manager.close();
    process.exit(0);
  }

  let totalThreads = 0;
  let totalMessages = 0;

  for (const file of files) {
    const filePath = path.join(CONVERSATIONS_DIR, file);
    const sessionId = path.basename(file, '.json');

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`Skipping ${file}: parse error — ${e.message}`);
      continue;
    }

    if (!Array.isArray(raw)) {
      console.warn(`Skipping ${file}: expected array, got ${typeof raw}`);
      continue;
    }

    const thread = await manager.getOrCreate(sessionId);

    for (const msg of raw) {
      if (!msg.role || !msg.content) {
        console.warn(`Skipping malformed message in ${file}: ${JSON.stringify(msg).slice(0, 100)}`);
        continue;
      }
      const message = {
        id: msg.id || `${sessionId}_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || Date.now(),
        metadata: {},
      };
      await manager.addMessage(sessionId, message);
      totalMessages++;
    }

    totalThreads++;
    console.log(`Migrated ${file}: ${raw.length} messages → thread "${sessionId}"`);
  }

  console.log(`\nMigration complete: ${totalThreads} threads, ${totalMessages} messages.`);
  await manager.close();
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});