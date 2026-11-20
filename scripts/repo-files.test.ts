// The helpers the gates and the tests share for reading the repository's own files.
import { assert, describe, test } from 'orca/testing'
import { markdownSection } from './repo-files.ts'

const DOC = '# Title\r\n\r\n## 0.2.0 (unreleased)\r\n\r\n### Asks again\r\n\r\n- One.\r\n\r\n### Other\r\n\r\n## 0.1.0\r\n\r\n- First.\r\n'

describe('markdownSection', () => {
  test('returns the lines under a heading up to the next heading of the same or a higher level', () => {
    assert.deepEqual(markdownSection(DOC, '## 0.1.0'), ['', '- First.', ''])
    assert.deepEqual(markdownSection(DOC, '### Asks again'), ['', '- One.', ''])
    assert.deepEqual(markdownSection(DOC, '## 0.2.0'), ['', '### Asks again', '', '- One.', '', '### Other', ''])
  })

  test('matches a heading followed by more words, and gives null when there is no such heading', () => {
    assert.equal(markdownSection(DOC, '## 0.2'), null)
    assert.equal(markdownSection(DOC, '## 0.3.0'), null)
  })
})
