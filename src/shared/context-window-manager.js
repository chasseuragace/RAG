class ContextWindowManager {
  constructor(options = {}) {
    this.modelContextWindow = options.modelContextWindow || 128000;
    this.tokenCounter = options.tokenCounter;
    this.summarizer = options.summarizer;
    this.threadManager = options.threadManager;
    this.systemTokenBudget = options.systemTokenBudget || 500;
    this.responseTokenBudget = options.responseTokenBudget || 1000;
    this.minMessagesToKeep = options.minMessagesToKeep || 3;
  }

  async buildContext(thread, systemPrompt, ragContext = [], responseTokens) {
    const systemTokens = this.tokenCounter.count(systemPrompt);
    const ragTokens = ragContext.reduce((acc, chunk) => {
      const content = chunk.content || chunk;
      return acc + this.tokenCounter.count(content);
    }, 0);
    const responseBudget = responseTokens || this.responseTokenBudget;

    const used = systemTokens + ragTokens + responseBudget;
    const messageBudget = this.modelContextWindow - used;

    const messages = thread.messages;
    let accumulatedTokens = 0;
    let cutoffIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.tokenCounter.count(messages[i].content || '');
      if (accumulatedTokens + msgTokens <= messageBudget) {
        accumulatedTokens += msgTokens;
        cutoffIndex = i;
      } else {
        break;
      }
    }

    const finalMessages = [];
    finalMessages.push({ role: 'system', content: systemPrompt });

    if (cutoffIndex > 0) {
      const summary = await this._getSummary(thread, cutoffIndex);
      finalMessages.push({ role: 'system', content: `[Previous conversation summary]: ${summary}` });
    }

    const recentMessages = messages.slice(cutoffIndex);
    for (const m of recentMessages) {
      finalMessages.push({ role: m.role || m.role, content: m.content });
    }

    if (ragContext.length > 0) {
      const ragText = ragContext.map((c, i) => `[Source ${i + 1}]: ${c.content || c}`).join('\n');
      finalMessages.push({ role: 'system', content: `Retrieved Context:\n${ragText}` });
    }

    return {
      messages: finalMessages,
      totalTokens: systemTokens + ragTokens + accumulatedTokens,
      summaryUsed: cutoffIndex > 0,
      truncatedCount: cutoffIndex,
      recentMessageCount: recentMessages.length,
    };
  }

  async _getSummary(thread, cutoffIndex) {
    if (thread.summary && thread.lastSummarizedIndex >= cutoffIndex) {
      return thread.summary;
    }

    const oldMessages = thread.messages.slice(0, cutoffIndex);
    const summary = await this.summarizer.summarize(oldMessages);

    if (this.threadManager) {
      try {
        await this.threadManager.updateSummary(thread.id, summary, cutoffIndex);
      } catch (e) {
        console.warn(`[ContextWindowManager] Failed to persist summary for thread ${thread.id}:`, e.message);
      }
    }

    return summary;
  }
}

module.exports = { ContextWindowManager };