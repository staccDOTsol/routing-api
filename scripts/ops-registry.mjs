// Checks every operation module in lib/xgas/ops and writes the list the Lambda loads (lib/xgas/ops-registry.ts).
// Run by scripts/sync-ops.sh. A module is listed only when it loads on its own and bundles for the Lambda's
// CommonJS build; one that does not is named and left out.
//
//   node scripts/ops-registry.mjs <ops dir> <registry.ts> [the site's index.mjs, for its tie-break order]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dir, out, siteIndex] = process.argv.slice(2);
if (!dir || !out) { console.error('usage: ops-registry.mjs <ops dir> <registry.ts> [site index.mjs]'); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// where two modules could both take a pair, all are priced and the best wins; this order only breaks ties.
// The site's own list is the truth when it can be read.
let order = ['vault', 'pools', 'otc', 'pawn', 'gacha', 'gas', 'arb', 'wallet'];
try {
  const m = fs.readFileSync(siteIndex, 'utf8').match(/const ORDER = \[([^\]]*)\]/);
  const names = m ? [...m[1].matchAll(/'([a-z0-9_-]+)'/g)].map((x) => x[1]) : [];
  if (names.length) order = names;
} catch { /* keep the default */ }

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'core.mjs' && f !== 'index.mjs' && !f.startsWith('_') && !f.includes('.test.'));
const rankOf = (f) => { const i = order.indexOf(f.replace(/\.mjs$/, '')); return i < 0 ? order.length : i; };
files.sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));

const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
const good = [];
const bad = [];
for (const f of [...(fs.existsSync(path.join(dir, 'core.mjs')) ? ['core.mjs'] : []), ...files]) {
  const file = path.join(dir, f);
  const name = f.replace(/\.mjs$/, '');
  const src = fs.readFileSync(file, 'utf8');
  let why = null;
  // the Lambda bundle is CommonJS: there is no import.meta in it, and nothing may wait at the top level
  if (/\bimport\.meta\b/.test(src.replace(/\/\/.*$/gm, ''))) why = 'uses import.meta, which the Lambda bundle does not have';
  if (!why && fs.existsSync(esbuild)) {
    const b = spawnSync(esbuild, ['--bundle', file, '--platform=node', '--format=cjs', '--target=node22', '--log-level=error', `--outfile=${path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ops-')), 'out.js')}`], { encoding: 'utf8' });
    if (b.status !== 0) why = `does not bundle: ${(b.stderr || b.stdout || '').split('\n').find((l) => l.includes('error')) || 'esbuild failed'}`.slice(0, 200);
  }
  if (!why) {
    const check = name === 'core'
      ? "if (typeof m.createOps !== 'function' || typeof m.toResponse !== 'function') throw new Error('not the dispatcher');"
      : "if (typeof m.id !== 'string' || typeof m.match !== 'function' || typeof m.plan !== 'function') throw new Error('not an op module (id, match, plan)');";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); ${check} process.exit(0);`], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) why = `does not load: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'failed'}`.slice(0, 200);
  }
  if (why) bad.push([f, why]);
  else if (name !== 'core') good.push(name);
}
if (bad.some(([f]) => f === 'core.mjs')) { console.error(`core.mjs ${bad.find(([f]) => f === 'core.mjs')[1]}: nothing can be hosted without it`); process.exit(1); }

const body = `// Written by scripts/sync-ops.sh. Do not edit: run the script again.
//
// The operation modules the router hosts, in the order ties are broken in. Each is loaded on first use inside a
// try, so one that throws while loading takes only itself out (see lib/xgas/ops-host.ts).
/* eslint-disable @typescript-eslint/no-var-requires */
export const OP_LOADERS: Array<[string, () => any]> = [
${good.map((n) => `  ['${n}', () => require('./ops/${n}.mjs')],`).join('\n')}
]

export const loadCore = (): any => require('./ops/core.mjs')
${bad.length ? `\n// left out by the last sync:\n${bad.map(([f, why]) => `//   ${f}: ${why.replace(/\s+/g, ' ')}`).join('\n')}\n` : ''}`;
fs.writeFileSync(out, body);
console.log(`ops registry: ${good.join(', ') || 'none'}`);
for (const [f, why] of bad) console.log(`  left out ${f}: ${why}`);
