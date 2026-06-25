const fs = require('fs');
const path = require('path');
const { DocumentLoader } = require('../core/interfaces');
const { serverEvents } = require('../events');

class RealDocumentLoader extends DocumentLoader {
  async loadDocuments(folderPath) {
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${folderPath}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${folderPath}`);
    const docs = [];
    const readDir = (dir) => {
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) readDir(full);
        else if (file.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          const rel = path.relative(resolved, full);
          docs.push({
            id: rel,
            content: content,
            metadata: { file, path: rel, size: stat.size, mtime: stat.mtimeMs }
          });
        }
      }
    };
    readDir(resolved);
    serverEvents.logEvent('documents:loaded', { folderPath, count: docs.length });
    return docs;
  }
}

module.exports = { RealDocumentLoader };
