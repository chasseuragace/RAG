class MessageSummarizer {
  constructor(inference) {
    this.inference = inference;
  }

  async summarize(messages, maxSummaryTokens = 200, abortSignal = null) {
    if (abortSignal) abortSignal.throwIfAborted();
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Summarize the following conversation into a concise paragraph (max ${maxSummaryTokens} tokens) preserving key facts, decisions, and unresolved questions:\n\n${text}`;
    const summary = await this.inference.generateAnswer(prompt, [], []);
    return summary.trim();
  }
}

module.exports = { MessageSummarizer };