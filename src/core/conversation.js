/**
 * ConversationStore — one JSON file per session holding chat history for /ask.
 */
const fs = require('fs');
const path = require('path');
const { CONVERSATIONS_DIR } = require('../config');

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
