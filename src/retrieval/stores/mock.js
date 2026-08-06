const { VectorStore } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class MockVectorStore extends VectorStore {
  constructor() { super(); this.docs = new Map(); this.queryCount = 0; }
  async store(id, embedding, metadata) { this.docs.set(id, { embedding, metadata }); serverEvents.logEvent('vectorstore:stored', { id }); }
  _cosineSimilarity(a,b) { let dot=0, normA=0, normB=0; for(let i=0;i<a.length;i++) { dot+=a[i]*b[i]; normA+=a[i]*a[i]; normB+=b[i]*b[i]; } normA=Math.sqrt(normA); normB=Math.sqrt(normB); return normA&&normB?dot/(normA*normB):0; }
  async query(q, topK=5) { const start=Date.now(); this.queryCount++; const results=[]; for(const[id,{embedding,metadata}] of this.docs) results.push({id,score:this._cosineSimilarity(q,embedding),metadata}); const sorted=results.sort((a,b)=>b.score-a.score).slice(0,topK); serverEvents.logEvent('vectorstore:queried',{count:sorted.length,duration:Date.now()-start}); return sorted; }
  async clear() { this.docs.clear(); this.queryCount=0; serverEvents.logEvent('vectorstore:cleared',{}); }
  async deleteByDocId(docId) {
    let removed = 0;
    for (const [id, { metadata }] of this.docs) {
      if (metadata && metadata.original_id === docId) { this.docs.delete(id); removed++; }
    }
    serverEvents.logEvent('vectorstore:deleted', { docId, removed });
    return removed;
  }
  async getStats() { return { totalDocuments: this.docs.size, queryCount: this.queryCount }; }
}

module.exports = { MockVectorStore };
