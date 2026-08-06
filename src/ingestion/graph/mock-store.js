/**
 * MockGraphStore — in-memory knowledge-graph triple store.
 *
 * Swap for Neo4j, ArangoDB, or any property graph by implementing
 * the GraphStore interface from src/core/interfaces.js.
 *
 * Data model:
 *   Triple = { subject, predicate, object, confidence, sourceChunkId, metadata }
 *
 * Internal representation:
 *   - this._triples: Triple[]                  — flat list (source of truth)
 *   - this._byEntity: Map<string, Set<number>> — entity → triple indices (both subject + object)
 *
 * All entity lookups are case-insensitive.
 */

const { GraphStore } = require('../../shared/interfaces');

class MockGraphStore extends GraphStore {
  constructor() {
    super();
    this._triples   = [];            // Triple[]
    this._byEntity  = new Map();     // normalised entity string → Set<tripleIndex>
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Store a single triple.
   * @param {{ subject: string, predicate: string, object: string,
   *            confidence?: number, sourceChunkId?: string, metadata?: object }} triple
   */
  async storeTriple(triple) {
    if (!triple.subject || !triple.predicate || !triple.object) {
      throw new Error('Triple must have subject, predicate, and object');
    }
    const idx = this._triples.length;
    this._triples.push({
      subject:       triple.subject,
      predicate:     triple.predicate,
      object:        triple.object,
      confidence:    triple.confidence  ?? 1.0,
      sourceChunkId: triple.sourceChunkId ?? null,
      metadata:      triple.metadata   ?? {},
    });
    this._addToIndex(triple.subject, idx);
    this._addToIndex(triple.object,  idx);
  }

  /**
   * Store multiple triples at once.
   * @param {object[]} triples
   */
  async storeTriples(triples) {
    for (const t of triples) await this.storeTriple(t);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find all triples reachable from a single entity within `depth` hops.
   *
   * depth=1 → direct neighbours only (all triples where entity is subject or object)
   * depth=2 → neighbours of neighbours, etc.
   *
   * Returns triples de-duplicated by index, sorted by confidence desc.
   *
   * @param {string} entityName
   * @param {number} [depth=1]
   * @returns {Promise<object[]>}
   */
  async queryByEntity(entityName, depth = 1) {
    const seen = new Set();
    const frontier = new Set([this._norm(entityName)]);
    const result   = new Set();

    for (let hop = 0; hop < depth; hop++) {
      const nextFrontier = new Set();
      for (const entity of frontier) {
        const indices = this._byEntity.get(entity) || new Set();
        for (const idx of indices) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          result.add(idx);
          const t = this._triples[idx];
          nextFrontier.add(this._norm(t.subject));
          nextFrontier.add(this._norm(t.object));
        }
      }
      // Advance frontier to newly discovered entities
      for (const e of nextFrontier) frontier.add(e);
    }

    return [...result]
      .map(i => this._triples[i])
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Query for all entities at once, returning the union of their reachable triples.
   * @param {string[]} entityNames
   * @param {number}   [depth=1]
   * @returns {Promise<object[]>}
   */
  async queryByEntities(entityNames, depth = 1) {
    if (!entityNames || entityNames.length === 0) return [];
    const sets = await Promise.all(entityNames.map(e => this.queryByEntity(e, depth)));
    // De-duplicate by (subject+predicate+object) key
    const seen = new Map();
    for (const batch of sets) {
      for (const t of batch) {
        const key = `${this._norm(t.subject)}|${t.predicate}|${this._norm(t.object)}`;
        if (!seen.has(key)) seen.set(key, t);
      }
    }
    return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  }

  async clear() {
    this._triples  = [];
    this._byEntity = new Map();
  }

  async getStats() {
    const entities = new Set();
    for (const t of this._triples) {
      entities.add(this._norm(t.subject));
      entities.add(this._norm(t.object));
    }
    return { tripleCount: this._triples.length, entityCount: entities.size };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _norm(str) { return (str || '').toLowerCase().trim(); }

  _addToIndex(entity, idx) {
    const key = this._norm(entity);
    if (!this._byEntity.has(key)) this._byEntity.set(key, new Set());
    this._byEntity.get(key).add(idx);
  }
}

module.exports = { MockGraphStore };
