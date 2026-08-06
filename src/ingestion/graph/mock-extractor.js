/**
 * MockRelationshipExtractor — development-mode triple extractor.
 *
 * Uses pattern matching on text to produce Subject-Predicate-Object triples.
 * Swap for REBEL, OpenIE, or a fine-tuned extraction model by implementing
 * the RelationshipExtractor interface from src/core/interfaces.js.
 *
 * extract(text, sourceChunkId) → Promise<Triple[]>
 *   Triple = { subject, predicate, object, confidence, sourceChunkId }
 *
 * ─── Extraction strategy ──────────────────────────────────────────────────
 * Each rule is a { regex, subject, predicate, object, confidence } descriptor.
 * Named capture groups ($subject, $object) map regex captures to triple slots.
 * Rules are tried in order; a single sentence can produce multiple triples.
 */

const { RelationshipExtractor } = require('../../shared/interfaces');

// ─── Rule set ─────────────────────────────────────────────────────────────────
// Each entry: { re: RegExp, subjectGroup, predicateLabel, objectGroup, confidence }
// subjectGroup / objectGroup = named capture group in the regex (string).
// predicateLabel = the fixed predicate string to use in the triple.

const RULES = [
  // "AZT treats HIV" / "zidovudine treats AIDS"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+(?:treats?|is used (?:to treat|for))\s+(?<object>[A-Za-z0-9\-]+)/gi,
    predicateLabel: 'TREATS', confidence: 0.85,
  },
  // "AZT inhibits reverse transcriptase"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+inhibits?\s+(?<object>[A-Za-z0-9\-\s]+?)(?=[,.\n]|$)/gi,
    predicateLabel: 'INHIBITS', confidence: 0.80,
  },
  // "HIV causes AIDS" / "HIV leads to immunodeficiency"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+(?:causes?|leads? to)\s+(?<object>[A-Za-z0-9\-\s]+?)(?=[,.\n]|$)/gi,
    predicateLabel: 'CAUSES', confidence: 0.80,
  },
  // "AZT is metabolized by CYP3A4"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+is metabolized by\s+(?<object>[A-Za-z0-9\-]+)/gi,
    predicateLabel: 'METABOLIZED_BY', confidence: 0.90,
  },
  // "CYP3A4 metabolizes AZT"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+metabolizes?\s+(?<object>[A-Za-z0-9\-]+)/gi,
    predicateLabel: 'METABOLIZES', confidence: 0.88,
  },
  // "AZT interacts with lopinavir" / "drug-drug interaction between AZT and lopinavir"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+interacts? with\s+(?<object>[A-Za-z0-9\-]+)/gi,
    predicateLabel: 'INTERACTS_WITH', confidence: 0.82,
  },
  // "CD4 is a biomarker for HIV"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+is a (?:biomarker|marker) (?:for|of)\s+(?<object>[A-Za-z0-9\-]+)/gi,
    predicateLabel: 'BIOMARKER_OF', confidence: 0.78,
  },
  // "BRCA1 is associated with breast cancer"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+is associated with\s+(?<object>[A-Za-z0-9\-\s]+?)(?=[,.\n]|$)/gi,
    predicateLabel: 'ASSOCIATED_WITH', confidence: 0.70,
  },
  // "efavirenz is an antiretroviral"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+is an?\s+(?<object>[A-Za-z0-9\-\s]+?)(?=[,.\n]|$)/gi,
    predicateLabel: 'IS_A', confidence: 0.65,
  },
  // "BRCA1 gene mutation increases risk of breast cancer"
  {
    re: /(?<subject>[A-Za-z0-9\-]+)\s+(?:increases?|decreases?|reduces?) risk of\s+(?<object>[A-Za-z0-9\-\s]+?)(?=[,.\n]|$)/gi,
    predicateLabel: 'MODIFIES_RISK_OF', confidence: 0.75,
  },
];
// ─────────────────────────────────────────────────────────────────────────────

class MockRelationshipExtractor extends RelationshipExtractor {
  /**
   * @param {object[]} [extraRules]  Additional rule objects to append to the built-in set.
   *   Each rule: { re: RegExp, predicateLabel: string, confidence: number }
   */
  constructor(extraRules = []) {
    super();
    this.rules = [...RULES, ...extraRules];
  }

  /**
   * Extract triples from text.
   * @param {string} text
   * @param {string} [sourceChunkId]
   * @returns {Promise<Array<{subject,predicate,object,confidence,sourceChunkId}>>}
   */
  async extract(text, sourceChunkId = null) {
    if (!text || typeof text !== 'string') return [];

    const triples = [];
    const seen    = new Set(); // deduplicate within the same chunk

    for (const rule of this.rules) {
      rule.re.lastIndex = 0; // reset stateful regex
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const subject = (m.groups?.subject || '').trim().toLowerCase();
        const object  = (m.groups?.object  || '').trim().replace(/\s+/g, ' ').toLowerCase();

        if (!subject || !object || subject === object) continue;
        // Skip overly long "objects" — likely a runaway match
        if (object.split(' ').length > 5) continue;

        const key = `${subject}|${rule.predicateLabel}|${object}`;
        if (seen.has(key)) continue;
        seen.add(key);

        triples.push({
          subject,
          predicate:     rule.predicateLabel,
          object,
          confidence:    rule.confidence,
          sourceChunkId: sourceChunkId ?? null,
        });
      }
    }

    return triples;
  }
}

module.exports = { MockRelationshipExtractor, RULES };
