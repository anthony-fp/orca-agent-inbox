// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows the empty state', async () => {
  const view = await mount(panel, { host: mockHost() })
  assert.ok(view.find({ text: 'No agents tracked yet.' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
