class TokenCounter {
  constructor(model = 'gpt-4') {
    this._model = model;
    this._encoder = null;
    this._useFallback = true;
  }

  async init() {
    if (!this._useFallback) return;
    try {
      const { encodingForModel } = require('js-tiktoken');
      this._encoder = encodingForModel(this._model);
      this._useFallback = false;
    } catch (e) {
      // @gotcha js-tiktoken is optional. If it fails to load (not installed,
      //       WASM init error, missing model encoding), we silently fall back
      //       to a character/4 estimator. This is within ~10% margin for
      //       most models but is NOT an exact tokenizer count.
      this._useFallback = true;
    }
  }

  count(text) {
    if (!this._useFallback && this._encoder) {
      return this._encoder.encode(text).length;
    }
    // @gotcha Character/4 heuristic is a rough estimator. Gemini uses its own
    //       tokenizer which may differ. Treat counts as budget estimates,
    //       not exact values. Over-estimation is safe (we may truncate
    //       slightly early); under-estimation risks context-length errors.
    return Math.ceil(text.length / 4);
  }

  countMessages(messages) {
    let total = 0;
    for (const m of messages) {
      total += 4;
      total += this.count(m.role || '');
      total += this.count(m.content || '');
    }
    return total;
  }
}

module.exports = { TokenCounter };