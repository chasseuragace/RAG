class RetrievalAssessment {
  constructor({
    quality = 0,
    completeness = 0,
    consistency = 0,
    sourceDiversity = 0,
    missingEvidence = { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] }
  }) {
    this.quality = quality;
    this.completeness = completeness;
    this.consistency = consistency;
    this.sourceDiversity = sourceDiversity;
    this.missingEvidence = missingEvidence;
  }

  /**
   * Factory with input validation.
   *
   * Numeric scores (quality, completeness, consistency) are clamped to [0, 1]
   * and must be finite numbers — LLM judges can return out-of-range or NaN
   * values, and letting those propagate silently would corrupt every downstream
   * threshold comparison. sourceDiversity is clamped to [0, ∞).
   *
   * missingEvidence arrays are defaulted to [] if the caller passes null/undefined
   * for any field, so partial LLM responses don't blow up array operations in
   * the judge or policy.
   */
  static create(quality, completeness, consistency, sourceDiversity, missingEvidence = {}) {
    const clamp01 = (v, name) => {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        // Warn but don't throw — fall back to 0 so the loop can continue.
        console.warn(`[RetrievalAssessment] ${name} is not a finite number (got ${v}), defaulting to 0`);
        return 0;
      }
      return Math.max(0, Math.min(1, n));
    };

    const me = missingEvidence || {};
    return new RetrievalAssessment({
      quality:         clamp01(quality, 'quality'),
      completeness:    clamp01(completeness, 'completeness'),
      consistency:     clamp01(consistency, 'consistency'),
      sourceDiversity: Math.max(0, Math.floor(Number(sourceDiversity) || 0)),
      missingEvidence: {
        missingConcepts:    Array.isArray(me.missingConcepts)    ? me.missingConcepts    : [],
        ambiguousTerms:     Array.isArray(me.ambiguousTerms)     ? me.ambiguousTerms     : [],
        conflictingEvidence:Array.isArray(me.conflictingEvidence) ? me.conflictingEvidence : [],
        unsupportedClaims:  Array.isArray(me.unsupportedClaims)  ? me.unsupportedClaims  : [],
      },
    });
  }
}

module.exports = { RetrievalAssessment };
