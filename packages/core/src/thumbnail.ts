/**
 * Thumbnail generation for outbound images.
 *
 * A WeChat chat bubble is rendered from a thumbnail, not from the full-size object. An
 * image item that references only the original shows as an empty placeholder: the
 * message arrives, and there is nothing for the client to paint.
 *
 * The encoder is `sharp`, which ships with the application and resolves from the
 * profile. It is loaded lazily and treated as optional: without it the caller falls back
 * to sending the original object alone, which is worse but still a delivered file.
 *
 * @module @dsh-wechat/core/thumbnail
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Longest thumbnail edge. Chat bubbles never need more. */
const THUMB_MAX_EDGE = 240

/** JPEG quality for the thumbnail. Small enough to upload instantly, still legible. */
const THUMB_QUALITY = 72

/**
 * The subset of the `sharp` API this module uses.
 *
 * Declared structurally on purpose: `sharp` is not a dependency of this package — it
 * ships with the application — so there is no type declaration to import, and a missing
 * encoder must stay a soft failure rather than a compile error.
 */
interface SharpPipeline {
  rotate(): SharpPipeline
  resize(options: Record<string, unknown>): SharpPipeline
  jpeg(options: Record<string, unknown>): SharpPipeline
  toBuffer(): Promise<Buffer>
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
}

type SharpFactory = (input: Buffer) => SharpPipeline

let cached: SharpFactory | null | undefined

/** Whether optional codecs are disabled for this process. See {@link codecsDisabled}. */
const DISABLE_ENV = 'DSH_WECHAT_NO_CODECS'

/**
 * Whether the optional codecs are switched off by configuration.
 *
 * `sharp` and `silk-wasm` are resolved at runtime, and neither is a dependency of this package — a
 * fresh install has `sharp` only because the application ships it, and `silk-wasm` at all only if
 * someone installed it. The paths that handle their absence are therefore the common path, and this
 * switch makes them reachable on a machine where the codec *is* present: without it those paths can
 * only be reasoned about, never executed, and a regression that made a missing codec throw would
 * pass every test and break for every new user.
 *
 * Set `DSH_WECHAT_NO_CODECS=1` to force both codecs unavailable. It is also the quick way to confirm
 * which behaviour a stripped deployment will get.
 *
 * @returns True when the codecs must report themselves unavailable.
 */
export function codecsDisabled(): boolean {
  const value = process.env[DISABLE_ENV]
  return value === '1' || value === 'true'
}

/** Drop the memoised encoder, so a test can re-resolve under a changed environment. */
export function forgetCodecCache(): void {
  cached = undefined
}

/**
 * Load `sharp`, or report that it is unavailable.
 *
 * `sharp` is not a dependency of this package — it ships with the application, which sits
 * well outside this package's own directory tree. A specifier resolved from *this file's*
 * location therefore misses it, so resolution is anchored on the installed package root,
 * which is a directory Node's walk does reach it from.
 *
 * Cached because a missing encoder is common on a stripped deployment and the attempt is
 * not free. An explicit `null` records a decided absence, distinct from `undefined`
 * ("not asked yet").
 */
async function loadSharp(): Promise<SharpFactory | null> {
  if (cached !== undefined) return cached
  if (codecsDisabled()) {
    cached = null
    return cached
  }
  try {
    cached = resolveSharp()
  } catch {
    cached = null
  }
  return cached
}

/**
 * Resolve `sharp` from the nearest enclosing package root that can see it.
 *
 * Every ancestor package root is tried in turn rather than stopping at the first one. A
 * source checkout has a root `package.json` that cannot resolve the encoder, while the
 * installed package two directories up can — so the first root is not a reliable anchor.
 *
 * @returns The encoder factory.
 * @throws When no reachable root can resolve it.
 */
function resolveSharp(): SharpFactory {
  const start = fileURLToPath(import.meta.url)
  const tried: string[] = []

  // Candidate roots: every enclosing package root, then the profile's own node_modules.
  // The last one matters because `sharp` lives outside this package's tree entirely, so a
  // source checkout — and any context where the plugin is not the resolving package —
  // reaches it no other way.
  const roots: string[] = []
  let dir = dirname(start)
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) roots.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  roots.push(join(home, 'profiles', 'desktop', 'node_modules'))
  roots.push(join(home, 'node_modules'))

  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'package.json'))
      const loaded = require('sharp') as { default?: SharpFactory } | SharpFactory
      return (loaded as { default?: SharpFactory }).default ?? (loaded as SharpFactory)
    } catch {
      tried.push(root)
    }
  }
  throw new Error(`sharp 未找到，已尝试 ${String(tried.length)} 个解析基点`)
}

/** Whether a thumbnail can be produced in this deployment. */
export async function thumbnailAvailable(): Promise<boolean> {
  return (await loadSharp()) !== null
}

/**
 * Render a compact JPEG thumbnail for one image.
 *
 * @param data - Original image bytes, in any format `sharp` reads.
 * @returns Thumbnail bytes with their pixel size, or `undefined` when no encoder is
 *   available or the input cannot be decoded.
 */
export async function makeThumbnail(
  data: Buffer,
): Promise<{ data: Buffer; width: number; height: number } | undefined> {
  const sharp = await loadSharp()
  if (sharp === null) return undefined

  try {
    // `rotate()` with no argument applies the EXIF orientation, so a portrait photo is
    // not delivered sideways.
    const pipeline = sharp(data).rotate().resize({
      width: THUMB_MAX_EDGE,
      height: THUMB_MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    const buffer = await pipeline.jpeg({ quality: THUMB_QUALITY }).toBuffer()

    // Read the produced size back rather than predicting it, so the item carries the real
    // thumbnail dimensions.
    const meta = await sharp(buffer).metadata()
    return {
      data: buffer,
      width: typeof meta.width === 'number' ? meta.width : THUMB_MAX_EDGE,
      height: typeof meta.height === 'number' ? meta.height : THUMB_MAX_EDGE,
    }
  } catch {
    // An unreadable or unsupported image is not a reason to fail the send.
    return undefined
  }
}
