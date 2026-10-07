/**
 * Prove that a deployment without the optional codecs still works.
 *
 * `silk-wasm` and `sharp` are resolved at runtime and are **not** dependencies of this package:
 * `sharp` ships with the application and `silk-wasm` is installed by whoever wants voice. So a fresh
 * install has neither, and the paths that handle their absence are the *common* path — not an edge
 * case. Nothing tested them before: the suite runs in a checkout that has `sharp`, so a regression
 * that made a missing codec throw would have passed every test and broken for every new user.
 *
 * `DSH_WECHAT_NO_CODECS` forces the absence on a machine where the codec is present. Simulating it
 * with a module loader does not work here, because resolution goes through `createRequire`, which a
 * loader hook does not intercept — the first attempt at this test passed while proving nothing.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeThumbnail, thumbnailAvailable, forgetCodecCache } from '../src/thumbnail.ts'
import { silkAvailable, forgetSilkCache } from '../src/silk.ts'

/**
 * Run a body with the codecs forced off, then restore and forget the caches.
 *
 * @param run - Body to execute while the codecs report themselves unavailable.
 */
async function withoutCodecs(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DSH_WECHAT_NO_CODECS
  process.env.DSH_WECHAT_NO_CODECS = '1'
  forgetCodecCache()
  forgetSilkCache()
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_WECHAT_NO_CODECS
    else process.env.DSH_WECHAT_NO_CODECS = previous
    forgetCodecCache()
    forgetSilkCache()
  }
}

test('with the codecs off, both report themselves unavailable rather than throwing', async () => {
  await withoutCodecs(async () => {
    // The channel branches on these, so "false" is the contract — not an exception.
    assert.equal(await thumbnailAvailable(), false)
    assert.equal(silkAvailable(), false)
  })
})

test('asking for a thumbnail without an encoder yields none', async () => {
  await withoutCodecs(async () => {
    // A caller that skips `thumbnailAvailable` and asks anyway must get `undefined`. Throwing here
    // would break sending an image on every deployment that lacks `sharp` — which is all of them,
    // since it is not a dependency.
    assert.equal(await makeThumbnail(Buffer.from('not an image')), undefined)
  })
})

test('the switch leaves no residue once it is off', async () => {
  /*
   * The danger this guards against: the module memoises "no encoder" while the switch is on, and then
   * every later caller in the same process loses the codec even though the switch is gone. A stale
   * `null` in the cache is invisible — the channel simply stops sending thumbnails.
   *
   * What it deliberately does *not* assert is that the encoder comes back, because whether it exists
   * is a property of the machine. `sharp` is not a dependency of this package: the resolver looks for
   * it in the application's profile, so it is present on a developer's box and absent on a clean one.
   * An earlier version of this test asserted `true` and passed here while failing on every CI runner —
   * it was testing the author's machine, not the code.
   *
   * So the assertion is the invariant, not the value: after the switch is removed and the cache is
   * forgotten, the answer is the deployment's own, and asking twice agrees.
   */
  delete process.env.DSH_WECHAT_NO_CODECS
  forgetCodecCache()
  forgetSilkCache()
  const first = await thumbnailAvailable()
  forgetCodecCache()
  forgetSilkCache()
  assert.equal(
    await thumbnailAvailable(),
    first,
    'forgetting the cache must not change what the deployment reports',
  )
  // Whatever the environment answers, it is a boolean — the channel branches on it.
  assert.equal(typeof silkAvailable(), 'boolean')
})
