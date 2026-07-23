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

  static create(quality, completeness, consistency, sourceDiversity, missingEvidence = { missingConcepts: [], ambiguousTerms: [], conflictingEvidence: [], unsupportedClaims: [] }) {
    return new RetrievalAssessment({ quality, completeness, consistency, sourceDiversity, missingEvidence });
  }
}

module.exports = { RetrievalAssessment };
