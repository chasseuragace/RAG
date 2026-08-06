/**
 * StaticDictionaryScorer — development-mode AuthorityScorer.
 *
 * Computes an authority score in [0.0, 1.0] from three independent signals,
 * each weighted and combined linearly:
 *
 *   authority_score = w_domain   * domain_score(source_domain)
 *                   + w_doctype  * doctype_score(document_type)
 *                   + w_recency  * recency_score(publication_year)
 *
 * All signal maps and weights are configurable at construction time.
 * updateWeights() allows live recalibration without restarting.
 *
 * Swap for GraphCentralityScorer (reads PageRank from the graph DB) or
 * NeuralAuthorityScorer by implementing the AuthorityScorer interface.
 */

const { AuthorityScorer } = require('../../shared/interfaces');

// ─── Default signal maps ───────────────────────────────────────────────────

/**
 * Domain → score in [0, 1].
 * Biomedical / clinical authority hierarchy.
 */
const DEFAULT_DOMAIN_SCORES = {
  // Top-tier journals
  'nejm.org':              1.00,
  'thelancet.com':         0.98,
  'jamanetwork.com':       0.97,
  'bmj.com':               0.96,
  'nature.com':            0.95,
  'science.org':           0.94,
  'cell.com':              0.93,
  // High-quality open access
  'nih.gov':               0.90,
  'pubmed.ncbi.nlm.nih.gov': 0.90,
  'biorxiv.org':           0.60,
  'medrxiv.org':           0.60,
  // Regulatory / clinical guidelines
  'fda.gov':               0.88,
  'ema.europa.eu':         0.87,
  'who.int':               0.85,
  'cdc.gov':               0.85,
  'nice.org.uk':           0.84,
  // Textbooks / educational
  'uptodate.com':          0.80,
  'medscape.com':          0.65,
  // Preprints / blogs / unknown
  'unknown':               0.30,
};

/**
 * Document type → score in [0, 1].
 * Evidence hierarchy: meta-analysis > RCT > cohort > review > case-report > editorial > preprint
 */
const DEFAULT_DOCTYPE_SCORES = {
  'meta-analysis':  1.00,
  'RCT':            0.90,
  'cohort-study':   0.75,
  'guideline':      0.85,
  'review':         0.65,
  'textbook':       0.60,
  'case-report':    0.45,
  'editorial':      0.35,
  'patent':         0.30,
  'preprint':       0.25,
  'unknown':        0.30,
};

const CURRENT_YEAR = new Date().getFullYear();

// ─────────────────────────────────────────────────────────────────────────────

class StaticDictionaryScorer extends AuthorityScorer {
  /**
   * @param {object} [opts]
   * @param {Record<string, number>} [opts.domainScores]   Override domain map.
   * @param {Record<string, number>} [opts.docTypeScores]  Override doc-type map.
   * @param {object}                 [opts.weights]        Signal weights (must sum to 1).
   *   Default: { domain: 0.40, docType: 0.40, recency: 0.20 }
   * @param {number}                 [opts.recencyHalfLife] Years for recency to reach 0.5. Default 10.
   */
  constructor(opts = {}) {
    super();
    this._domainScores  = { ...DEFAULT_DOMAIN_SCORES,  ...(opts.domainScores  || {}) };
    this._docTypeScores = { ...DEFAULT_DOCTYPE_SCORES, ...(opts.docTypeScores || {}) };
    this._weights = {
      domain:  0.40,
      docType: 0.40,
      recency: 0.20,
      ...(opts.weights || {}),
    };
    this._recencyHalfLife = opts.recencyHalfLife ?? 10; // years
  }

  /**
   * @param {object} authoritySignal  — produced by ProvenanceAnnotator at ingestion
   * @returns {number}  score in [0.0, 1.0]
   */
  computeScore(authoritySignal) {
    const signal = authoritySignal || {};

    const domainScore  = this._scoreDomain(signal.source_domain);
    const docTypeScore = this._scoreDocType(signal.document_type);
    const recencyScore = this._scoreRecency(signal.publication_year);

    const raw = (
      this._weights.domain  * domainScore  +
      this._weights.docType * docTypeScore +
      this._weights.recency * recencyScore
    );

    // Clamp to [0, 1]
    return Math.min(1, Math.max(0, raw));
  }

  /**
   * Merge new weight/score overrides at runtime.
   * @param {{ domainScores?, docTypeScores?, weights? }} newGroundTruth
   */
  updateWeights(newGroundTruth) {
    if (newGroundTruth.domainScores)  Object.assign(this._domainScores,  newGroundTruth.domainScores);
    if (newGroundTruth.docTypeScores) Object.assign(this._docTypeScores, newGroundTruth.docTypeScores);
    if (newGroundTruth.weights)       Object.assign(this._weights,       newGroundTruth.weights);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _scoreDomain(domain) {
    if (!domain) return this._domainScores['unknown'] ?? 0.30;
    const key = domain.toLowerCase().replace(/^www\./, '');
    // Exact match first
    if (this._domainScores[key] !== undefined) return this._domainScores[key];
    // Suffix match: "journals.plos.org" → "plos.org"
    for (const [k, v] of Object.entries(this._domainScores)) {
      if (key.endsWith(k)) return v;
    }
    return this._domainScores['unknown'] ?? 0.30;
  }

  _scoreDocType(docType) {
    if (!docType) return this._docTypeScores['unknown'] ?? 0.30;
    return this._docTypeScores[docType] ?? this._docTypeScores['unknown'] ?? 0.30;
  }

  /**
   * Exponential recency decay.
   * score = 0.5 ^ ((currentYear - pubYear) / halfLife)
   * → score = 1.0 when pubYear = currentYear
   * → score = 0.5 when age = halfLife years
   * → score ≈ 0.0 for very old documents
   */
  _scoreRecency(publicationYear) {
    if (!publicationYear || !Number.isFinite(publicationYear)) return 0.5; // neutral
    const age = Math.max(0, CURRENT_YEAR - publicationYear);
    return Math.pow(0.5, age / this._recencyHalfLife);
  }
}

module.exports = { StaticDictionaryScorer, DEFAULT_DOMAIN_SCORES, DEFAULT_DOCTYPE_SCORES };
