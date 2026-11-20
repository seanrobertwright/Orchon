// The throwaway project: a scratch Git repository with one commit and a GitHub remote, made
// inside the throwaway home. It holds the recorder's own workflows and nothing of the developer's.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertOwnHome, type ThrowawayHome } from './home.ts'
import { runToEnd } from './process.ts'
import { RECORDER_WORKFLOWS, workflowFile } from './workflows.ts'

/** The remote's owner and name. Neither is an account of the developer's. */
export const PROJECT_REMOTE = 'https://github.com/orchon-recorder/throwaway-project.git'

/** The commit's author, given on the command line so that no Git identity of the developer's is read. */
const AUTHOR = ['-c', 'user.name=Orchon Recorder', '-c', 'user.email=recorder@example.invalid', '-c', 'commit.gpgsign=false']

/**
 * Makes the project and answers its folder. `signal` stops a `git` command when the recording is
 * interrupted. `files` are added to its `.archon/workflows` folder, by path inside it: what a
 * spend scenario needs besides the recorder's own workflows (see `scenarioFiles`).
 */
export async function createThrowawayProject(
  home: ThrowawayHome,
  signal?: AbortSignal,
  options: { files?: readonly { path: string; text: string }[] } = {}
): Promise<string> {
  assertOwnHome(home)
  const folder = home.projectFolder
  const workflows = join(folder, '.archon', 'workflows')
  mkdirSync(workflows, { recursive: true })
  writeFileSync(join(folder, 'README.md'), '# Throwaway project\n\nMade by the Orchon fixture recorder. Safe to delete.\n')
  for (const workflow of Object.values(RECORDER_WORKFLOWS)) {
    const file = workflowFile(workflow)
    writeFileSync(join(workflows, file.name), file.text)
  }
  for (const file of options.files ?? []) {
    const target = join(workflows, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.text)
  }
  const git = async (...args: string[]): Promise<void> => {
    const done = await runToEnd(home, 'git', args, { cwd: folder, ...(signal === undefined ? {} : { signal }) })
    if (done.status !== 0) throw new Error(`git ${args[0] ?? ''} failed in the throwaway project: ${done.stderr.trim()}`)
  }
  await git('init', '--initial-branch=main')
  await git('add', '--all')
  await git(...AUTHOR, 'commit', '--message', 'Throwaway project for the Orchon fixture recorder')
  await git('remote', 'add', 'origin', PROJECT_REMOTE)
  return folder
}
