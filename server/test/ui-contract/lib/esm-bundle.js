// Test helper: bundles an ESM module with its relative named imports inlined
// into a single data: URI so Node's --test runner can import frontend ESM that
// has relative dependencies (the repo's existing pattern only handles leaf
// modules). One level of relative import is inlined recursively; deeper chains
// are followed. External bare specifiers (e.g. '../api.js' that reach outside
// the safe leaf set) should be avoided in tested modules.
const fs = require('node:fs');
const path = require('node:path');

const IMPORT_RE = /^import\s+\{([^}]+)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"]\s*;?\s*$/gm;

function stripExports(src) {
  // Turn `export function foo` -> `function foo`, `export const x` -> `const x`,
  // `export default` -> left as-is is not used here. Keep a trailing export list
  // so named exports remain importable by the entry module's import statements.
  return src.replace(/^export\s+(function|const|let|class|async function)\b/gm, '$1');
}

function bundle(entryPath, seen = new Set()) {
  const real = path.resolve(entryPath);
  if (seen.has(real)) return ''; // dedupe cyclic
  seen.add(real);
  let src = fs.readFileSync(real, 'utf8');
  src = src.replace(IMPORT_RE, (m, _names, dep) => {
    const depPath = path.resolve(path.dirname(real), dep);
    let depSrc = fs.readFileSync(depPath, 'utf8');
    depSrc = stripExports(depSrc);
    // Recurse for the dependency's own relative imports.
    depSrc = depSrc.replace(IMPORT_RE, (mm, n2, d2) => {
      return bundle(path.resolve(path.dirname(depPath), d2), seen);
    });
    return depSrc;
  });
  return src;
}

function importModule(entryPath) {
  const src = bundle(entryPath);
  const uri = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  return import(uri);
}

module.exports = { importModule, bundle };
