// Fails when the committed editor JavaScript is not what the compiler writes for
// tsconfig.editors.json. The editors ship as committed, unminified ESM beside their source.
//
//   node scripts/check-editor-output.ts
//
// It compiles in memory through TypeScript's own API, so it writes nothing and starts no process.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { readRepoText, repoRoot } from './repo-files.ts'
import { isModuleNotFound, MissingTooling } from './tooling.ts'

export interface CompiledEditors {
  /** The text of each file the compiler writes, by its path from the repository root. */
  outputs: Map<string, string>
  /** Configuration and type errors, one sentence each. The compiler writes nothing when any exist. */
  errors: string[]
}

/** TypeScript, loaded through Node's require: Orca's test loader refuses packages imported by name. */
function loadTypeScript(): typeof import('typescript') {
  try {
    return createRequire(import.meta.url)('typescript') as typeof import('typescript')
  } catch (error) {
    if (isModuleNotFound(error)) throw new MissingTooling('TypeScript is not installed. Run: npm ci')
    throw error
  }
}

/** Compiles the editors' TypeScript as `tsc -p tsconfig.editors.json` does, without writing. */
export function compileEditors(root: string = repoRoot): CompiledEditors {
  if (!existsSync(join(root, '.orca', 'types', 'tsconfig.json'))) {
    throw new MissingTooling("Orca's types are not generated. Run: orca plugin types .")
  }
  const ts = loadTypeScript()
  const fromRoot = (path: string): string => relative(root, path).replaceAll('\\', '/')
  const describe = (diagnostic: import('typescript').Diagnostic): string => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${fromRoot(diagnostic.file.fileName)} line ${line + 1}: ${message}`
  }

  const outputs = new Map<string, string>()
  const errors: string[] = []
  const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.editors.json'), undefined, {
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

/** One sentence per compiled file that is missing or differs in the repository, in path order. */
export function compareEditorOutput(
  expected: ReadonlyMap<string, string>,
  readCommitted: (path: string) => string | undefined
): string[] {
  const problems: string[] = []
  for (const path of [...expected.keys()].sort()) {
    const committed = readCommitted(path)
    if (committed === undefined) {
      problems.push(`${path} is missing. Run: npm run build:editors`)
    } else if (committed !== expected.get(path)) {
      problems.push(`${path} differs from the compiler output. Run: npm run build:editors`)
    }
  }
  return problems
}

/** The text of a file in the repository, or undefined when it does not exist. */
export function readCommitted(path: string): string | undefined {
  return existsSync(join(repoRoot, path)) ? readRepoText(path) : undefined
}

function main(): number {
  const compiled = compileEditors()
  const problems = [...compiled.errors, ...compareEditorOutput(compiled.outputs, readCommitted)]
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) return 1
  console.log(`${compiled.outputs.size} editor files match the compiler output.`)
  return 0
}

if (import.meta.main) process.exitCode = main()
