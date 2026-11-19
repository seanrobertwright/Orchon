// Scrubbing: no machine path, account name or store id survives into a fixture.
import { assert, describe, test } from 'orca/testing'
import { createScrubber, machineRules, PLACEHOLDERS, STORE_ID } from './scrub.ts'

const project = 'C:\\Users\\dev\\AppData\\Local\\Temp\\orchon-recorder-abc\\project'
const rules = {
  paths: [
    { path: 'C:\\Users\\dev', as: '<home>' },
    { path: 'C:\\Users\\dev\\AppData\\Local\\Temp', as: '<temp>' },
    { path: project, as: '<project-path>' }
  ],
  names: [
    { name: 'dev', as: '<user>' },
    { name: 'DEV-PC', as: '<host>' }
  ]
}

describe('the scrubber', () => {
  test('replaces a folder in every spelling, the longest folder first', () => {
    const { scrub } = createScrubber(rules)
    for (const spelling of [
      project,
      project.replaceAll('\\', '/'),
      project.replaceAll('\\', '\\\\'),
      project.toLowerCase(),
      '/c/Users/dev/AppData/Local/Temp/orchon-recorder-abc/project',
      encodeURIComponent(project),
      encodeURIComponent(project.replaceAll('\\', '/'))
    ]) {
      assert.equal(scrub(`cwd=${spelling}&x`), 'cwd=<project-path>&x', spelling)
    }
    assert.equal(scrub(`${project}\\.archon\\workflows`), '<project-path>\\.archon\\workflows')
    assert.equal(scrub('C:/Users/dev/AppData/Local/Temp/other'), '<temp>/other')
    assert.equal(scrub('C:\\Users\\dev\\.claude'), '<home>\\.claude')
  })

  test('replaces a name that stands alone and leaves longer words whole', () => {
    const { scrub } = createScrubber(rules)
    assert.equal(scrub('owner dev on dev-pc, a developer'), 'owner <user> on <host>, a developer')
    assert.equal(scrub('DEV@example.invalid'), '<user>@example.invalid')
  })

  test('reaches into lists, objects and their keys, and leaves other values as they are', () => {
    const { scrub } = createScrubber(rules)
    const scrubbed = scrub({
      runs: [{ working_path: project, total: 3, done: false, parent: null }],
      [`${project}/a.md`]: { size: 12 }
    })
    assert.deepEqual(scrubbed, {
      runs: [{ working_path: '<project-path>', total: 3, done: false, parent: null }],
      '<project-path>/a.md': { size: 12 }
    })
  })

  test('replaces a store id under its key, and anywhere else once it has been seen', () => {
    const scrubber = createScrubber(rules)
    assert.deepEqual(scrubber.scrub({ storeId: 'a1b2c3d4', store_id: 'a1b2c3d4', note: 'store a1b2c3d4' }), {
      storeId: STORE_ID,
      store_id: STORE_ID,
      note: 'store a1b2c3d4'
    })
    scrubber.learnStoreId('a1b2c3d4')
    assert.equal(scrubber.scrub('data: {"storeId":"A1B2C3D4"}'), `data: {"storeId":"${STORE_ID}"}`)
  })

  test('says what a text still holds', () => {
    const scrubber = createScrubber(rules)
    scrubber.learnStoreId('a1b2c3d4')
    assert.deepEqual(scrubber.leftovers('{"cwd":"<project-path>","user":"<user>"}'), [])
    assert.deepEqual(scrubber.leftovers(`at ${project.replaceAll('\\', '/')} by dev, store a1b2c3d4`), [
      '<project-path>',
      '<temp>',
      '<home>',
      '<user>',
      STORE_ID
    ])
    // Asking twice gives the same answer: a pattern keeps no position between calls.
    assert.deepEqual(scrubber.leftovers('by dev'), ['<user>'])
    assert.deepEqual(scrubber.leftovers('by dev'), ['<user>'])
  })

  test('replaces every folder and name of the recording machine by its placeholder', () => {
    const machine = {
      projectFolder: '/tmp/orchon-recorder-abc123/project',
      archonHome: '/tmp/orchon-recorder-abc123/archon-home',
      recorderFolder: '/tmp/orchon-recorder-abc123',
      tempFolder: '/tmp',
      homeFolder: '/home/dev',
      binary: '/home/dev/downloads/archon-linux-x64',
      user: 'dev',
      host: 'dev-box'
    }
    const scrubber = createScrubber(machineRules(machine))
    const scrubbed = scrubber.scrub(machine)
    assert.deepEqual(scrubbed, {
      projectFolder: '<project-path>',
      archonHome: '<archon-home>',
      recorderFolder: '<recorder-folder>',
      tempFolder: '<temp>',
      homeFolder: '<home>',
      binary: '<binary>',
      user: '<user>',
      host: '<host>'
    })
    assert.deepEqual(scrubber.leftovers(JSON.stringify(scrubbed)), [])
    assert.equal(scrubber.scrub('cwd=%2Ftmp%2Forchon-recorder-abc123%2Fproject&x'), 'cwd=<project-path>&x')
    // Every placeholder but the store id's stands for one of the machine's values.
    assert.deepEqual(Object.keys(PLACEHOLDERS).sort(), [...Object.keys(machine), 'storeId'].sort())
  })

  test('does not find a folder inside a longer name', () => {
    const { scrub } = createScrubber({
      paths: [
        { path: '/tmp', as: '<temp>' },
        { path: 'C:\\Users\\dev', as: '<home>' }
      ],
      names: []
    })
    assert.equal(scrub('/tmpfile and /tmp/file and /tmp.'), '/tmpfile and <temp>/file and <temp>.')
    assert.equal(scrub('C:\\Users\\developer and C:\\Users\\dev\\notes'), 'C:\\Users\\developer and <home>\\notes')
  })

  test('an empty path or name matches nothing', () => {
    const { scrub } = createScrubber({ paths: [{ path: '', as: '<x>' }], names: [{ name: '', as: '<y>' }] })
    assert.equal(scrub('plain text'), 'plain text')
  })
})
