const { TestRunner } = require('./runner');
const { TokenCounter } = require('../src/shared/token-counter');
const { MessageSummarizer } = require('../src/shared/message-summarizer');
const { ContextWindowManager } = require('../src/shared/context-window-manager');
const { Thread, Message } = require('../src/shared/interfaces');
const { createThreadManager } = require('../src/session/thread-manager-factory');
const { PostgresThreadManager } = require('../src/session/postgres-thread-manager');

async function setupTests() {
  const runner = new TestRunner();

  // ── TokenCounter ──

  runner.test('TokenCounter.init() loads js-tiktoken when available', async (a) => {
    const c = new TokenCounter();
    await c.init();
    await a.assertEqual(c._useFallback, false, 'js-tiktoken loaded successfully');
  });

  runner.test('TokenCounter.count() returns correct token count', async (a) => {
    const c = new TokenCounter();
    await c.init();
    const count = c.count('hello world');
    await a.assertTrue(count > 0, 'count is positive');
    await a.assertTrue(Number.isInteger(count), 'count is an integer');
  });

  runner.test('TokenCounter.count() falls back to char/4 when js-tiktoken unavailable', async (a) => {
    const c = new TokenCounter();
    c._useFallback = true;
    const count = c.count('hello world');
    await a.assertEqual(count, 3, 'char/4 heuristic: ceil(11/4) = 3');
  });

  runner.test('TokenCounter.countMessages() includes per-message overhead', async (a) => {
    const c = new TokenCounter();
    await c.init();
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const count = c.countMessages(messages);
    await a.assertTrue(count > 0, 'countMessages returns positive');
  });

  // ── Thread and Message ──

  runner.test('Thread.create() returns a Thread with empty messages', async (a) => {
    const thread = Thread.create('test-session');
    await a.assertEqual(thread.id, 'test-session', 'thread id matches');
    await a.assertEqual(thread.messages.length, 0, 'no messages initially');
    await a.assertEqual(thread.summary, null, 'no summary initially');
    await a.assertEqual(thread.lastSummarizedIndex, 0, 'lastSummarizedIndex is 0');
  });

  runner.test('Message.create() returns a Message with all fields', async (a) => {
    const msg = Message.create('user', 'hello world');
    await a.assertEqual(msg.role, 'user', 'role is user');
    await a.assertEqual(msg.content, 'hello world', 'content matches');
    await a.assertTrue(typeof msg.id === 'string', 'id is a string');
    await a.assertTrue(typeof msg.timestamp === 'number', 'timestamp is a number');
    await a.assertEqual(Object.keys(msg.metadata).length, 0, 'empty metadata');
  });

  runner.test('Message.create() accepts metadata', async (a) => {
    const msg = Message.create('assistant', 'answer', { tokens: 50 });
    await a.assertEqual(msg.metadata.tokens, 50, 'metadata preserved');
  });

  // ── ThreadManagerFactory ──

  runner.test('createThreadManager() returns PostgresThreadManager', async (a) => {
    const mgr = createThreadManager();
    await a.assertEqual(mgr.constructor.name, 'PostgresThreadManager', 'returns PostgresThreadManager');
  });

  // ── ContextWindowManager ──

  runner.test('ContextWindowManager.buildContext() fits messages within budget', async (a) => {
    const tokenCounter = new TokenCounter();
    await tokenCounter.init();
    const summarizer = new MessageSummarizer(new (require('../src/inference/mock').MockInference)());
    const cwm = new ContextWindowManager({
      tokenCounter,
      summarizer,
      modelContextWindow: 128000,
      systemTokenBudget: 500,
      responseTokenBudget: 1000,
      minMessagesToKeep: 3,
    });

    const thread = Thread.create('test-session');
    for (let i = 0; i < 5; i++) {
      thread.messages.push(Message.create('user', `User message ${i}`));
      thread.messages.push(Message.create('assistant', `Assistant response ${i}`));
    }

    const result = await cwm.buildContext(thread, 'You are a helpful assistant.', [], 1000);
    await a.assertEqual(Array.isArray(result.messages), true, 'messages is array');
    await a.assertEqual(result.messages[0].role, 'system', 'first message is system prompt');
    await a.assertTrue(result.recentMessageCount > 0, 'has recent messages');
  });

  runner.test('ContextWindowManager.buildContext() includes RAG context as system message', async (a) => {
    const tokenCounter = new TokenCounter();
    await tokenCounter.init();
    const summarizer = new MessageSummarizer(new (require('../src/inference/mock').MockInference)());
    const cwm = new ContextWindowManager({
      tokenCounter,
      summarizer,
      modelContextWindow: 128000,
      systemTokenBudget: 500,
      responseTokenBudget: 1000,
      minMessagesToKeep: 3,
    });

    const thread = Thread.create('test-session');
    thread.messages.push(Message.create('user', 'what is RAG?'));
    thread.messages.push(Message.create('assistant', 'RAG is retrieval-augmented generation.'));

    const ragContext = [{ content: 'RAG stands for Retrieval-Augmented Generation.' }];
    const result = await cwm.buildContext(thread, 'You are helpful.', ragContext, 1000);

    const ragMsg = result.messages.find(m => m.content && m.content.includes('Retrieved Context'));
    await a.assertTrue(ragMsg !== undefined, 'RAG context included as system message');
  });

  runner.test('ContextWindowManager.buildContext() totalTokens is computed', async (a) => {
    const tokenCounter = new TokenCounter();
    await tokenCounter.init();
    const summarizer = new MessageSummarizer(new (require('../src/inference/mock').MockInference)());
    const cwm = new ContextWindowManager({
      tokenCounter,
      summarizer,
      modelContextWindow: 128000,
      systemTokenBudget: 500,
      responseTokenBudget: 1000,
      minMessagesToKeep: 3,
    });

    const thread = Thread.create('test-session');
    thread.messages.push(Message.create('user', 'hello'));
    thread.messages.push(Message.create('assistant', 'hi'));

    const result = await cwm.buildContext(thread, 'System prompt.', [], 1000);
    await a.assertTrue(result.totalTokens > 0, 'totalTokens is positive');
    await a.assertEqual(typeof result.totalTokens, 'number', 'totalTokens is a number');
  });

  runner.test('ContextWindowManager.buildContext() summaryUsed is false for short conversations', async (a) => {
    const tokenCounter = new TokenCounter();
    await tokenCounter.init();
    const summarizer = new MessageSummarizer(new (require('../src/inference/mock').MockInference)());
    const cwm = new ContextWindowManager({
      tokenCounter,
      summarizer,
      modelContextWindow: 128000,
      systemTokenBudget: 500,
      responseTokenBudget: 1000,
      minMessagesToKeep: 3,
    });

    const thread = Thread.create('test-session');
    thread.messages.push(Message.create('user', 'hello'));
    thread.messages.push(Message.create('assistant', 'hi'));

    const result = await cwm.buildContext(thread, 'System.', [], 1000);
    await a.assertEqual(result.summaryUsed, false, 'no summary needed for short convo');
  });

  // ── MessageSummarizer ──

  runner.test('MessageSummarizer.summarize() returns a string', async (a) => {
    const inference = new (require('../src/inference/mock').MockInference)();
    const summarizer = new MessageSummarizer(inference);
    const messages = [
      Message.create('user', 'what is RAG?'),
      Message.create('assistant', 'RAG is retrieval-augmented generation.'),
    ];
    const summary = await summarizer.summarize(messages);
    await a.assertEqual(typeof summary, 'string', 'summary is a string');
    await a.assertTrue(summary.length > 0, 'summary is non-empty');
  });

  // ── ThreadManager interface ──

  runner.test('ThreadManager has required methods', async (a) => {
    await a.assertEqual(typeof PostgresThreadManager.prototype.getOrCreate, 'function', 'has getOrCreate');
    await a.assertEqual(typeof PostgresThreadManager.prototype.addMessage, 'function', 'has addMessage');
    await a.assertEqual(typeof PostgresThreadManager.prototype.getThread, 'function', 'has getThread');
    await a.assertEqual(typeof PostgresThreadManager.prototype.updateSummary, 'function', 'has updateSummary');
    await a.assertEqual(typeof PostgresThreadManager.prototype.listThreads, 'function', 'has listThreads');
  });

  return runner;
}

module.exports = { setupTests };