const { DocumentLoader } = require('../../shared/interfaces');

class MockDocumentLoader extends DocumentLoader {
  constructor(mockDocs = null) {
    super();
    this.mockDocuments = mockDocs || [
      { id: 'ai.md', content: 'Artificial Intelligence is transforming technology.', metadata: { file: 'ai.md' } },
      { id: 'ml.md', content: 'Machine Learning is a subset of AI.', metadata: { file: 'ml.md' } },
      { id: 'dl.md', content: 'Deep Learning uses neural networks.', metadata: { file: 'dl.md' } }
    ];
  }
  async loadDocuments(folderPath) { return this.mockDocuments; }
}

module.exports = { MockDocumentLoader };
