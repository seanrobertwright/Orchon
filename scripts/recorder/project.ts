// The throwaway project: a scratch Git repository with one commit and a GitHub remote, made
// inside the throwaway home. It holds the recorder's own workflows and nothing of the developer's.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertOwnHome, type ThrowawayHome } from './home.ts'
import { runToEnd } from './process.ts'
import { RECORDER_WORKFLOWS, workflowFile } from './workflows.ts'

/** The remote's owner and name. Neither is an account of the developer's. */
export const PROJECT_REMOTE = 'https://github.com/orchon-recorder/throwaway-project.git'

/** The commit's author, given on the command line so that no Git identity of the developer's is read. */
const AUTHOR = ['-c', 'user.name=Orchon Recorder', '-c', 'user.email=recorder@example.invalid', '-c', 'commit.gpgsign=false']

/** Makes the project and answers its folder. */
export function createThrowawayProject(home: ThrowawayHome): string {
  assertOwnHome(home)
  const folder = home.projectFolder
  const workflows = join(folder, '.archon', 'workflows')
  mkdirSync(workflows, { recursive: true })
  writeFileSync(join(folder, 'README.md'), '# Throwaway project\n\nMade by the Orchon fixture recorder. Safe to delete.\n')
  for (const workflow of Object.values(RECORDER_WORKFLOWS)) {
    const file = workflowFile(workflow)
    writeFileSync(join(workflows, file.name), file.text)
  }
  const git = (...args: string[]): void => {
    const done = runToEnd(home, 'git', args, { cwd: folder })
    if (done.status !== 0) throw new Error(`git ${args[0] ?? ''} failed in the throwaway project: ${done.stderr.trim()}`)
  }
  git('init', '--initial-branch=main')
  git('add', '--all')
  git(...AUTHOR, 'commit', '--message', 'Throwaway project for the Orchon fixture recorder')
  git('remote', 'add', 'origin', PROJECT_REMOTE)
  return folder
}
