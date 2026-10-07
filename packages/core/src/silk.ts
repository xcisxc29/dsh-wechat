/**
 * Voice transcoding: Tencent SILK in, WAV out.
 *
 * WeChat voice notes arrive as SILK, which nothing on this side can play or transcribe. The
 * codec lives in `silk-wasm`, resolved at runtime rather than declared as a hard dependency:
 * the plugin has to keep working without it, falling back to handing over the raw SILK and
 * whatever transcript the service supplied.
 *
 * @see `@tencent-weixin/openclaw-weixin` `src/media/silk-transcode.ts`, which this mirrors.
 *
 * @module @dsh-wechat/core/silk
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Sample rate WeChat records voice at, and the rate the decoder must be told to emit. */
export const SILK_SAMPLE_RATE = 24_000

/** The subset of `silk-wasm` this module uses. */
interface SilkModule {
  decode(
    input: Uint8Array,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>
}

let cached: SilkModule | null | undefined

/**
 * Resolve `silk-wasm`, or report that it is unavailable.
 *
 * Anchored on enclosing package roots rather than a bare specifier, because the codec is
 * installed in the profile while the code may run from a source checkout. Every ancestor is
 * tried, since the first one is not always the one that can see it.
 */
function resolveSilk(): SilkModule {
  const start = fileURLToPath(import.meta.url)
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
      return require('silk-wasm') as SilkModule
    } catch {
      // This root cannot see the codec; keep walking.
    }
  }
  throw new Error('silk-wasm 未找到')
}

/** Whether voice can be transcoded in this deployment. */
export function silkAvailable(): boolean {
  if (cached === undefined) {
    try {
      cached = resolveSilk()
    } catch {
      cached = null
    }
  }
  return cached !== null
}

/**
 * Wrap raw `pcm_s16le` bytes in a WAV container.
 *
 * Mono, 16-bit signed little-endian — the only shape the decoder emits. Written by hand
 * because a 44-byte header is cheaper than a RIFF-writing dependency.
 *
 * @param pcm - Raw PCM samples.
 * @param sampleRate - Samples per second.
 * @returns A complete WAV file.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number = SILK_SAMPLE_RATE): Buffer {
  const totalSize = 44 + pcm.byteLength
  const buffer = Buffer.allocUnsafe(totalSize)
  let offset = 0

  buffer.write('RIFF', offset)
  offset += 4
  buffer.writeUInt32LE(totalSize - 8, offset)
  offset += 4
  buffer.write('WAVE', offset)
  offset += 4

  buffer.write('fmt ', offset)
  offset += 4
  buffer.writeUInt32LE(16, offset)
  offset += 4 // fmt chunk size
  buffer.writeUInt16LE(1, offset)
  offset += 2 // PCM
  buffer.writeUInt16LE(1, offset)
  offset += 2 // mono
  buffer.writeUInt32LE(sampleRate, offset)
  offset += 4
  buffer.writeUInt32LE(sampleRate * 2, offset)
  offset += 4 // byte rate: mono, 16-bit
  buffer.writeUInt16LE(2, offset)
  offset += 2 // block align
  buffer.writeUInt16LE(16, offset)
  offset += 2 // bits per sample

  buffer.write('data', offset)
  offset += 4
  buffer.writeUInt32LE(pcm.byteLength, offset)
  offset += 4

  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, offset)
  return buffer
}

/**
 * Transcode one SILK voice note to WAV.
 *
 * @param silk - Raw SILK bytes as downloaded.
 * @returns The WAV bytes and the decoded duration, or `undefined` when the codec is missing
 *   or the input cannot be decoded. A failure here degrades the attachment; it must not lose
 *   the voice note.
 */
export async function silkToWav(
  silk: Buffer,
): Promise<{ data: Buffer; durationMs: number } | undefined> {
  if (cached === undefined) {
    try {
      cached = resolveSilk()
    } catch {
      cached = null
    }
  }
  if (cached === null) return undefined

  try {
    const decoded = await cached.decode(
      new Uint8Array(silk.buffer, silk.byteOffset, silk.byteLength),
      SILK_SAMPLE_RATE,
    )
    return { data: pcmToWav(decoded.data), durationMs: decoded.duration }
  } catch {
    return undefined
  }
}
