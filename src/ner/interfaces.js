/**
 * NER / Acronym / MetadataFilter seams.
 *
 * Re-exported here as a convenience so consumers can:
 *   const { EntityExtractor, AcronymGlossary, MetadataFilter } = require('../ner/interfaces');
 *
 * The canonical definitions live in src/core/interfaces.js to keep the
 * single-source-of-truth principle. This file is a thin re-export.
 */
const {
  EntityExtractor,
  AcronymGlossary,
  MetadataFilter,
} = require('../core/interfaces');

module.exports = { EntityExtractor, AcronymGlossary, MetadataFilter };
