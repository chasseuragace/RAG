const { serverEvents } = require('../shared/events');

class NovitaInference {
  constructor(apiKey = null, model = 'deepseek/deepseek-v4-pro') {
    this.apiKey = apiKey || process.env.NOVITA_API_KEY;
    this.model = model;
    if (!this.apiKey) throw new Error('Novita API key required');
  }
  async generateAnswer(query, contextDocuments, conversationHistory = [], abortSignal = null) {
    const start = Date.now();
    const contextText = contextDocuments.map((doc, idx) =>
      `[Document ${idx+1}] (${doc.metadata.file || doc.id})\n${doc.metadata.content || ''}`
    ).join('\n\n');
    const systemPrompt = `You are a helpful AI assistant. Use ONLY the provided context to answer. If unknown, say so.\n\nContext:\n${contextText}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: query }
    ];
    if (abortSignal) abortSignal.throwIfAborted();
    const res = await fetch('https://api.novita.ai/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.1, max_tokens: 1000 }),
      signal: abortSignal || undefined
    });
    if (!res.ok) throw new Error(`Novita error: ${res.status}`);
    const data = await res.json();
    const answer = data.choices[0].message.content;
    serverEvents.logEvent('inference:complete', { queryLength: query.length, contextDocs: contextDocuments.length, duration: Date.now()-start });
    return answer;
  }
  async generateChat(messages, options = {}, abortSignal = null) {
    const start = Date.now();
    const maxTokens = options.max_tokens || 1000;
    const temperature = options.temperature || 0.1;
    if (abortSignal) abortSignal.throwIfAborted();
    const res = await fetch('https://api.novita.ai/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens }),
      signal: abortSignal || undefined
    });
    if (!res.ok) throw new Error(`Novita error: ${res.status}`);
    const data = await res.json();
    const answer = data.choices[0].message.content;
    serverEvents.logEvent('inference:complete', { duration: Date.now()-start });
    return answer;
  }
}

module.exports = { NovitaInference };
