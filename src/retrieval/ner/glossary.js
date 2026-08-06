const { AcronymGlossary } = require('../../shared/interfaces');
const { Pool } = require('pg');

class PostgresAcronymGlossary extends AcronymGlossary {
  constructor(connectionString) {
    super();
    this._pool = new Pool({
      connectionString: connectionString || 'postgresql://rag_user:rag_password@localhost:5432/rag_system',
    });
    this._initialized = false;
  }

  async _init() {
    if (this._initialized) return;
    const client = await this._pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS acronym_glossary (
          acronym TEXT PRIMARY KEY,
          expansions TEXT[] NOT NULL DEFAULT '{}'
        )
      `);
      this._initialized = true;
    } finally {
      client.release();
    }
  }

  async lookup(acronym) {
    await this._init();
    const client = await this._pool.connect();
    try {
      const result = await client.query(
        'SELECT expansions FROM acronym_glossary WHERE acronym = $1',
        [acronym.toUpperCase()]
      );
      if (result.rows.length === 0) return [];
      return result.rows[0].expansions;
    } finally {
      client.release();
    }
  }

  async expand(text) {
    if (!text || typeof text !== 'string') return text;
    await this._init();
    const client = await this._pool.connect();
    try {
      const result = await client.query('SELECT acronym, expansions FROM acronym_glossary');
      const map = {};
      for (const row of result.rows) {
        map[row.acronym] = row.expansions;
      }
      // @gotcha Regex only matches uppercase tokens (`[A-Z0-9]`), so lowercase acronyms
      //       in the input text are NOT expanded. Acronyms are stored uppercase via
      //       `register()`, so only ALL-CAPS text gets expanded.
      return text.replace(/\b([A-Z0-9][A-Z0-9\-']{0,9})\b/g, (match) => {
        const expansions = map[match];
        if (!expansions || expansions.length === 0) return match;
        return `${match} OR ${expansions.join(' OR ')}`;
      });
    } finally {
      client.release();
    }
  }

  async register(entries) {
    await this._init();
    const client = await this._pool.connect();
    try {
      for (const [k, v] of Object.entries(entries)) {
        await client.query(
          'INSERT INTO acronym_glossary (acronym, expansions) VALUES ($1, $2) ON CONFLICT (acronym) DO UPDATE SET expansions = EXCLUDED.expansions',
          [k.toUpperCase(), v]
        );
      }
    } finally {
      client.release();
    }
  }

  async close() {
    await this._pool.end();
  }
}

module.exports = { PostgresAcronymGlossary };