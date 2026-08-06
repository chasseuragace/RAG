const { PostgresThreadManager } = require('./postgres-thread-manager');

function createThreadManager() {
  return new PostgresThreadManager();
}

module.exports = { createThreadManager };