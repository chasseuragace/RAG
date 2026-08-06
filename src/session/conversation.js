/**
 * ConversationStore — DEPRECATED.
 *
 * @deprecated Use PostgresThreadManager via createThreadManager() instead.
 * This flat-file JSON store has no token-aware context window management,
 * no summarization, and no thread abstraction. Retained only for
 * migration purposes; will be removed in a future release.
 */
const fs = require('fs');
const path = require('path');
const { CONVERSATIONS_DIR } = require('../shared/config');

class ConversationStore {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.filePath = path.join(CONVERSATIONS_DIR, `${sessionId}.json`);
    this.messages = this._load();
  }
  _load() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch(e) { return []; }
    }
    return [];
  }
  _save() { fs.writeFileSync(this.filePath, JSON.stringify(this.messages, null, 2)); }
  addMessage(role, content) {
    this.messages.push({ role, content, timestamp: Date.now() });
    this._save();
  }
  getHistory(limit = 10) {
    return this.messages.slice(-limit);
  }
  clear() { this.messages = []; this._save(); }
  static getOrCreate(sessionId) { return new ConversationStore(sessionId); }
}

module.exports = { ConversationStore };
