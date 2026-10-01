// GUARD: src/shared/watch-link/ is VENDORED byte for byte into nodeterm-web (the viewer page), every
// `*.ts` here except the tests. Two rules make that copy work there, and nothing in this repo's own
// build would notice a break of either:
//  1. A source file imports nothing outside this directory but `tweetnacl`. An `../presence` or a
//     `node:*` import compiles and passes every test here, and the vendored copy then fails to build
//     (the file it names is not in the web repo) or ships Node into the browser bundle.
//  2. A type-only import is spelled `import type` (or `type X` inline). nodeterm-web compiles with
//     `verbatimModuleSyntax`, which refuses a plain import of something that is only a type.
// TypeScript 7 has no JS compiler API to ask, so this reads the sources: an import of a name from a
// sibling must name something that sibling exports as a VALUE.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = __dirname
/** The one package a vendored file may import. */
const ALLOWED_PACKAGES = new Set(['tweetnacl'])

const read = (f: string): string => readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n')
const vendored = (): string[] => readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()

/** Comments out, string contents kept (a URL's `//` inside quotes is not a comment). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1')
}

interface ImportDecl {
  file: string
  text: string
  spec: string
  typeOnly: boolean
  /** Named bindings, `type`-prefixed ones marked. Empty for a default/namespace/side-effect import. */
  names: { name: string; type: boolean }[]
}

function importsOf(file: string, src: string): ImportDecl[] {
  const out: ImportDecl[] = []
  const code = stripComments(src)
  const re = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
  for (const m of code.matchAll(re)) {
    const body = m[3]
    const braces = /\{([\s\S]*)\}/.exec(body)
    const names = braces
      ? braces[1]
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const type = p.startsWith('type ')
            const name = (type ? p.slice(5) : p).split(/\s+as\s+/)[0].trim()
            return { name, type }
          })
      : []
    out.push({ file, text: m[0].trim(), spec: m[4], typeOnly: !!m[2], names })
  }
  // Side-effect imports, dynamic imports and require: none is allowed at all.
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push({ file, text: m[0].trim(), spec: m[1], typeOnly: false, names: [] })
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) out.push({ file, text: m[0], spec: `dynamic:${m[1]}`, typeOnly: false, names: [] })
  return out
}

/** The names a file exports as VALUES (what a non-type import of it may name). */
function valueExports(src: string): Set<string> {
  const code = stripComments(src)
  const out = new Set<string>()
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1])
  return out
}

/** Every rule violation in a set of sources. Exported to the self-test below. */
function violations(sources: Record<string, string>): string[] {
  const files = new Set(Object.keys(sources))
  const exportsOf = new Map(Object.entries(sources).map(([f, src]) => [f, valueExports(src)]))
  const bad: string[] = []
  for (const [file, src] of Object.entries(sources)) {
    for (const imp of importsOf(file, src)) {
      if (imp.spec.startsWith('dynamic:')) {
        bad.push(`${file}: a dynamic import or require (${imp.text})`)
        continue
      }
      if (imp.spec.startsWith('./')) {
        const target = `${imp.spec.slice(2)}.ts`
        if (imp.spec.slice(2).includes('/') || !files.has(target)) {
          bad.push(`${file}: imports ${imp.spec}, which is not a sibling in this directory`)
          continue
        }
        if (imp.typeOnly) continue
        const values = exportsOf.get(target)!
        for (const n of imp.names) {
          if (n.type) continue
          if (!values.has(n.name)) bad.push(`${file}: imports ${n.name} from ${imp.spec} without \`type\`, but it is not a value there`)
        }
        continue
      }
      if (!ALLOWED_PACKAGES.has(imp.spec)) bad.push(`${file}: imports ${imp.spec} (only ${[...ALLOWED_PACKAGES].join(', ')} and siblings)`)
    }
  }
  return bad
}

describe('src/shared/watch-link stays isomorphic (it is vendored into nodeterm-web)', () => {
  it('the vendored set is what this guard reads', () => {
    // Not vacuous: the files the web repo copies, all of them seen here.
    expect(vendored()).toEqual(['bytes.ts', 'client.ts', 'hkdf.ts', 'keys.ts', 'link.ts', 'protocol.ts', 'wire.ts'])
  })

  it('no source imports outside the directory, and every type-only import says `type`', () => {
    const sources = Object.fromEntries(vendored().map((f) => [f, read(f)]))
    expect(violations(sources)).toEqual([])
    // The guard saw the imports it must judge (a regex that matched nothing would pass anything).
    const all = Object.entries(sources).flatMap(([f, src]) => importsOf(f, src))
    expect(all.filter((i) => i.spec.startsWith('./')).length).toBeGreaterThanOrEqual(8)
    expect(all.some((i) => i.file === 'client.ts' && i.spec === './keys' && i.typeOnly)).toBe(true)
  })

  it('no source reaches for Node: `Buffer`, `process` or a `node:` specifier', () => {
    for (const f of vendored()) {
      const code = stripComments(read(f)).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")
      expect(code, f).not.toMatch(/\bBuffer\b|\bprocess\.|\brequire\b|['"]node:/)
    }
  })

  // The guard's own teeth, on synthetic sources: each rule must fire.
  it('self-test: each kind of break is caught', () => {
    const keys = 'export interface WatchLinkKeys { a: 1 }\nexport const K = 1\n'
    expect(violations({ 'keys.ts': keys, 'a.ts': "import { WatchLinkKeys } from './keys'\n" })).toHaveLength(1)
    expect(violations({ 'keys.ts': keys, 'a.ts': "import type { WatchLinkKeys } from './keys'\n" })).toEqual([])
    expect(violations({ 'keys.ts': keys, 'a.ts': "import { type WatchLinkKeys, K } from './keys'\n" })).toEqual([])
    expect(violations({ 'a.ts': "import { BIDI_CONTROL_CHARS } from '../presence'\n" })).toHaveLength(1)
    expect(violations({ 'a.ts': "import { x } from './sub/b'\n" })).toHaveLength(1)
    expect(violations({ 'a.ts': "import { randomBytes } from 'node:crypto'\n" })).toHaveLength(1)
    expect(violations({ 'a.ts': "import nacl from 'tweetnacl'\n" })).toEqual([])
    expect(violations({ 'a.ts': "export { x } from '../types'\n" })).toHaveLength(1)
    expect(violations({ 'a.ts': "const m = await import('./b')\n" })).toHaveLength(1)
    // A comment that names a forbidden import is not one.
    expect(violations({ 'a.ts': "// import { x } from '../presence'\n" })).toEqual([])
  })
})
