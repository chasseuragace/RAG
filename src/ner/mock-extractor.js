/**
 * MockEntityExtractor — development-mode NER using static regex/keyword lists.
 *
 * Swap this for a real NLP model (spaCy HTTP, Hugging Face NER, etc.) by
 * implementing the EntityExtractor interface from src/core/interfaces.js.
 *
 * Recognised label sets (extend freely; no code changes elsewhere required):
 *   DRUG      — pharmaceutical compounds and brand names
 *   GENE      — gene/protein symbols
 *   DISEASE   — disease and condition names
 *   BIOMARKER — measurable biological indicators
 *
 * extract(text) → { DRUG: [...], GENE: [...], DISEASE: [...], BIOMARKER: [...] }
 * All values are de-duplicated, lowercased surface strings.
 */

const { EntityExtractor } = require('../core/interfaces');

// ─── static knowledge base ────────────────────────────────────────────────────
const ENTITY_PATTERNS = {
  DRUG: [
    /\b(AZT|zidovudine|HIV-1|antiretroviral|ARV|HAART|tenofovir|TDF|emtricitabine|FTC|lamivudine|3TC|efavirenz|EFV|nevirapine|NVP|lopinavir|LPV|ritonavir|RTV|atazanavir|ATV|darunavir|DRV|raltegravir|RAL|dolutegravir|DTG|bictegravir|BIC|elvitegravir|EVG|cobicistat|COBI|abacavir|ABC)\b/gi,
  ],
  GENE: [
    /\b(BRCA1|BRCA2|TP53|KRAS|EGFR|ALK|ROS1|MET|BRAF|PIK3CA|PTEN|RB1|CDK4|CDK6|MDM2|HER2|ERBB2|VEGFA|PDGFRA|KIT|RET|NTRK1|NTRK2|NTRK3|FGFR1|FGFR2|FGFR3|IDH1|IDH2|DNMT3A|TET2|NPM1|FLT3|WT1|CEBPA)\b/g,
  ],
  DISEASE: [
    /\b(HIV|AIDS|cancer|tumor|tumour|carcinoma|lymphoma|leukemia|leukaemia|diabetes|hypertension|asthma|COPD|tuberculosis|TB|malaria|hepatitis|COVID-19|SARS-CoV-2|influenza|pneumonia|sepsis|stroke|Alzheimer|Parkinson|multiple sclerosis|MS|rheumatoid arthritis|RA|lupus|SLE|Crohn|IBD|IBS)\b/gi,
  ],
  BIOMARKER: [
    /\b(CD4|CD8|viral load|VL|HbA1c|PSA|CEA|CA-125|AFP|hCG|troponin|BNP|CRP|IL-6|TNF-alpha|INR|eGFR|creatinine|ALT|AST|bilirubin|haemoglobin|hemoglobin|platelet|neutrophil|lymphocyte|T-cell|B-cell|NK cell)\b/gi,
  ],
};
// ─────────────────────────────────────────────────────────────────────────────

class MockEntityExtractor extends EntityExtractor {
  /**
   * @param {object} [extraPatterns]  Optional extra { LABEL: [RegExp, ...] } to merge in.
   */
  constructor(extraPatterns = {}) {
    super();
    this.patterns = { ...ENTITY_PATTERNS };
    for (const [label, regexes] of Object.entries(extraPatterns)) {
      this.patterns[label] = [...(this.patterns[label] || []), ...regexes];
    }
  }

  /**
   * Extract named entities from text.
   * @param {string} text
   * @returns {Promise<Record<string, string[]>>}  e.g. { DRUG: ['azt'], DISEASE: ['hiv'] }
   */
  async extract(text) {
    if (!text || typeof text !== 'string') return {};
    const entities = {};
    for (const [label, regexes] of Object.entries(this.patterns)) {
      const found = new Set();
      for (const re of regexes) {
        // Reset lastIndex to avoid stateful regex bugs when reusing the same instance
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          found.add(m[0].toLowerCase());
        }
      }
      if (found.size > 0) entities[label] = [...found];
    }
    return entities;
  }
}

module.exports = { MockEntityExtractor, ENTITY_PATTERNS };
