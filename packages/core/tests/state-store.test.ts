import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { test, type TestContext } from 'node:test'

import { StateStore } from '../src/state.ts'

// Fake disk operations keep failure tests deterministic without deleting any real files.
function mockDisk(t: TestContext, initial?: string): Map<string, string> {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('state.json', initial)
  t.mock.method(fs, 'readFile', async () => {
    const content = files.get('state.json')
    if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return content
  })
  t.mock.method(fs, 'mkdir', async () => undefined)
  t.mock.method(fs, 'writeFile', async (file: unknown, data: unknown) => {
    files.set(String(file), String(data))
  })
  t.mock.method(fs, 'rename', async (from: unknown, to: unknown) => {
    const content = files.get(String(from))
    assert.notEqual(content, undefined)
    files.set(String(to), content!)
    files.delete(String(from))
  })
  t.mock.method(fs, 'rm', async (file: unknown) => { files.delete(String(file)) })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return files
}

test('state store recovers after a failed write', async (t) => {
  const files = mockDisk(t)
  const rename = fs.rename
  const failure = Object.assign(new Error('temporary rename failure'), { code: 'EPERM' })
  let fail = true
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (fail) {
      fail = false
      throw failure
    }
    return await rename(...args)
  })
  syncBuiltinESMExports()
  const store = new StateStore('state.json')
  await assert.rejects(store.update((state) => { state.autoStart = true }), (error) => error === failure)
  await store.update((state) => { state.autoStart = false })
  assert.equal(JSON.parse(files.get('state.json')!).autoStart, false)
})

test('state store refuses malformed JSON without overwriting or exposing its contents', async (t) => {
  const original = '{"token":"fixture-secret-do-not-log",}'
  const files = mockDisk(t, original)
  const store = new StateStore('state.json')
  await assert.rejects(store.read(), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /state\.json/)
    assert.doesNotMatch(error.message, /fixture-secret-do-not-log/)
    return true
  })
  let mutated = false
  await assert.rejects(store.update(() => { mutated = true }))
  assert.equal(mutated, false)
  assert.equal(files.get('state.json'), original)
})

test('state store retries loading after the malformed file is repaired', async (t) => {
  const files = mockDisk(t, '{')
  const store = new StateStore('state.json')
  await assert.rejects(store.read())
  files.set('state.json', '{"autoStart":false}')
  assert.equal((await store.read()).autoStart, false)
})

test('state store rejects non-object JSON without overwriting it', async (t) => {
  const files = mockDisk(t)
  for (const original of ['null', '[]', '42', '"text"']) {
    files.set('state.json', original)
    const store = new StateStore('state.json')
    await assert.rejects(store.read())
    await assert.rejects(store.update((state) => { state.autoStart = true }))
    assert.equal(files.get('state.json'), original)
  }
})

test('state store propagates permission failures and retries after access is restored', async (t) => {
  const files = mockDisk(t, '{"autoStart":true}')
  const readFile = fs.readFile
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  let denied = true
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (denied) throw failure
    return await readFile(...args)
  })
  syncBuiltinESMExports()
  const store = new StateStore('state.json')
  await assert.rejects(store.read(), (error) => error === failure)
  await assert.rejects(store.update((state) => { state.autoStart = false }), (error) => error === failure)
  assert.equal(files.get('state.json'), '{"autoStart":true}')
  denied = false
  assert.equal((await store.read()).autoStart, true)
})

test('state store still initializes a missing file', async (t) => {
  const files = mockDisk(t)
  const store = new StateStore('state.json')
  assert.deepEqual((await store.read()).accounts, {})
  await store.update((state) => { state.autoStart = false })
  assert.equal(JSON.parse(files.get('state.json')!).autoStart, false)
})
