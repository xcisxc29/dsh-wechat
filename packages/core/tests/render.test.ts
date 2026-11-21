/**
 * Guard the interop probe in `render.ts`.
 *
 * `toDataUrl()` swallows every failure on purpose, so a renderer chosen wrongly never throws
 * anywhere a log or a caller could see it: the only symptom is a login page without a QR image,
 * under a step line that still says "scan with your phone". That is exactly what happened on DSH
 * 0.2.2-rc.5, and it took a patched `catch` to find it. The interop shape is also the one thing a
 * unit test can replay without the host, so it is pinned here instead.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickRenderer, toDataUrl } from '../src/render.ts'

/** A renderer stub: the probe only ever looks for `toDataURL`. */
const renderer = {
  toDataURL: async (): Promise<string> => 'data:image/png;base64,AA==',
  toString: async (): Promise<string> => '',
}

test('exports on the namespace are used even when `default` is an empty object', () => {
  /*
   * DSH 0.2.2-rc.5 returns exactly this shape: `Object.keys(namespace)` lists the real exports,
   * `typeof namespace.default === 'object'` holds, and `Object.keys(namespace.default)` is `[]`.
   * `default ?? namespace` therefore picked the empty object, `loadRenderer` threw, and the login
   * page came up without a QR image and without a line anywhere.
   */
  const picked = pickRenderer({
    default: {},
    toDataURL: renderer.toDataURL,
    toString: renderer.toString,
  })
  assert.equal(typeof picked?.toDataURL, 'function')
  assert.equal(picked?.toDataURL, renderer.toDataURL)
})

test('exports on `default` are still used when that is where they land', () => {
  // The ordinary CommonJS interop: the namespace re-exports, `default` is `module.exports`.
  assert.equal(pickRenderer({ default: renderer }), renderer)
})

test('a `default` that cannot render does not shadow a namespace that can', () => {
  const picked = pickRenderer({ default: { default: renderer }, toDataURL: renderer.toDataURL })
  assert.equal(picked?.toDataURL, renderer.toDataURL)
})

test('nothing usable yields undefined, so the caller reports the missing dependency', () => {
  assert.equal(pickRenderer({ default: {} }), undefined)
  assert.equal(pickRenderer(undefined), undefined)
  assert.equal(pickRenderer(null), undefined)
})

test('the real dependency still renders a PNG data URL', async () => {
  // `qrcode` is a dependency of this package, so this runs wherever the suite runs. It fails if the
  // probe ends up selecting an object that only carries a `toDataURL` name.
  const dataUrl = await toDataUrl('https://liteapp.weixin.qq.com/q/example')
  assert.match(String(dataUrl), /^data:image\/png;base64,/)
})
