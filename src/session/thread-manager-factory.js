const { ConversationStore } = require('./conversation');
const { PostgresThreadManager } = require('./postgres-thread-manager');

function createThreadManager() {
  if (process.env.USE_NEW_CONTEXT === 'true') {
    return new PostgresThreadManager();
  }
  return new LegacyThreadManagerAdapter();
}

class LegacyThreadManagerAdapter {
  constructor() {
    this._store = null;
  }

  _getStore(sessionId) {
    if (!this._store || this._store.sessionId !== sessionId) {
      this._store = ConversationStore.getOrCreate(sessionId);
    }
    return this._store;
  }

  async getOrCreate(threadId) {
    const store = this._getStore(threadId);
    const messages = store.messages.map(m => {
      const msg = { role: m.role, content: m.content, timestamp: m.timestamp };
      return msg;
    });
    const thread = {
      id: threadId,
      metadata: {},
      messages,
      summary: null,
      lastSummarizedIndex: 0,
    };
    return thread;
  }

  async addMessage(threadId, message) {
    const store = this._getStore(threadId);
    store.addMessage(message.role, message.content);
  }

  async getThread(threadId) {
    return this.getOrCreate(threadId);
  }

  async updateSummary(threadId, summary, lastSummarizedIndex) {
  }

  async listThreads(filters = {}) {
    return [];
  }
}

module.exports = { createThreadManager, LegacyThreadManagerAdapter };