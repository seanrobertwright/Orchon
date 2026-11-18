// PROTOTYPE - throwaway. Bundles variant B (React Flow) into the plugin and prints what each
// variant ships. Variant A needs no build: its files are loaded by Orca as written.
import { build } from 'esbuild'
import { readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
await build({
  entryPoints: [join(root, 'src-flow/main.jsx')],
  outdir: join(root, 'plugin/editor-flow'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info'
})

function sizes(dir, files) {
  let raw = 0
  let gz = 0
  for (const f of files) {
    const p = join(root, 'plugin', dir, f)
    raw += statSync(p).size
    gz += gzipSync(readFileSync(p)).length
  }
  return { raw, gz }
}
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`
const report = (title, parts) => {
  let raw = 0
  let gz = 0
  console.log(`\n${title}`)
  for (const [dir, files] of parts) {
    const s = sizes(dir, files)
    raw += s.raw
    gz += s.gz
    for (const f of files) console.log(`  ${dir}/${f}\t${kb(statSync(join(root, 'plugin', dir, f)).size)}`)
  }
  console.log(`  total\t${kb(raw)} (${kb(gz)} gzipped)`)
}
const shared = ['shared', readdirSync(join(root, 'plugin/shared'))]
report('Variant A: dagre + SVG (no build step)', [
  ['editor-svg', ['index.html', 'main.js', 'svg.css']],
  shared,
  ['vendor', ['dagre.esm.js']]
])
report('Variant B: React Flow (bundled)', [
  ['editor-flow', ['index.html', 'main.js', 'main.css']],
  ['shared', ['chrome.css']]
])
