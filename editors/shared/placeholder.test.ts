// The frame seam for the editors: the placeholder driven through Orca's stand-in editor host.
import { afterEach, assert, mockEditorHost, test, type MockEditorHost } from 'orca/testing'
import { readRepoText } from '../../scripts/repo-files.ts'
import { showPlaceholderStatus } from './placeholder.ts'

let host: MockEditorHost | undefined
afterEach(() => {
  host?.dispose()
  host = undefined
})

for (const sample of ['fixtures/pointers/sample.orchonrun', 'fixtures/pointers/sample.orchonflow']) {
  test(`reads ${sample} and says so, without changing it`, async () => {
    const text = readRepoText(sample)
    host = mockEditorHost({ text })
    const status = { textContent: '' }
    await showPlaceholderStatus(status)
    assert.equal(status.textContent, 'Pointer file read.')
    assert.deepEqual(host.edits, [])
    assert.equal(host.text, text)
  })
}

test('says so when the tab has no document to read', async () => {
  host = mockEditorHost({ text: '{}' })
  host.dispose()
  host = undefined
  const status = { textContent: '' }
  await showPlaceholderStatus(status)
  assert.equal(status.textContent, 'Orchon could not read this file.')
})
