// Turns the raw recordings of record.mjs into fixtures that hold no machine
// path, account name or install id.
//
//   node scrub.mjs <rawDir> <outDir> <projectPath> <owner>
//
// <projectPath> is the folder the throwaway project was registered from and
// <owner> is the account name in its Git remote. The script fails when the
// account name or the home folder's name is still present after scrubbing.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const [rawDir, outDir, projectPath, owner] = process.argv.slice(2);
if (!rawDir || !outDir || !projectPath || !owner) {
  console.error('usage: node scrub.mjs <rawDir> <outDir> <projectPath> <owner>');
  process.exit(2);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches a path however its separators are written: `/`, `\` or `\\` (JSON inside a string). */
function pathPattern(path) {
  const segments = path.split(/[\\/]+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(segments.join('(?:\\\\\\\\|\\\\|/)'), 'gi');
}

const home = homedir();
const replacements = [
  [pathPattern(projectPath), '<project-path>'],
  [pathPattern(home), '<home>'],
  [new RegExp(escapeRegExp(owner), 'g'), '<owner>'],
];
const forbidden = [owner.toLowerCase(), basename(home).toLowerCase()];

function scrub(value, key) {
  if (typeof value === 'string') {
    if (key === 'storeId') return '<store-id>';
    return replacements.reduce((text, [pattern, to]) => text.replace(pattern, to), value);
  }
  if (Array.isArray(value)) return value.map(item => scrub(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  }
  return value;
}

mkdirSync(outDir, { recursive: true });
let failed = false;
for (const name of readdirSync(rawDir).filter(n => n.endsWith('.raw.json')).sort()) {
  const raw = JSON.parse(readFileSync(join(rawDir, name), 'utf8'));
  const text = JSON.stringify(scrub(raw), null, 2) + '\n';
  const left = forbidden.filter(word => text.toLowerCase().includes(word));
  const target = join(outDir, name.replace(/\.raw\.json$/, '.json'));
  if (left.length > 0) {
    failed = true;
    console.error(`${name}: ${left.length} forbidden name(s) still present, not written`);
    continue;
  }
  writeFileSync(target, text);
  console.log(`${name} -> ${target} (${text.length} characters)`);
}
process.exit(failed ? 1 : 0);
