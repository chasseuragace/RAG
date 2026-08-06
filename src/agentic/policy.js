class RetrievalPolicy {
  resolve(assessment, goal, trace, observation = null) {
    throw new Error('not implemented');
  }
}

module.exports = { RetrievalPolicy };
