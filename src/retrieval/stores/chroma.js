const { VectorStore } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class ChromaVectorStore extends VectorStore {
  constructor(baseUrl='http://localhost:8000', collectionName='rag_documents', tenant='default_tenant', database='default_database') {
    super();
    this.baseUrl = baseUrl;
    this.collectionName = collectionName;
    this.tenant = tenant;
    this.database = database;
    this.collectionId = null;
  }
  async _ensureCollection() {
    if (this.collectionId) return this.collectionId;
    await fetch(`${this.baseUrl}/api/v2/heartbeat`).catch(() => { throw new Error('Chroma unreachable'); });
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.collectionName, metadata: { "hnsw:space": "cosine" }, get_or_create: true })
    });
    if (!res.ok) throw new Error(`Chroma collection error: ${res.status}`);
    const data = await res.json();
    this.collectionId = data.id;
    return this.collectionId;
  }
  async store(id, embedding, metadata) {
    const colId = await this._ensureCollection();
    const content = metadata.content || '';
    const chromaMeta = { ...metadata };
    delete chromaMeta.content;
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], embeddings: [embedding], metadatas: [chromaMeta], documents: [content] })
    });
    if (!res.ok) throw new Error(`Chroma add error: ${res.status}`);
    serverEvents.logEvent('vectorstore:stored', { id });
  }
  async query(queryEmbedding, topK=5) {
    const start = Date.now();
    const colId = await this._ensureCollection();
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_embeddings: [queryEmbedding], n_results: topK, include: ['metadatas', 'documents', 'distances'] })
    });
    if (!res.ok) throw new Error(`Chroma query error: ${res.status}`);
    const data = await res.json();
    const results = [];
    if (data.ids && data.ids[0]) {
      for (let i = 0; i < data.ids[0].length; i++) {
        results.push({
          id: data.ids[0][i],
          score: 1 - data.distances[0][i],
          metadata: { ...(data.metadatas[0][i] || {}), content: data.documents[0][i] || '' }
        });
      }
    }
    serverEvents.logEvent('vectorstore:queried', { count: results.length, duration: Date.now()-start });
    return results;
  }
  async clear() {
    try {
      await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${this.collectionName}`, { method: 'DELETE' });
    } catch(e) {}
    this.collectionId = null;
    serverEvents.logEvent('vectorstore:cleared', {});
  }
  async deleteByDocId(docId) {
    const colId = await this._ensureCollection();
    const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: { original_id: docId } })
    });
    if (!res.ok) throw new Error(`Chroma delete error: ${res.status}`);
    serverEvents.logEvent('vectorstore:deleted', { docId });
  }
  async getStats() {
    try {
      const colId = await this._ensureCollection();
      const res = await fetch(`${this.baseUrl}/api/v2/tenants/${this.tenant}/databases/${this.database}/collections/${colId}/count`);
      if (!res.ok) return { totalDocuments: 0, status: 'error' };
      const count = await res.json();
      return { totalDocuments: count, status: 'ready' };
    } catch(e) { return { totalDocuments: 0, status: 'error', error: e.message }; }
  }
}

module.exports = { ChromaVectorStore };
