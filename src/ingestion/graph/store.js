const { GraphStore } = require('../../shared/interfaces');
const neo4j = require('neo4j-driver');

class Neo4jGraphStore extends GraphStore {
  /**
   * Initialize the Neo4j graph store driver.
   * @param {string} uri - Neo4j bolt URI
   * @param {string} user - Neo4j username
   * @param {string} password - Neo4j password
   * @throws {Error} If the driver cannot connect (connection errors surface on first query)
   */
  constructor(uri, user, password) {
    super();
    this._driver = neo4j.driver(uri || 'bolt://localhost:7687', neo4j.auth.basic(user || 'neo4j', password || 'neo4j_password'));
  }

  /**
   * Store a single subject-predicate-object triple.
   * @param {Object} triple
   * @param {string} triple.subject - Subject entity name (case-insensitive, normalized to lowercase)
   * @param {string} triple.predicate - Relationship predicate
   * @param {string} triple.object - Object entity name (case-insensitive, normalized to lowercase)
   * @param {number} [triple.confidence=1.0] - Confidence score; note that 0 is preserved (not treated as missing)
   * @param {string} [triple.sourceChunkId=null] - Origin chunk ID for provenance
   * @throws {Error} If subject, predicate, or object are missing
   */
  async storeTriple(triple) {
    if (!triple.subject || !triple.predicate || !triple.object) {
      throw new Error('Triple must have subject, predicate, and object');
    }
    const session = this._driver.session();
    try {
      await session.run(
        `MERGE (s:Entity {name: $subject})
         MERGE (o:Entity {name: $object})
         CREATE (s)-[:RELATION {predicate: $predicate, confidence: $confidence, sourceChunkId: $sourceChunkId}]->(o)`,
        {
          subject: triple.subject.toLowerCase(),
          object: triple.object.toLowerCase(),
          predicate: triple.predicate,
          confidence: triple.confidence ?? 1.0,
          sourceChunkId: triple.sourceChunkId ?? null,
        }
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Store multiple triples in a single transaction.
   * @param {Array} triples - Array of triple objects (same shape as storeTriple)
   * @throws {Error} Database errors are rolled back and re-thrown
   * @note Unlike storeTriple, this does NOT validate required fields — invalid triples
   *       will cause a database error and rollback the entire batch.
   */
  async storeTriples(triples) {
    const session = this._driver.session();
    try {
      const tx = await session.beginTransaction();
      try {
        for (const t of triples) {
          await tx.run(
            `MERGE (s:Entity {name: $subject})
             MERGE (o:Entity {name: $object})
             CREATE (s)-[:RELATION {predicate: $predicate, confidence: $confidence, sourceChunkId: $sourceChunkId}]->(o)`,
            {
              subject: t.subject.toLowerCase(),
              object: t.object.toLowerCase(),
              predicate: t.predicate,
              confidence: t.confidence ?? 1.0,
              sourceChunkId: t.sourceChunkId ?? null,
            }
          );
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Query the graph for entities connected to the given entity.
   * @param {string} entityName - The entity name to query for (case-insensitive)
   * @param {number} [depth=1] - Desired hop depth; internally converted to maxDepth = max(0, depth - 1)
   * @returns {Promise<Array>} Array of unique triples sorted by confidence (descending)
   * @throws {Error} If APOC is not installed or not allowlisted (apoc.path.expand will fail)
   * @gotcha Neo4j 5.x requires `dbms.security.procedures.allowlist=apoc.*` in neo4j.conf,
   *          otherwise `apoc.path.expand` returns "no procedure registered".
   * @gotcha Native Cypher does NOT support parameterized path lengths (`*1..$depth`).
   *          This method uses `apoc.path.expand` specifically to accept `maxDepth` as a parameter.
   * @gotcha `depth=1` yields `maxDepth=0`, meaning NO path expansion — only direct neighbors.
   *          Use `depth=2` to get 1-hop neighbors, `depth=3` for 2-hop, etc.
   * @gotcha Entity names are normalized to lowercase at query time and at store time,
   *          so lookups are case-insensitive.
   */
  async queryByEntity(entityName, depth = 1) {
    const session = this._driver.session();
    try {
      const maxDepth = Math.max(0, depth - 1);
      const result = await session.run(
        `MATCH (start:Entity {name: $entityName})
         CALL apoc.path.expand(
           start,
           'RELATION',
           'Entity',
           0,
           $maxDepth
         )
         YIELD path
         WITH COLLECT(DISTINCT LAST(NODES(path)).name) AS entityNames
         MATCH (s:Entity)-[rel:RELATION]->(o:Entity)
         WHERE s.name IN entityNames OR o.name IN entityNames
         RETURN DISTINCT
           s.name AS subject,
           rel.predicate AS predicate,
           o.name AS object,
           rel.confidence AS confidence,
           rel.sourceChunkId AS sourceChunkId`,
        { entityName: entityName.toLowerCase(), maxDepth }
      );

      const triples = [];
      const seen = new Set();
      for (const record of result.records) {
        const key = `${record.get('subject')}|${record.get('predicate')}|${record.get('object')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        triples.push({
          subject: record.get('subject'),
          predicate: record.get('predicate'),
          object: record.get('object'),
          confidence: record.get('confidence') ?? 1.0,
          sourceChunkId: record.get('sourceChunkId') ?? null,
        });
      }

      return triples.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    } finally {
      await session.close();
    }
  }

  /**
   * Query multiple entities in parallel and merge results.
   * @param {string[]} entityNames - Array of entity names to query
   * @param {number} depth - Passed through to queryByEntity
   * @returns {Promise<Array>} Deduplicated, confidence-sorted triples
   * @note Deduplication uses a Map keyed on `subject|predicate|object` (lowercased).
   */
  async queryByEntities(entityNames, depth = 1) {
    if (!entityNames || entityNames.length === 0) return [];
    const sets = await Promise.all(entityNames.map(e => this.queryByEntity(e, depth)));
    const seen = new Map();
    for (const batch of sets) {
      for (const t of batch) {
        const key = `${t.subject.toLowerCase()}|${t.predicate}|${t.object.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, t);
      }
    }
    return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Delete all nodes and relationships from the graph.
   * @returns {Promise<void>}
   */
  async clear() {
    const session = this._driver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
  }

  /**
   * Return graph statistics.
   * @returns {Promise<{ tripleCount: number, entityCount: number }>}
   */
  async getStats() {
    const session = this._driver.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity)
         RETURN count(e) AS entityCount`
      );
      const entityCount = Number(result.records[0]?.get('entityCount') ?? 0);

      const relResult = await session.run(
        `MATCH ()-[r:RELATION]->()
         RETURN count(r) AS tripleCount`
      );
      const tripleCount = Number(relResult.records[0]?.get('tripleCount') ?? 0);

      return { tripleCount, entityCount };
    } finally {
      await session.close();
    }
  }

  /**
   * Close the underlying driver and release all connections.
   * @returns {Promise<void>}
   */
  async close() {
    await this._driver.close();
  }
}

module.exports = { Neo4jGraphStore };