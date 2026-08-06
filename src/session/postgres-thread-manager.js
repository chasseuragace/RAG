const { Pool } = require('pg');
const { Thread, Message } = require('../shared/interfaces');
const { PG_CONNECTION_STRING } = require('../shared/config');

class PostgresThreadManager {
  constructor(connectionString) {
    this._pool = new Pool({
      connectionString: connectionString || PG_CONNECTION_STRING,
    });
    this._initialized = false;
  }

  async _init() {
    if (this._initialized) return;
    const client = await this._pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS threads (
          session_id TEXT PRIMARY KEY,
          summary TEXT,
          last_summarized_index INTEGER DEFAULT 0,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(session_id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          token_count INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_thread_id_created ON messages(thread_id, created_at)`);
      this._initialized = true;
    } finally {
      client.release();
    }
  }

  async getOrCreate(threadId) {
    await this._init();
    const client = await this._pool.connect();
    try {
      await client.query(
        'INSERT INTO threads (session_id) VALUES ($1) ON CONFLICT (session_id) DO NOTHING',
        [threadId]
      );
      const threadRow = await client.query(
        'SELECT * FROM threads WHERE session_id = $1',
        [threadId]
      );
      if (threadRow.rows.length === 0) {
        throw new Error(`Thread ${threadId} not found after create`);
      }
      const msgRows = await client.query(
        'SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
        [threadId]
      );
      const messages = msgRows.rows.map(r => {
        const msg = new Message(r.role, r.content, r.metadata || {});
        msg.id = r.id;
        msg.timestamp = r.created_at.getTime();
        return msg;
      });
      const row = threadRow.rows[0];
      const thread = Thread.create(threadId, row.metadata || {});
      thread.messages = messages;
      thread.summary = row.summary;
      thread.lastSummarizedIndex = row.last_summarized_index || 0;
      return thread;
    } finally {
      client.release();
    }
  }

  async addMessage(threadId, message) {
    await this._init();
    const client = await this._pool.connect();
    try {
      await client.query(
        'INSERT INTO messages (id, thread_id, role, content, metadata, token_count) VALUES ($1, $2, $3, $4, $5, $6)',
        [message.id, threadId, message.role, message.content, message.metadata || {}, message.metadata?.token_count || null]
      );
      await client.query(
        'UPDATE threads SET updated_at = NOW() WHERE session_id = $1',
        [threadId]
      );
    } finally {
      client.release();
    }
  }

  async getThread(threadId) {
    return this.getOrCreate(threadId);
  }

  async updateSummary(threadId, summary, lastSummarizedIndex) {
    await this._init();
    const client = await this._pool.connect();
    try {
      await client.query(
        'UPDATE threads SET summary = $1, last_summarized_index = $2, updated_at = NOW() WHERE session_id = $3',
        [summary, lastSummarizedIndex, threadId]
      );
    } finally {
      client.release();
    }
  }

  async listThreads(filters = {}) {
    await this._init();
    const client = await this._pool.connect();
    try {
      const limit = filters.limit || 50;
      const offset = filters.offset || 0;
      const result = await client.query(
        'SELECT * FROM threads ORDER BY updated_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      return result.rows.map(r => ({
        sessionId: r.session_id,
        summary: r.summary,
        lastSummarizedIndex: r.last_summarized_index,
        metadata: r.metadata,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } finally {
      client.release();
    }
  }

  async close() {
    await this._pool.end();
  }
}

module.exports = { PostgresThreadManager };