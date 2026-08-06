/**
 * MockProvenanceAnnotator — development-mode authority annotator.
 *
 * Runs at ingestion time. Reads a document's raw metadata and produces an
 * `authority_signal` object that rides on every chunk from that document.
 *
 * Swap for a real implementation (crawl journal APIs, parse DOI metadata,
 * query citation databases) by implementing the ProvenanceAnnotator interface.
 *
 * annotate(docMetadata) → authoritySignal
 *
 * authoritySignal shape:
 * {
 *   source_domain:         string,   — inferred from filename / path / url
 *   document_type:         string,   — inferred from filename conventions
 *   publication_year:      number,   — from mtime or explicit metadata field
 *   citation_count:        number,   — 0 in mock (no live lookup)
 *   journal_impact_factor: number,   — 0 in mock (no live lookup)
 * }
 *
 * ─── Inference heuristics (mock) ──────────────────────────────────────────
 * source_domain:  extracted from metadata.source_url, or from filename prefix.
 * document_type:  keyword scan of filename / metadata.type field.
 * publication_year: metadata.mtime year, or current year as fallback.
 */

const { ProvenanceAnnotator } = require('../core/interfaces');

// Document-type keywords → canonical type label
// Checked in order; first match wins.
const DOC_TYPE_PATTERNS = [
  { pattern: /meta.?analysis|systematic.?review/i, type: 'meta-analysis'   },
  { pattern: /rct|randomis|randomiz|clinical.?trial/i, type: 'RCT'         },
  { pattern: /cohort|observational/i,                  type: 'cohort-study' },
  { pattern: /case.?report|case.?series/i,             type: 'case-report'  },
  { pattern: /review/i,                                type: 'review'       },
  { pattern: /guideline|recommendation/i,              type: 'guideline'    },
  { pattern: /editorial|opinion|commentary/i,          type: 'editorial'    },
  { pattern: /preprint|biorxiv|medrxiv/i,              type: 'preprint'     },
  { pattern: /patent/i,                                type: 'patent'       },
  { pattern: /textbook|chapter/i,                      type: 'textbook'     },
];

// Domain extraction: try these metadata fields in order.
const DOMAIN_FIELDS = ['source_url', 'url', 'source', 'origin', 'path', 'filename', 'id'];

class MockProvenanceAnnotator extends ProvenanceAnnotator {
  /**
   * @param {object} [defaults]  Fallback values when a field cannot be inferred.
   *   Defaults: { source_domain: 'unknown', document_type: 'unknown', citation_count: 0, journal_impact_factor: 0 }
   */
  constructor(defaults = {}) {
    super();
    this.defaults = {
      source_domain:         'unknown',
      document_type:         'unknown',
      citation_count:        0,
      journal_impact_factor: 0,
      ...defaults,
    };
  }

  /**
   * @param {object} docMetadata  — whatever the DocumentLoader attaches to doc.metadata
   * @returns {{ source_domain, document_type, publication_year, citation_count, journal_impact_factor }}
   */
  annotate(docMetadata) {
    const meta = docMetadata || {};

    return {
      source_domain:         this._inferDomain(meta),
      document_type:         this._inferDocType(meta),
      publication_year:      this._inferYear(meta),
      citation_count:        meta.citation_count        ?? this.defaults.citation_count,
      journal_impact_factor: meta.journal_impact_factor ?? this.defaults.journal_impact_factor,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _inferDomain(meta) {
    for (const field of DOMAIN_FIELDS) {
      const val = meta[field];
      if (!val) continue;
      // Try to extract a hostname from a URL
      const urlMatch = String(val).match(/https?:\/\/([^/]+)/i);
      if (urlMatch) return urlMatch[1].replace(/^www\./, '');
      // Fall back to the raw value if it looks like a domain
      if (/\.[a-z]{2,}$/i.test(String(val))) return String(val).replace(/^www\./, '');
    }
    return this.defaults.source_domain;
  }

  _inferDocType(meta) {
    // Concatenate every string field to search for type keywords
    const haystack = Object.values(meta)
      .filter(v => typeof v === 'string')
      .join(' ');
    for (const { pattern, type } of DOC_TYPE_PATTERNS) {
      if (pattern.test(haystack)) return type;
    }
    return meta.document_type || this.defaults.document_type;
  }

  _inferYear(meta) {
    if (meta.publication_year && Number.isFinite(meta.publication_year)) {
      return meta.publication_year;
    }
    if (meta.mtime) {
      const year = new Date(meta.mtime).getFullYear();
      if (year > 1900 && year <= new Date().getFullYear() + 1) return year;
    }
    return new Date().getFullYear();
  }
}

module.exports = { MockProvenanceAnnotator, DOC_TYPE_PATTERNS };
