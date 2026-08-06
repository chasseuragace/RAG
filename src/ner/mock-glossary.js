/**
 * MockAcronymGlossary — development-mode acronym expander backed by a static
 * in-memory map.
 *
 * Swap this for a real glossary (database, UMLS API, etc.) by implementing
 * the AcronymGlossary interface from src/core/interfaces.js.
 *
 * expand(text)       → string   — rewrites "AZT" to "AZT OR Zidovudine" in the text.
 * lookup(acronym)    → string[] — returns all known expansions (empty array if unknown).
 * register(map)      → void     — adds/overrides entries at runtime (e.g. per-domain glossaries).
 */

const { AcronymGlossary } = require('../core/interfaces');

// ─── built-in domain glossary ─────────────────────────────────────────────────
const DEFAULT_GLOSSARY = {
  // Antiretroviral drugs
  AZT:   ['Zidovudine'],
  TDF:   ['Tenofovir', 'Tenofovir Disoproxil Fumarate'],
  FTC:   ['Emtricitabine'],
  '3TC': ['Lamivudine'],
  EFV:   ['Efavirenz'],
  NVP:   ['Nevirapine'],
  LPV:   ['Lopinavir'],
  RTV:   ['Ritonavir'],
  ATV:   ['Atazanavir'],
  DRV:   ['Darunavir'],
  RAL:   ['Raltegravir'],
  DTG:   ['Dolutegravir'],
  BIC:   ['Bictegravir'],
  EVG:   ['Elvitegravir'],
  COBI:  ['Cobicistat'],
  ABC:   ['Abacavir'],
  ARV:   ['Antiretroviral'],
  HAART: ['Highly Active Antiretroviral Therapy'],

  // Diseases & conditions
  HIV:   ['Human Immunodeficiency Virus'],
  AIDS:  ['Acquired Immunodeficiency Syndrome'],
  TB:    ['Tuberculosis'],
  COPD:  ['Chronic Obstructive Pulmonary Disease'],
  MS:    ['Multiple Sclerosis'],
  RA:    ['Rheumatoid Arthritis'],
  SLE:   ['Systemic Lupus Erythematosus'],
  IBD:   ['Inflammatory Bowel Disease'],
  IBS:   ['Irritable Bowel Syndrome'],

  // Biomarkers & lab values
  VL:    ['Viral Load'],
  HbA1c: ['Glycated Haemoglobin', 'Hemoglobin A1c'],
  PSA:   ['Prostate-Specific Antigen'],
  CEA:   ['Carcinoembryonic Antigen'],
  BNP:   ['B-type Natriuretic Peptide'],
  CRP:   ['C-Reactive Protein'],
  INR:   ['International Normalised Ratio'],
  eGFR:  ['Estimated Glomerular Filtration Rate'],
  ALT:   ['Alanine Aminotransferase'],
  AST:   ['Aspartate Aminotransferase'],

  // Genomics
  BRCA1: ['Breast Cancer Gene 1'],
  BRCA2: ['Breast Cancer Gene 2'],
  TP53:  ['Tumour Protein p53'],
  EGFR:  ['Epidermal Growth Factor Receptor'],
  HER2:  ['Human Epidermal Growth Factor Receptor 2'],
  VEGFA: ['Vascular Endothelial Growth Factor A'],
};
// ─────────────────────────────────────────────────────────────────────────────

class MockAcronymGlossary extends AcronymGlossary {
  /**
   * @param {Record<string, string[]>} [extraEntries]  Merge additional entries on top of defaults.
   */
  constructor(extraEntries = {}) {
    super();
    // Normalise keys to upper-case for case-insensitive lookups.
    this._map = {};
    for (const [k, v] of Object.entries({ ...DEFAULT_GLOSSARY, ...extraEntries })) {
      this._map[k.toUpperCase()] = v;
    }
  }

  /**
   * Look up all expansions for a single acronym token.
   * @param {string} acronym
   * @returns {string[]}
   */
  lookup(acronym) {
    return this._map[(acronym || '').toUpperCase()] || [];
  }

  /**
   * Rewrite text so that each recognised acronym is replaced with
   * "ACRONYM OR expansion1 OR expansion2 ..." to widen BM25 coverage.
   *
   * e.g. "AZT efficacy HIV low CD4"
   *      → "AZT OR Zidovudine efficacy HIV OR Human Immunodeficiency Virus low CD4"
   *
   * @param {string} text
   * @returns {string}
   */
  expand(text) {
    if (!text || typeof text !== 'string') return text;
    // Split on word boundaries so we replace whole tokens only.
    return text.replace(/\b([A-Z0-9][A-Z0-9\-']{0,9})\b/g, (match) => {
      const expansions = this.lookup(match);
      if (expansions.length === 0) return match;
      return `${match} OR ${expansions.join(' OR ')}`;
    });
  }

  /**
   * Merge additional entries at runtime.
   * Useful for injecting domain-specific glossaries per tenant/use-case.
   * @param {Record<string, string[]>} entries
   */
  register(entries) {
    for (const [k, v] of Object.entries(entries)) {
      this._map[k.toUpperCase()] = v;
    }
  }
}

module.exports = { MockAcronymGlossary, DEFAULT_GLOSSARY };
