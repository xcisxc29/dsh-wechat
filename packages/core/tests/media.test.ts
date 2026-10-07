/**
 * Unit tests for the media layer.
 *
 * The crypto helpers and the AES-key parsing are the parts worth pinning down: a
 * wrong key never throws a useful error, it just produces garbage bytes. The wire
 * format carries the same key in three different encodings depending on media kind,
 * so each is covered explicitly.
 *
 * Media transfer against the live CDN is verified separately by the smoke script,
 * which prints the plaintext size, MD5, and a format sniff for what it received.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  aesEcbPaddedSize,
  aesKeyToBase64,
  aesKeyToBase64Raw,
  aesKeyToHex,
  decryptAesEcb,
  encryptAesEcb,
  newAesKey,
  parseAesKey,
  resolveInboundKey,
} from '../src/crypto.ts'
import { buildDownloadUrl, isMediaItem } from '../src/media.ts'
import { pcmToWav } from '../src/silk.ts'
import type { CDNMedia, MessageItem } from '../src/types.ts'

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

test('AES-128-ECB round-trips and produces the advertised padded size', () => {
  const key = newAesKey()
  assert.equal(key.length, 16)

  // PKCS#7 always adds padding, so an exact multiple still grows by a block.
  for (const size of [1, 15, 16, 17, 4096]) {
    const plaintext = Buffer.alloc(size, 0x41)
    const ciphertext = encryptAesEcb(plaintext, key)
    assert.equal(ciphertext.length, aesEcbPaddedSize(size), `padded size for ${size}`)
    assert.equal(ciphertext.length % 16, 0)
    assert.deepEqual(decryptAesEcb(ciphertext, key), plaintext)
  }
})

test('AES-128-ECB rejects a key of the wrong length', () => {
  assert.throws(() => encryptAesEcb(Buffer.from('x'), Buffer.alloc(15)), /16 字节/)
})

test('parseAesKey accepts all three encodings seen on the wire', () => {
  const raw = Buffer.from('0123456789abcdef', 'ascii')
  const hex = raw.toString('hex')

  // 1. Raw hex, as images carry on the item.
  assert.deepEqual(parseAesKey(hex), raw)
  // 2. Base64 of the 16 raw bytes, the common case.
  assert.deepEqual(parseAesKey(raw.toString('base64')), raw)
  // 3. Base64 of a 32-character hex string, seen on file/voice/video.
  assert.deepEqual(parseAesKey(Buffer.from(hex, 'ascii').toString('base64')), raw)
  // Whitespace is tolerated.
  assert.deepEqual(parseAesKey(`  ${hex}  `), raw)
})

test('parseAesKey rejects anything that is not a 16-byte key', () => {
  assert.throws(() => parseAesKey(''), /缺少 AES key/)
  assert.throws(() => parseAesKey(Buffer.alloc(10).toString('base64')), /AES key/)
})

test('key renderers match what each wire field expects', () => {
  const key = Buffer.from('0123456789abcdef', 'ascii')

  // `image_item.aeskey` is the bare hex.
  assert.equal(aesKeyToHex(key), '30313233343536373839616263646566')

  // `media.aes_key` is base64 of that hex *text* — 44 characters, not the 24 you get from
  // base64 of the 16 raw bytes. The raw form is accepted by the service and silently fails
  // to decrypt on the recipient, so both forms are pinned here to keep them distinct.
  assert.equal(aesKeyToBase64(key), 'MzAzMTMyMzMzNDM1MzYzNzM4Mzk2MTYyNjM2NDY1NjY=')
  assert.equal(aesKeyToBase64(key).length, 44)
  assert.equal(aesKeyToBase64Raw(key), 'MDEyMzQ1Njc4OWFiY2RlZg==')
  assert.equal(aesKeyToBase64Raw(key).length, 24)

  // Every form a reader may encounter still round-trips to the same bytes.
  assert.deepEqual(parseAesKey(aesKeyToHex(key)), key)
  assert.deepEqual(parseAesKey(aesKeyToBase64(key)), key)
  assert.deepEqual(parseAesKey(aesKeyToBase64Raw(key)), key)
})

test('resolveInboundKey prefers the item-level hex key, as images require', () => {
  const itemKey = Buffer.from('aaaaaaaaaaaaaaaa', 'ascii')
  const mediaKey = Buffer.from('bbbbbbbbbbbbbbbb', 'ascii')

  assert.deepEqual(
    resolveInboundKey({
      itemAesKeyHex: itemKey.toString('hex'),
      mediaAesKeyBase64: mediaKey.toString('base64'),
    }),
    itemKey,
  )
  assert.deepEqual(resolveInboundKey({ mediaAesKeyBase64: mediaKey.toString('base64') }), mediaKey)
  assert.throws(() => resolveInboundKey({}), /没有可用的 AES key/)
})

// ---------------------------------------------------------------------------
// CDN references
// ---------------------------------------------------------------------------

test('buildDownloadUrl prefers full_url and falls back to the parameter', () => {
  const full: CDNMedia = {
    full_url: 'https://cdn.example/full',
    encrypt_query_param: 'ignored',
  }
  assert.equal(buildDownloadUrl(full, 'https://base'), 'https://cdn.example/full')

  // The fallback must percent-encode the parameter: it is itself an encoded blob.
  const param: CDNMedia = { encrypt_query_param: 'a+b/c=' }
  assert.equal(buildDownloadUrl(param, 'https://base'), 'https://base/download?encrypted_query_param=a%2Bb%2Fc%3D')

  assert.throws(() => buildDownloadUrl({}, 'https://base'), /既没有 full_url/)
})

test('isMediaItem requires a payload, not just a media type tag', () => {
  // A bare type with no `media` reference is not downloadable. Accepting it yields an
  // inbound message with neither text nor anything to fetch, which reads as a message
  // that arrived and then went nowhere.
  const bare = (type: number): MessageItem => ({ type })
  for (const type of [2, 3, 4, 5]) {
    assert.ok(!isMediaItem(bare(type)), `type ${String(type)} without a payload is not media`)
  }

  const media: CDNMedia = { encrypt_query_param: 'p' }
  assert.ok(isMediaItem({ type: 2, image_item: { media } }))
  assert.ok(isMediaItem({ type: 3, voice_item: { media } }))
  assert.ok(isMediaItem({ type: 4, file_item: { media } }))
  assert.ok(isMediaItem({ type: 5, video_item: { media } }))

  assert.ok(!isMediaItem(bare(1))) // TEXT
  assert.ok(!isMediaItem(bare(11))) // TOOL_CALL_START
})

test('an end-to-end encrypt/decrypt cycle reproduces the original bytes', () => {
  // Mirrors what the upload and download paths do to a file in each direction.
  const original = Buffer.from('这是一个测试文件的内容，用于验证加解密链路。', 'utf8')
  const key = newAesKey()
  const ciphertext = encryptAesEcb(original, key)

  // The upload declares this MD5 and size, and the download must recover both.
  const md5 = createHash('md5').update(original).digest('hex')
  const recovered = decryptAesEcb(ciphertext, key)
  assert.equal(createHash('md5').update(recovered).digest('hex'), md5)
  assert.equal(recovered.length, original.length)
  assert.deepEqual(recovered, original)
})

test('an outbound image matches the reference media encoding', async () => {
  // The service's own client builds an image item as:
  //   { media: { encrypt_query_param, aes_key: base64(hex text), encrypt_type: 1 },
  //     mid_size: <ciphertext size> }
  // `aes_key` is the subtle one: base64 of the key's 32-character hex *text*, not of its
  // 16 raw bytes. The raw form is 24 characters and does not decrypt, so the recipient
  // accepts the message and shows an empty placeholder instead of the image.
  const { sendImage } = await import('../src/media.ts')
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

  const captured: { body?: string } = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    captured.body = typeof init?.body === 'string' ? init.body : undefined
    return new Response(JSON.stringify({ message_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await sendImage({
      account: {
        accountId: 'a@im.bot',
        token: 't',
        baseUrl: 'https://example.invalid',
        userId: 'u@im.wechat',
        savedAt: new Date(0).toISOString(),
      },
      to: 'u@im.wechat',
      uploaded: {
        media: { encrypt_query_param: 'p', aes_key: aesKeyToBase64(aesKey), encrypt_type: 1 },
        size: 8,
        ciphertextSize: 16,
        fileName: 'x.png',
        md5: 'd41d8cd98f00b204e9800998ecf8427e',
        aesKeyHex: aesKey.toString('hex'),
      },
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.ok(captured.body, 'the send request body must be captured')
  const sent = JSON.parse(captured.body) as {
    msg: {
      item_list: {
        image_item?: {
          media?: { aes_key?: string; encrypt_type?: number }
          mid_size?: number
          aeskey?: string
        }
      }[]
    }
  }
  const image = sent.msg.item_list[0].image_item

  // base64 of the 32-character hex text, not of the 16 raw bytes.
  assert.equal(image?.media?.aes_key, 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=')
  assert.equal(image?.media?.aes_key?.length, 44, 'the raw-byte form would be 24 characters')
  assert.equal(
    parseAesKey(image?.media?.aes_key ?? '', 'test').toString('hex'),
    aesKey.toString('hex'),
    'and it must round-trip back to the same key',
  )
  assert.equal(image?.media?.encrypt_type, 1)
  assert.equal(image?.mid_size, 16, 'mid_size is the ciphertext size')
  // The reference image item carries no item-level key and no thumbnail reference; an
  // extra key declaration is a form the client does not expect.
  assert.equal(image?.aeskey, undefined)
})

test('an outbound file matches the reference file encoding', async () => {
  // The reference file item is exactly: media, file_name, len — with `len` the plaintext
  // length as a string. There is no `md5` field, and adding one is not harmless.
  const { sendFile } = await import('../src/media.ts')
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

  const captured: { body?: string } = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    captured.body = typeof init?.body === 'string' ? init.body : undefined
    return new Response(JSON.stringify({ message_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await sendFile({
      account: {
        accountId: 'a@im.bot',
        token: 't',
        baseUrl: 'https://example.invalid',
        userId: 'u@im.wechat',
        savedAt: new Date(0).toISOString(),
      },
      to: 'u@im.wechat',
      uploaded: {
        media: { encrypt_query_param: 'p', aes_key: aesKeyToBase64(aesKey), encrypt_type: 1 },
        size: 4096,
        ciphertextSize: 4112,
        fileName: '报表.xlsx',
        md5: 'd41d8cd98f00b204e9800998ecf8427e',
        aesKeyHex: aesKey.toString('hex'),
      },
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.ok(captured.body)
  const sent = JSON.parse(captured.body) as {
    msg: {
      item_list: {
        file_item?: {
          media?: { aes_key?: string; encrypt_type?: number }
          file_name?: string
          len?: string
          md5?: string
        }
      }[]
    }
  }
  const file = sent.msg.item_list[0].file_item
  assert.equal(file?.file_name, '报表.xlsx', 'the name is the attachment name, unmodified')
  assert.equal(file?.len, '4096', 'len is the *plaintext* size, as a string')
  assert.equal(file?.media?.aes_key, 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=')
  assert.equal(file?.media?.encrypt_type, 1)
  assert.equal(file?.md5, undefined, 'the reference file item carries no md5')
})

test('an outbound video matches the reference video encoding', async () => {
  // Video is its own item kind with its own handler, not a file attachment. The reference
  // sends exactly the CDN reference plus `video_size` — no thumbnail, no md5.
  const { sendVideo } = await import('../src/media.ts')
  const aesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

  const captured: { body?: string } = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    captured.body = typeof init?.body === 'string' ? init.body : undefined
    return new Response(JSON.stringify({ message_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await sendVideo({
      account: {
        accountId: 'a@im.bot',
        token: 't',
        baseUrl: 'https://example.invalid',
        userId: 'u@im.wechat',
        savedAt: new Date(0).toISOString(),
      },
      to: 'u@im.wechat',
      uploaded: {
        media: { encrypt_query_param: 'p', aes_key: aesKeyToBase64(aesKey), encrypt_type: 1 },
        size: 1_048_576,
        ciphertextSize: 1_048_592,
        fileName: 'clip.mp4',
        md5: 'd41d8cd98f00b204e9800998ecf8427e',
        aesKeyHex: aesKey.toString('hex'),
      },
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.ok(captured.body)
  const sent = JSON.parse(captured.body) as {
    msg: {
      item_list: {
        type?: number
        video_item?: {
          media?: { aes_key?: string; encrypt_type?: number; encrypt_query_param?: string }
          video_size?: number
          thumb_media?: unknown
          video_md5?: string
        }
      }[]
    }
  }
  const item = sent.msg.item_list[0]
  assert.equal(item.type, 5, 'the item is a VIDEO, not a FILE')
  assert.equal(item.video_item?.video_size, 1_048_592, 'video_size is the ciphertext size')
  assert.equal(item.video_item?.media?.aes_key, 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=')
  assert.equal(item.video_item?.media?.encrypt_type, 1)
  assert.equal(item.video_item?.media?.encrypt_query_param, 'p')
  assert.equal(item.video_item?.thumb_media, undefined, 'the reference sends no thumbnail')
  assert.equal(item.video_item?.video_md5, undefined, 'and no md5')
})

test('a tool start card matches the reference tool-call encoding', async () => {
  // The chat client renders these natively and pairs them by `tool_call_id`, which is why the
  // id rides on both cards and why the item types are 11 and 12 rather than plain text.
  const { sendToolCard } = await import('../src/media.ts')

  const captured: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') captured.push(init.body)
    return new Response(JSON.stringify({ message_id: '1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const account = {
    accountId: 'a@im.bot',
    token: 't',
    baseUrl: 'https://example.invalid',
    userId: 'u@im.wechat',
    savedAt: new Date(0).toISOString(),
  }

  try {
    await sendToolCard({
      account,
      to: 'u@im.wechat',
      phase: 'start',
      toolName: 'read',
      toolCallId: 'call-1',
    })
    await sendToolCard({
      account,
      to: 'u@im.wechat',
      phase: 'end',
      toolName: 'read',
      toolCallId: 'call-1',
      failed: true,
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(captured.length, 2, 'one request per card')
  const start = JSON.parse(captured[0]) as {
    msg: {
      item_list: {
        type?: number
        is_completed?: boolean
        create_time_ms?: number
        tool_call_start_item?: { tool_name?: string; tool_call_id?: string }
      }[]
    }
  }
  const startItem = start.msg.item_list[0]
  assert.equal(startItem.type, 11, 'TOOL_CALL_START')
  assert.equal(startItem.is_completed, false, 'a start card is not complete')
  assert.equal(startItem.tool_call_start_item?.tool_name, 'read')
  assert.equal(startItem.tool_call_start_item?.tool_call_id, 'call-1')
  assert.equal(typeof startItem.create_time_ms, 'number', 'the client orders cards by time')

  const end = JSON.parse(captured[1]) as {
    msg: {
      item_list: {
        type?: number
        is_completed?: boolean
        tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string }
      }[]
    }
  }
  const endItem = end.msg.item_list[0]
  assert.equal(endItem.type, 12, 'TOOL_CALL_RESULT')
  assert.equal(endItem.is_completed, true)
  assert.equal(endItem.tool_call_result_item?.status, 'failed', 'a failure is not reported as done')
  assert.equal(endItem.tool_call_result_item?.tool_call_id, 'call-1', 'the same id pairs them')
})

test('a tool card without an id still renders standalone', async () => {
  const { sendToolCard } = await import('../src/media.ts')
  const captured: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') captured.push(init.body)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    await sendToolCard({
      account: {
        accountId: 'a@im.bot',
        token: 't',
        baseUrl: 'https://example.invalid',
        userId: 'u@im.wechat',
        savedAt: new Date(0).toISOString(),
      },
      to: 'u@im.wechat',
      phase: 'end',
      toolName: 'grep',
    })
  } finally {
    globalThis.fetch = realFetch
  }

  const end = JSON.parse(captured[0]) as {
    msg: { item_list: { tool_call_result_item?: { status?: string; tool_call_id?: string } }[] }
  }
  assert.equal(end.msg.item_list[0].tool_call_result_item?.status, 'completed')
  assert.equal(end.msg.item_list[0].tool_call_result_item?.tool_call_id, undefined)
})

test('a tool card carries the run id that groups it', async () => {
  // The reference client stamps every item of one run with the same `run_id`, and the progress
  // cards are the items that need it: a card with no run has nothing to attach to, which is
  // consistent with a card the service accepts and the client never draws.
  const { sendToolCard } = await import('../src/media.ts')
  const captured: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') captured.push(init.body)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const account = {
    accountId: 'a@im.bot',
    token: 't',
    baseUrl: 'https://example.invalid',
    userId: 'u@im.wechat',
    savedAt: new Date(0).toISOString(),
  }

  try {
    await sendToolCard({
      account,
      to: 'u@im.wechat',
      phase: 'start',
      toolName: 'read',
      toolCallId: 'call-1',
      runId: 'session-abc',
    })
    // The end card of the same call must carry the same run, or the two land in different runs.
    await sendToolCard({
      account,
      to: 'u@im.wechat',
      phase: 'end',
      toolName: 'read',
      toolCallId: 'call-1',
      runId: 'session-abc',
    })
  } finally {
    globalThis.fetch = realFetch
  }

  const runs = captured.map(
    (body) => (JSON.parse(body) as { msg?: { run_id?: string } }).msg?.run_id,
  )
  assert.deepEqual(runs, ['session-abc', 'session-abc'], 'both cards share one run id')
})

test('pcmToWav writes a structurally valid mono 16-bit header', () => {
  // A wrong sample rate or channel count still yields a file that looks like a WAV but plays
  // at the wrong speed or pitch, so every field is pinned rather than just the magic.
  const pcm = new Uint8Array(2000)
  const wav = pcmToWav(pcm, 24_000)

  assert.equal(wav.length, 44 + pcm.length)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size covers everything after itself')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ')
  assert.equal(wav.readUInt32LE(16), 16, 'the fmt chunk is the PCM size')
  assert.equal(wav.readUInt16LE(20), 1, 'PCM format')
  assert.equal(wav.readUInt16LE(22), 1, 'mono')
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.equal(wav.readUInt32LE(28), 48_000, 'byte rate is sampleRate x 2 for mono 16-bit')
  assert.equal(wav.readUInt16LE(32), 2, 'block align')
  assert.equal(wav.readUInt16LE(34), 16, 'bits per sample')
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(wav.readUInt32LE(40), pcm.length)
})

test('pcmToWav handles empty input without a negative length', () => {
  // A zero-length note is unusual, but a header claiming a negative RIFF size is one some
  // decoders reject outright.
  const wav = pcmToWav(new Uint8Array(0), 24_000)
  assert.equal(wav.length, 44)
  assert.equal(wav.readUInt32LE(4), 36)
  assert.equal(wav.readUInt32LE(40), 0)
})

test('sendItem surfaces a refusal, so a file cannot be reported as delivered', async () => {
  /*
   * Every picture, video and document goes out through `sendItem`, so a refusal swallowed here means
   * a file the user was told had been sent and never arrived. That is exactly what happened: the
   * refusal arrives as an HTTP 200 with no `message_id`, and only the code in the body says so.
   */
  const { sendItem } = await import('../src/media.ts')
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errcode: -14, errmsg: 'session timeout' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    await assert.rejects(
      async () =>
        await sendItem({
          account: {
            accountId: 'a@im.bot',
            token: 't',
            baseUrl: 'https://example.invalid',
            userId: 'u@im.wechat',
            savedAt: new Date(0).toISOString(),
          },
          to: 'u@im.wechat',
          item: { type: 1, text_item: { text: 'x' } },
        }),
      /微信会话已超时/,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

