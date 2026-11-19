// Pure logic: the project matcher of #6, part 2. An Orca project is matched by the first step
// with exactly one hit: a saved link Archon still lists, then path, then Git remote.
import { assert, describe, test } from 'orca/testing'
import { matchProject, type ArchonProject } from './project-match'

const web: ArchonProject = { id: 'cb-web', name: 'acme/web', defaultCwd: 'C:\\Projects\\web', repositoryUrl: 'https://github.com/acme/web.git' }
const api: ArchonProject = { id: 'cb-api', name: 'acme/api', defaultCwd: 'C:/Projects/api', repositoryUrl: 'git@github.com:acme/api.git' }
const outer: ArchonProject = { id: 'cb-outer', name: 'acme/mono', defaultCwd: 'c:/projects', repositoryUrl: null }

describe('the project matcher', () => {
  test('a saved link Archon still lists wins over path and remote', () => {
    const match = matchProject({ projects: [web, api], link: 'cb-api', folders: ['C:/Projects/web'], remote: 'https://github.com/acme/web' })
    assert.deepEqual(match, { kind: 'matched', project: api, by: 'link' })
  })

  test('a saved link Archon no longer lists is skipped', () => {
    const match = matchProject({ projects: [web, api], link: 'cb-gone', folders: ['c:/projects/web/'], remote: null })
    assert.deepEqual(match, { kind: 'matched', project: web, by: 'path' })
  })

  test('path: the project or workspace folder is the same as or inside default_cwd, in either slash direction', () => {
    assert.deepEqual(matchProject({ projects: [web, api], link: null, folders: ['C:/Projects/web/packages/ui'], remote: null }), {
      kind: 'matched',
      project: web,
      by: 'path'
    })
    assert.deepEqual(matchProject({ projects: [web, api], link: null, folders: ['D:/elsewhere', 'C:\\PROJECTS\\API'], remote: null }), {
      kind: 'matched',
      project: api,
      by: 'path'
    })
  })

  test('two path hits go on to the remote step', () => {
    const match = matchProject({ projects: [web, outer], link: null, folders: ['C:/Projects/web'], remote: 'git@github.com:Acme/Web' })
    assert.deepEqual(match, { kind: 'matched', project: web, by: 'remote' })
  })

  test('remote: origin equals repository_url once normalised', () => {
    const match = matchProject({ projects: [web, api], link: null, folders: ['E:/clone/api'], remote: 'https://github.com/acme/api' })
    assert.deepEqual(match, { kind: 'matched', project: api, by: 'remote' })
  })

  test('no hit, or more than one at every step, is unmatched', () => {
    assert.deepEqual(matchProject({ projects: [web, api], link: null, folders: ['E:/other'], remote: null }), { kind: 'unmatched', reason: 'none' })
    const twin = { ...web, id: 'cb-web-2' }
    assert.deepEqual(matchProject({ projects: [web, twin], link: null, folders: ['C:/Projects/web'], remote: 'https://github.com/acme/web' }), {
      kind: 'unmatched',
      reason: 'several'
    })
    assert.deepEqual(matchProject({ projects: [], link: 'cb-web', folders: ['C:/Projects/web'], remote: null }), { kind: 'unmatched', reason: 'none' })
  })
})
