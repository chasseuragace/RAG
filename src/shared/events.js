/**
 * Server-wide event bus + metrics. A single shared instance is exported so
 * every module logs into the same stream that the dashboard subscribes to.
 */
const { EventEmitter } = require('events');

class ServerEvents extends EventEmitter {
  constructor() {
    super();
    this.metrics = { startTime: Date.now(), requestsTotal: 0, injectionTotal: 0, retrievalTotal: 0, embeddingsTotal: 0, averageEmbeddingTime: 0, averageRetrievalTime: 0, averageInjectionTime: 0, lastRequest: null, lastInjection: null, lastRetrieval: null, errors: [], connectedClients: 0 };
    this.eventLog = [];
    this.maxLogSize = 1000;
  }
  logEvent(eventType, data = {}) {
    const event = { timestamp: Date.now(), type: eventType, data };
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) this.eventLog.shift();
    switch (eventType) {
      case 'request:start': this.metrics.requestsTotal++; this.metrics.lastRequest = Date.now(); break;
      case 'injection:start': this.metrics.injectionTotal++; this.metrics.lastInjection = Date.now(); break;
      case 'retrieval:start': this.metrics.retrievalTotal++; this.metrics.lastRetrieval = Date.now(); break;
      case 'embedding:complete': this.metrics.embeddingsTotal++; break;
      case 'error': this.metrics.errors.push({ timestamp: Date.now(), ...data }); if (this.metrics.errors.length > 100) this.metrics.errors.shift(); break;
    }
    this.emit('event', event);
  }
  getMetrics() { const uptime = Date.now() - this.metrics.startTime; return { ...this.metrics, uptime, uptimeFormatted: this._formatUptime(uptime) }; }
  _formatUptime(ms) { const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24); if (d) return `${d}d ${h%24}h`; if (h) return `${h}h ${m%60}m`; if (m) return `${m}m ${s%60}s`; return `${s}s`; }
  incrementConnectedClients(delta = 1) { this.metrics.connectedClients = Math.max(0, this.metrics.connectedClients + delta); this.logEvent('client:connected', { clientCount: this.metrics.connectedClients }); }
}

const serverEvents = new ServerEvents();

module.exports = { ServerEvents, serverEvents };
