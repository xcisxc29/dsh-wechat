import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import { StateStore } from '@dsh-wechat/core'
import { apply } from '../src/host.ts'
import type { WechatContext } from '../src/services.ts'

for (const [saved, configured, starts] of [
  [false, true, 0],
  [true, false, 1],
  [undefined, true, 1],
  [undefined, false, 0],
] as const) {
  test('startup respects saved=' + String(saved) + ', configured=' + String(configured), { timeout: 1000 }, async (t) => {
    const home = join(process.cwd(), '.virtual-startup-home')
    const finished = Promise.withResolvers<void>()
    const logs: string[] = []
    t.mock.method(fs, 'mkdirSync', () => undefined)
    t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    t.mock.method(fs, 'appendFileSync', (_file: unknown, data: unknown) => {
      const line = String(data)
      logs.push(line)
      if (line.includes('apply: channel ') || line.includes('apply: start failed')) finished.resolve()
    })
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const store = new StateStore(join(home, 'wechat', 'state.json'))
    t.mock.method(store, 'read', async () => ({
      version: 1 as const, accounts: {}, syncBufs: {}, contextTokens: {}, bindings: {}, sentMessages: {},
      ...(saved === undefined ? {} : { autoStart: saved }),
    }))
    let runtime: { start(): Promise<void>; status(): Promise<{ enabled: boolean }> } | undefined
    let effect: (() => unknown) | undefined
    const ctx = {
      get: (name: string) => name === 'homePaths' ? { home } : undefined,
      provide: (name: string, value: unknown) => {
        if (name === 'wechatChannel') runtime = value as typeof runtime
      },
      effect: (callback: () => unknown) => { effect = callback },
      on: () => () => {},
    }
    apply(ctx as unknown as WechatContext, { autoStart: configured }, { stateStore: store })
    assert.ok(runtime)
    assert.ok(effect)
    const start = t.mock.method(runtime, 'start', async () => {})
    effect()
    await finished.promise
    assert.ok(logs.every((line) => !line.includes('apply: start failed')), logs.join('\n'))
    assert.equal(start.mock.callCount(), starts)
    assert.equal((await runtime.status()).enabled, starts === 1)
    assert.ok(logs.some((line) => line.includes(starts ? 'apply: channel started' : 'apply: channel disabled')))
  })
}
