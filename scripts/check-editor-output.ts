// Fails when the committed editor JavaScript is not what the compiler writes for
// tsconfig.editors.json, or when a JavaScript file under editors/ has no TypeScript source.
// The editors ship as committed, unminified ESM beside their source.
//
//   node scripts/check-editor-output.ts
//
// It compiles in memory through TypeScript's own API, so it writes nothing and starts no process.
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { listRepoFiles, readRepoText, repoRoot } from './repo-files.ts'
import { loadPackage, MissingTooling } from './tooling.ts'

/**
 * Editor TypeScript that only the tests load, so it has no JavaScript: the test fixtures and the
 * test helpers copied with Archon's builder logic (editors/builder/archon/UPSTREAM.md).
 * tsconfig.editors.json leaves out the same paths.
 */
const TEST_ONLY_EDITOR_SOURCES = {
  folders: ['editors/builder/archon/fixtures/'],
  files: ['editors/builder/archon/validation/test-helpers.ts']
}

/** Whether an editor source is test-only, and so is not compiled. */
export function isTestOnlyEditorSource(path: string): boolean {
  return (
    TEST_ONLY_EDITOR_SOURCES.files.includes(path) ||
    TEST_ONLY_EDITOR_SOURCES.folders.some((folder) => path.startsWith(folder))
  )
}

export interface CompiledEditors {
  /** The text of each file the compiler writes, by its path from the repository root. */
  outputs: Map<string, string>
  /** Configuration and type errors, one sentence each. The compiler writes nothing when any exist. */
  errors: string[]
}

/** Compiles the editors' TypeScript as `tsc -p tsconfig.editors.json` does, without writing. */
export function compileEditors(): CompiledEditors {
  if (!existsSync(join(repoRoot, '.orca', 'types', 'tsconfig.json'))) {
    throw new MissingTooling("Orca's types are not generated. Run: orca plugin types .")
  }
  const ts = loadPackage('typescript') as typeof import('typescript')
  const fromRoot = (path: string): string => relative(repoRoot, path).replaceAll('\\', '/')
  const describe = (diagnostic: import('typescript').Diagnostic): string => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${fromRoot(diagnostic.file.fileName)} line ${line + 1}: ${message}`
  }

  const outputs = new Map<string, string>()
  const errors: string[] = []
  const config = ts.getParsedCommandLineOfConfigFile(join(repoRoot, 'tsconfig.editors.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => errors.push(describe(diagnostic))
  })
  if (config === undefined) return { outputs, errors }
  errors.push(...config.errors.map(describe))

  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options })
  errors.push(...ts.getPreEmitDiagnostics(program).map(describe))
  program.emit(undefined, (fileName, text) => outputs.set(fromRoot(fileName), text))
  return { outputs, errors }
}

/**
 * One sentence per problem, in path order: a compiled file that is missing or differs in the
 * repository, then a committed JavaScript file the compiler does not write. `committed` holds
 * the text of every JavaScript file under editors/, by its path from the repository root.
 */
export function compareEditorOutput(
  expected: ReadonlyMap<string, string>,
  committed: ReadonlyMap<string, string>
): string[] {
  const problems: string[] = []
  for (const path of [...expected.keys()].sort()) {
    const text = committed.get(path)
    if (text === undefined) {
      problems.push(`${path} is missing. Run: npm run build:editors`)
    } else if (text !== expected.get(path)) {
      problems.push(`${path} differs from the compiler output. Run: npm run build:editors`)
    }
  }
  for (const path of [...committed.keys()].sort()) {
    if (!expected.has(path)) {
      problems.push(`${path} has no TypeScript source: editor JavaScript is compiler output only.`)
    }
  }
  return problems
}

/** The text of every JavaScript file under editors/ in the repository. */
export function readCommittedEditorJavaScript(): Map<string, string> {
  const committed = new Map<string, string>()
  for (const { path } of listRepoFiles()) {
    if (/^editors\/.*\.js$/.test(path)) committed.set(path, readRepoText(path))
  }
  return committed
}

function main(): number {
  const compiled = compileEditors()
  // With a compile error the compiler writes nothing, so a comparison would only add noise.
  const problems =
    compiled.errors.length > 0
      ? compiled.errors
      : compareEditorOutput(compiled.outputs, readCommittedEditorJavaScript())
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  console.log(`${compiled.outputs.size} editor files match the compiler output.`)
  return 0
}

if (import.meta.main) process.exitCode = main()
