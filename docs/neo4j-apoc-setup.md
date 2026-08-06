# Neo4j APOC Setup Procedure

## Summary

This document captures the procedure for enabling APOC in a Neo4j Docker container, including the failures encountered and the correct resolution.

## What We Wanted

APOC (Awesome Procedures on Cypher) is a Neo4j plugin that provides `apoc.path.expand`, which allows dynamic path-length patterns in Cypher queries — something Neo4j's native Cypher does not support (parameters cannot be used as hop counts in variable-length path patterns like `[:RELATION*1..$depth]`).

## Procedure

### Step 1: Add APOC to docker-compose.yml

```yaml
neo4j:
  image: neo4j:5.26.0
  environment:
    - NEO4J_AUTH=neo4j/neo4j_password
    - NEO4J_PLUGINS=["apoc"]
```

**Critical:** `NEO4J_PLUGINS` must be a valid JSON array with **double quotes**, not single quotes.

- ❌ Wrong: `NEO4J_PLUGINS=['apoc']` — YAML parses this as a string, not a JSON array
- ✅ Correct: `NEO4J_PLUGINS=["apoc"]` — YAML parses this as a JSON array

### Step 2: Recreate the container (not just restart)

The `NEO4J_PLUGINS` env var is evaluated at **container creation time**, not at restart. A `docker-compose restart` is NOT sufficient.

```bash
docker-compose down neo4j && docker-compose up -d neo4j
```

### Step 3: Verify APOC is installed

```bash
docker exec neo4j-db ls -la /var/lib/neo4j/plugins/
# Should show apoc.jar
```

### Step 4: Enable APOC in Neo4j config

APOC procedures are restricted by default. You need to add them to the allowlist:

```bash
docker exec neo4j-db bash -c "echo 'dbms.security.procedures.allowlist=apoc.*' >> /var/lib/neo4j/conf/neo4j.conf"
```

Then restart Neo4j:

```bash
docker-compose restart neo4j
```

### Step 5: Verify APOC procedures are callable

```bash
docker exec neo4j-db cypher-shell -u neo4j -p neo4j_password "CALL apoc.version()"
```

Also verify specific procedures you need:

```bash
docker exec neo4j-db cypher-shell -u neo4j -p neo4j_password "SHOW PROCEDURES YIELD name WHERE name CONTAINS 'path' RETURN name"
```

## Failures Encountered

### Failure 1: Single-quoted NEO4J_PLUGINS

**Symptom:** APOC jar not downloaded, `CALL apoc.version()` returns "no procedure registered"

**Root cause:** `NEO4J_PLUGINS=['apoc']` uses single quotes. YAML parses this as a string literal `'[apoc]'`, not a JSON array `["apoc"]`. The Neo4j startup script expects a JSON array and silently ignores invalid values.

**Fix:** Use double quotes: `NEO4J_PLUGINS=["apoc"]`

### Failure 2: Restart instead of recreate

**Symptom:** APOC jar exists in `/var/lib/neo4j/plugins/` but procedures still not callable

**Root cause:** The `NEO4J_PLUGINS` env var triggers plugin download at container **creation** time. A `docker-compose restart` reuses the existing container and does not re-evaluate env vars.

**Fix:** Use `docker-compose down neo4j && docker-compose up -d neo4j` to recreate the container.

### Failure 3: Missing allowlist

**Symptom:** APOC jar is installed, `apoc.version()` works, but `apoc.path.expand` returns "no procedure registered"

**Root cause:** Neo4j 5.x restricts which procedures can be called via `dbms.security.procedures.allowlist`. The default allowlist only includes `apoc.coll.*`, `apoc.load.*`, and `gds.*`. APOC path procedures (`apoc.path.*`) are not in the default allowlist.

**Fix:** Add `dbms.security.procedures.allowlist=apoc.*` to `/var/lib/neo4j/conf/neo4j.conf`

### Failure 4: Using parameters in Cypher path-length patterns

**Symptom:** `MATCH (start)-[:RELATION*1..$depth]-(connected)` throws "Parameter maps cannot be used in MATCH patterns"

**Root cause:** Neo4j Cypher requires literal integers for variable-length path patterns. Parameters like `$depth` are not allowed in the `*1..N` syntax.

**Fix:** Use `apoc.path.expand(startNode, relationshipFilter, nodeFilter, minLevel, maxLevel)` which accepts parameters for all arguments including maxLevel.

## Usage in Node.js

```javascript
const { Neo4jGraphStore } = require('./src/ingestion/graph/store');

// Initialize the Neo4j graph store with connection details
// @param {string} uri - Neo4j bolt URI (default: bolt://localhost:7687)
// @param {string} user - Neo4j username (default: neo4j)
// @param {string} password - Neo4j password (default: neo4j_password)
const store = new Neo4jGraphStore(
  process.env.RAG_NEO4J_URI || 'bolt://localhost:7687',
  process.env.RAG_NEO4J_USER || 'neo4j',
  process.env.RAG_NEO4J_PASSWORD || 'neo4j_password'
);

// Store a triple (subject-predicate-object relationship) in the graph
// @param {Object} triple - The triple to store
// @param {string} triple.subject - The subject entity/node name
// @param {string} triple.predicate - The relationship type between entities
// @param {string} triple.object - The object entity/node name
// @param {number} [triple.confidence=1.0] - Confidence score for the relationship (0.0 to 1.0)
// @returns {Promise<void>}
await store.storeTriple({ subject: 'AZT', predicate: 'TREATS', object: 'HIV', confidence: 0.85 });

// Query the graph for entities connected to a given entity within a specified depth
// Uses apoc.path.expand for dynamic-depth path traversal
// @param {string} entity - The entity name to query for
// @param {number} depth - Maximum hop depth for path expansion
// @returns {Promise<Array>} Array of connected entities and their paths
const results = await store.queryByEntity('AZT', 1);
```

## Key Takeaways

1. Always use JSON array format `["apoc"]` for `NEO4J_PLUGINS` in docker-compose.yml
2. Always recreate containers (not restart) when changing env vars that affect plugin installation
3. Always add `apoc.*` to the allowlist in Neo4j 5.x
4. Use `apoc.path.expand` for dynamic-depth path queries — Neo4j native Cypher does not support parameterized path lengths