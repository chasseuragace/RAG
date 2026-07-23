const { serverEvents } = require('../events');

class MockInference {
  constructor(model = 'mock/deepseek-v4-mock') {
    this.model = model;
  }

  async generateAnswer(query, contextDocuments, conversationHistory = []) {
    const start = Date.now();
    const contextText = contextDocuments.map((doc, idx) =>
      `[Document ${idx + 1}] (${doc.metadata.file || doc.id})\n${doc.metadata.content || ''}`
    ).join('\n\n');
    const topDoc = contextDocuments[0];
    const mockAnswer = topDoc
      ? `Based on the retrieved documents: ${topDoc.metadata.content || 'No content available'}.`
      : 'I could not find any relevant context.';
    serverEvents.logEvent('inference:complete', { queryLength: query.length, contextDocs: contextDocuments.length, duration: Date.now() - start });
    return `[Mock] ${mockAnswer}`;
  }
}

module.exports = { MockInference };
