/**
 * MockMetadataFilter — development-mode metadata filter.
 *
 * Swap for a more sophisticated implementation (probabilistic, weighted,
 * multi-label) by implementing the MetadataFilter interface.
 *
 * build(entities)           → filter object   — picks the "primary" entity per label.
 * match(chunkMetadata, filter) → boolean      — true if chunk passes all filter clauses.
 * filterResults(results, filter) → results[]  — convenience: filters an array of results.
 *
 * Filter strategy (current mock):
 *   - Uses only DISEASE as a hard filter (highest specificity in biomedical domain).
 *   - DRUG / GENE / BIOMARKER are recorded in the filter for observability but
 *     treated as soft (non-blocking) by default — pass strictLabels to harden them.
 *   - A chunk passes if it has at least one entity from every hard label in the filter.
 *   - If the filter is empty, ALL chunks pass (graceful degradation).
 */

const { MetadataFilter } = require('../core/interfaces');

// Labels that will block a chunk if none of the filter values match.
const DEFAULT_HARD_LABELS = ['DISEASE'];

class MockMetadataFilter extends MetadataFilter {
  /**
   * @param {string[]} [hardLabels]  Labels treated as mandatory. Defaults to ['DISEASE'].
   */
  constructor(hardLabels = DEFAULT_HARD_LABELS) {
    super();
    this.hardLabels = new Set(hardLabels.map(l => l.toUpperCase()));
  }

  /**
   * Build a filter object from an entity map.
   *
   * Strategy: for each label take all values (full set, not just the first),
   * so the matcher can do set-intersection rather than single-value equality.
   *
   * @param {Record<string, string[]>} entities  e.g. { DRUG: ['azt'], DISEASE: ['hiv'] }
   * @returns {Record<string, Set<string>>}       e.g. { DRUG: Set{'azt'}, DISEASE: Set{'hiv'} }
   */
  build(entities) {
    const filter = {};
    for (const [label, values] of Object.entries(entities || {})) {
      if (Array.isArray(values) && values.length > 0) {
        filter[label.toUpperCase()] = new Set(values.map(v => v.toLowerCase()));
      }
    }
    return filter;
  }

  /**
   * Test whether a single chunk's metadata passes the filter.
   *
   * Chunk metadata is expected to carry an `entities` field set by the
   * injection pipeline, e.g.:
   *   { entities: { DRUG: ['azt'], DISEASE: ['hiv', 'aids'] } }
   *
   * @param {object} chunkMetadata
   * @param {Record<string, Set<string>>} filter  Produced by build().
   * @returns {boolean}
   */
  match(chunkMetadata, filter) {
    if (!filter || Object.keys(filter).length === 0) return true;

    const chunkEntities = chunkMetadata && chunkMetadata.entities
      ? chunkMetadata.entities
      : {};

    for (const label of this.hardLabels) {
      if (!filter[label]) continue; // label not in filter — skip
      const filterValues = filter[label]; // Set
      const chunkValues = (chunkEntities[label] || []).map(v => v.toLowerCase());
      const hasMatch = chunkValues.some(v => filterValues.has(v));
      if (!hasMatch) return false;
    }
    return true;
  }

  /**
   * Convenience wrapper: filter an array of result objects.
   * Each result is expected to have a `.metadata` field.
   *
   * @param {object[]} results
   * @param {Record<string, Set<string>>} filter
   * @returns {object[]}
   */
  filterResults(results, filter) {
    if (!filter || Object.keys(filter).length === 0) return results;
    return results.filter(r => this.match(r.metadata || {}, filter));
  }
}

module.exports = { MockMetadataFilter, DEFAULT_HARD_LABELS };
