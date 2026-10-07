/**
 * Media transfer: send images and files to a chat, and fetch what arrived.
 *
 * The flow is the same in both directions and is split across two services:
 *
 *   upload   `getuploadurl` reserves a slot and returns a signed CDN target, then
 *            the client encrypts the plaintext and POSTs it to that target.
 *   download the item carries a CDN reference plus the AES key; the client fetches
 *            the ciphertext and decrypts it locally.
 *
 * Every byte is AES-128-ECB with PKCS#7 padding. The upload declares three numbers
 * that must agree with the actual bytes — plaintext size, plaintext MD5, and the
 * *padded ciphertext* size — because the service validates them.
 *
 * @module @dsh-wechat/core/media
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { CDN_BASE_URL, DEFAULT_API_TIMEOUT_MS } from './constants.ts'
import { aesEcbPaddedSize, aesKeyToBase64, aesKeyToHex, decryptAesEcb, encryptAesEcb, parseAesKey } from './crypto.ts'
import { silkToWav } from './silk.ts'
import { apiCall, assertSendAccepted } from './http.ts'
import type {
  CDNMedia,
  GetUploadUrlResp,
  MessageItem,
  SendMessageResp,
  UploadMediaTypeValue,
  WeixinAccount,
} from './types.ts'
import { MessageItemType, MessageState, MessageType, UploadMediaType } from './types.ts'

/** Retries for a CDN upload. 4xx aborts immediately; 5xx is worth retrying. */
const UPLOAD_MAX_RETRIES = 3

/**
 * A file larger than this is refused before any network work.
 *
 * 100 MB, matching the reference implementation's inbound ceiling. A lower local limit
 * rejects files the service is perfectly willing to carry.
 */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/** What an upload produced, in the terms the message item needs. */
export interface UploadedMedia {
  /** CDN reference to embed in the item. */
  media: CDNMedia
  /** Plaintext size. */
  size: number
  /** Padded ciphertext size, which is what some item fields expect. */
  ciphertextSize: number
  /** Original file name, for `file_item`. */
  fileName: string
  /** Original plaintext MD5, for `file_item`. */
  md5: string
  /**
   * Raw AES-128 key, hex encoded.
   *
   * Carried separately because an image item declares the key in two places: the media
   * reference uses base64, while `image_item.aeskey` uses raw hex. The service sends both
   * on an inbound photo, and a reference carrying only the base64 form cannot be
   * decrypted by the recipient, which is what renders as an empty placeholder.
   */
  aesKeyHex: string
  /**
   * Uploaded thumbnail, when one could be produced.
   *
   * A chat bubble paints the thumbnail, so an image sent without one shows as an empty
   * placeholder even though the full-size object is present and fetchable. Absent when no
   * image encoder is available in the deployment.
   */
  thumbnail?: { media: CDNMedia; size: number; width: number; height: number }
}

/** Options for {@link uploadMedia}. */
export interface UploadOptions {
  account: WeixinAccount
  /** Recipient user id. The service requires it on the upload request. */
  toUserId: string
  /** Bytes to send. */
  data: Buffer
  /** File name shown to the recipient. */
  fileName: string
  /** Media kind, which selects the service-side handling. */
  mediaType: UploadMediaTypeValue
  /** Override the CDN host. Tests only. */
  cdnBaseUrl?: string
  signal?: AbortSignal
  /**
   * Optional observer for the raw `getuploadurl` response and the derived upload target.
   *
   * The service returns more than this client consumes, and the gap between what it
   * offers and what a message actually references is exactly how a sent image can be
   * accepted by the service yet never render for the recipient.
   */
  onDiagnostic?: (detail: {
    uploadUrl: string
    downloadParam: string
    response: Record<string, unknown>
  }) => void
}

/**
 * Reserve an upload slot, encrypt, and push the bytes to the CDN.
 *
 * @param options - See {@link UploadOptions}.
 * @returns The reference and the numbers a message item needs.
 * @throws {Error} When the file is too large, or the service returns no upload URL.
 */
export async function uploadMedia(options: UploadOptions): Promise<UploadedMedia> {
  const { account, toUserId, data, fileName, mediaType } = options
  if (data.length === 0) throw new Error('不能发送空文件')
  if (data.length > MAX_MEDIA_BYTES) {
    throw new Error(`文件超过 ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB 上限`)
  }

  const rawSize = data.length
  const rawMd5 = createHash('md5').update(data).digest('hex')
  const ciphertextSize = aesEcbPaddedSize(rawSize)
  const fileKey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)

  const slot = await apiCall<GetUploadUrlResp>({
    baseUrl: account.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: {
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: ciphertextSize,
      // Videos and images can carry thumbnails, but the upload still works without
      // one and generating them locally is not worth the complexity here.
      no_need_thumb: true,
      // The service expects the hex form here; the message item carries the same key
      // again, also as hex, in `image_item.aeskey`.
      aeskey: aesKeyToHex(aesKey),
      base_info: { channel_version: '2.4.9' },
    },
    token: account.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const target = resolveUploadTarget({
    slot,
    cdnBaseUrl: options.cdnBaseUrl ?? CDN_BASE_URL,
    fileKey,
  })
  const headerParam = await pushToCdn({ target, data, aesKey, label: fileName })
  const downloadParam = resolveDownloadParam(headerParam)

  // Diagnostics: the service hands back more than the one field this client uses, and
  // the unused fields are the only way to tell whether a sent image is actually
  // retrievable. Reporting them costs one optional callback.
  options.onDiagnostic?.({
    uploadUrl: target,
    downloadParam,
    response: slot as unknown as Record<string, unknown>,
  })

  return {
    media: {
      encrypt_query_param: downloadParam,
      aes_key: aesKeyToBase64(aesKey),
      // 1 = "thumbnail / mid-size metadata packed in". This is what the reference
      // implementation sends for images and files, and it is the value the recipient
      // expects; 0 makes the reference unreadable to the client.
      encrypt_type: 1,
    },
    size: rawSize,
    ciphertextSize,
    fileName,
    md5: rawMd5,
    aesKeyHex: aesKeyToHex(aesKey),
  }
}

/** Convenience wrapper for sending an image file from disk. */
export async function uploadImage(params: {
  account: WeixinAccount
  toUserId: string
  path: string
  signal?: AbortSignal
}): Promise<UploadedMedia> {
  return await uploadMedia({
    account: params.account,
    toUserId: params.toUserId,
    data: await readFile(params.path),
    fileName: basename(params.path),
    mediaType: UploadMediaType.IMAGE,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/** Convenience wrapper for sending a generic file attachment from disk. */
export async function uploadFile(params: {
  account: WeixinAccount
  toUserId: string
  path: string
  fileName?: string
  signal?: AbortSignal
}): Promise<UploadedMedia> {
  const path = params.path
  return await uploadMedia({
    account: params.account,
    toUserId: params.toUserId,
    data: await readFile(path),
    fileName: params.fileName ?? basename(path),
    mediaType: UploadMediaType.FILE,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/**
 * Send an already-uploaded image.
 *
 * @param params.account - Sending bot.
 * @param params.to - Recipient user id.
 * @param params.uploaded - Result of {@link uploadMedia} with `IMAGE`.
 * @param params.contextToken - Token from the inbound message being answered.
 */
export async function sendImage(params: {
  account: WeixinAccount
  to: string
  uploaded: UploadedMedia
  contextToken?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  // Exactly the fields the reference implementation sends, and no others:
  //   media     — the CDN reference, whose `aes_key` is base64 of the key's hex *text*
  //   mid_size  — the image's ciphertext size
  // Extra fields are not harmless here. `image_item.aeskey` and thumbnail references are
  // both absent from the reference implementation's image item, and a key declared in a
  // form the client does not expect decrypts to nothing — which is precisely the grey
  // placeholder this used to produce.
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: params.uploaded.media,
      mid_size: params.uploaded.ciphertextSize,
    },
  }
  return await sendItem({
    account: params.account,
    to: params.to,
    item,
    ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/** Convenience wrapper for sending a video file from disk. */
export async function uploadVideo(params: {
  account: WeixinAccount
  toUserId: string
  path: string
  signal?: AbortSignal
}): Promise<UploadedMedia> {
  return await uploadMedia({
    account: params.account,
    toUserId: params.toUserId,
    data: await readFile(params.path),
    fileName: basename(params.path),
    mediaType: UploadMediaType.VIDEO,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/**
 * Send an already-uploaded video.
 *
 * Video is its own item kind with its own handler, not a file attachment: the reference
 * implementation uploads it as `UploadMediaType.VIDEO` and sends a `video_item`, and a raw
 * video routed through the file path arrives as an opaque download instead of a playable
 * clip.
 *
 * @param params.account - Sending bot.
 * @param params.to - Recipient user id.
 * @param params.uploaded - Result of {@link uploadMedia} with `VIDEO`.
 * @param params.contextToken - Token from the inbound message being answered.
 */
export async function sendVideo(params: {
  account: WeixinAccount
  to: string
  uploaded: UploadedMedia
  contextToken?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  // Exactly the fields the reference `sendVideoMessageWeixin` sends: the reference and the
  // ciphertext size. No thumbnail reference, no md5 — extra fields are a shape the recipient
  // does not expect.
  const item: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: params.uploaded.media,
      video_size: params.uploaded.ciphertextSize,
    },
  }
  return await sendItem({
    account: params.account,
    to: params.to,
    item,
    ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/**
 * Send an already-uploaded file attachment.
 *
 * `len` is a uint64 on the wire, so it goes out as a string.
 */
export async function sendFile(params: {
  account: WeixinAccount
  to: string
  uploaded: UploadedMedia
  contextToken?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  // Matches the reference implementation's file item: the media reference, a name, and the
  // plaintext length as a string. `md5` is deliberately absent — it is not part of the
  // outbound file item, and the wire format tolerates no extra fields here.
  const item: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: params.uploaded.media,
      file_name: params.uploaded.fileName,
      len: String(params.uploaded.size),
    },
  }
  return await sendItem({
    account: params.account,
    to: params.to,
    item,
    ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/** Send one structured item as a finished bot message. */
export async function sendItem(params: {
  account: WeixinAccount
  to: string
  item: MessageItem
  contextToken?: string
  /**
   * Identifier of the agent run this item belongs to.
   *
   * The reference client stamps every item of one run with the same `run_id`, and the progress
   * cards in particular are grouped by it. Omitting it makes a card an orphan message the
   * client has no run to attach to — which is consistent with a card that is accepted by the
   * service and never rendered.
   */
  runId?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  const clientId = `dsh-wechat-${randomUUID()}`
  const response = await apiCall<SendMessageResp>({
    baseUrl: params.account.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: {
      msg: {
        from_user_id: '',
        to_user_id: params.to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [params.item],
        ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
        ...(params.runId === undefined ? {} : { run_id: params.runId }),
      },
    },
    token: params.account.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  assertSendAccepted(response)
  return {
    clientId,
    ...(response.message_id === undefined ? {} : { serverMessageId: response.message_id }),
  }
}

/**
 * Send one tool-call item as the WeChat client's own tool card.
 *
 * The start and result cards are the same request with different payloads: the client keys
 * them together by `tool_call_id`, so a result with no matching start is a card the user
 * never sees. `status` is normalised to the four values the reference client sends.
 *
 * @param params.phase - `start` announces the call; `end` reports its outcome.
 * @param params.toolName - Tool being run, shown on the card.
 * @param params.toolCallId - Identity pairing the start and result cards.
 * @param params.failed - Set when the call did not succeed.
 */
export async function sendToolCard(params: {
  account: WeixinAccount
  to: string
  phase: 'start' | 'end'
  toolName: string
  toolCallId?: string
  failed?: boolean
  contextToken?: string
  /**
   * The agent run this card belongs to.
   *
   * The reference client passes the run id on every progress item, which is how the receiving
   * client groups a run's cards. A card without one has no run to attach to.
   */
  runId?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  const now = Date.now()
  const item: MessageItem = {
    type: params.phase === 'start' ? MessageItemType.TOOL_CALL_START : MessageItemType.TOOL_CALL_RESULT,
    create_time_ms: now,
    is_completed: params.phase === 'end',
    ...(params.phase === 'start'
      ? {
          tool_call_start_item: {
            tool_name: params.toolName,
            ...(params.toolCallId === undefined ? {} : { tool_call_id: params.toolCallId }),
          },
        }
      : {
          tool_call_result_item: {
            tool_name: params.toolName,
            ...(params.toolCallId === undefined ? {} : { tool_call_id: params.toolCallId }),
            // The reference client normalises to exactly these four values.
            status: params.failed === true ? 'failed' : 'completed',
          },
        }),
  }
  return await sendItem({
    account: params.account,
    to: params.to,
    item,
    ...(params.contextToken === undefined ? {} : { contextToken: params.contextToken }),
    ...(params.runId === undefined ? {} : { runId: params.runId }),
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
}

/** One attachment recovered from an inbound message. */
export interface DownloadedMedia {
  /** Which item kind it came from. */
  kind: 'image' | 'file' | 'voice' | 'video'
  /** Plaintext bytes. */
  data: Buffer
  /** File name for files; a synthesised one otherwise. */
  fileName: string
  /** Content type when it can be inferred. */
  contentType?: string
  /** Original plaintext size as declared by the sender, for files. */
  declaredSize?: number
  /** Server-side transcript, for voice. */
  transcript?: string
  /** Wire encoding for voice: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex. */
  codec?: number
  /** Decoded length in milliseconds, for voice that was transcoded and for video. */
  durationMs?: number
  /** Content MD5 as declared by the sender, for video. */
  md5?: string
}

/** Options for {@link downloadItemMedia}. */
export interface DownloadOptions {
  /** The item to fetch. */
  item: MessageItem
  /** Override the CDN host. Tests only. */
  cdnBaseUrl?: string
  signal?: AbortSignal
}

/**
 * Fetch and decrypt whatever media one inbound item carries.
 *
 * @param options - See {@link DownloadOptions}.
 * @returns The plaintext, or `undefined` when the item holds no usable media.
 */
export async function downloadItemMedia(options: DownloadOptions): Promise<DownloadedMedia | undefined> {
  const { item } = options
  const cdnBaseUrl = options.cdnBaseUrl ?? CDN_BASE_URL

  if (item.type === MessageItemType.IMAGE && item.image_item) {
    const image = item.image_item
    const reference = image.media
    // An image may carry its key at the item level as well; either form is enough.
    if (!hasReference(reference) || (!image.aeskey && !reference?.aes_key)) return undefined
    const data = await fetchAndDecrypt({
      reference,
      // Images put the raw hex key on the item; it takes precedence.
      key: resolveItemKey({ hex: image.aeskey, base64: reference.aes_key, label: '图片' }),
      cdnBaseUrl,
      label: '图片',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return { kind: 'image', data, fileName: `image-${timestamp()}.jpg`, contentType: 'image/jpeg' }
  }

  if (item.type === MessageItemType.FILE && item.file_item) {
    const file = item.file_item
    const reference = file.media
    // A file carries its key on the reference, unlike an image which also has an
    // item-level hex key. Without both a reference and a key there is nothing to fetch,
    // and issuing the request anyway would turn a malformed item into a network error.
    if (!hasReference(reference) || !reference?.aes_key) return undefined
    const data = await fetchAndDecrypt({
      reference,
      key: resolveItemKey({ base64: reference.aes_key, label: '文件' }),
      cdnBaseUrl,
      label: '文件',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return {
      kind: 'file',
      data,
      fileName: file.file_name ?? `file-${timestamp()}.bin`,
      ...(file.len === undefined ? {} : { declaredSize: Number(file.len) }),
    }
  }

  if (item.type === MessageItemType.VOICE && item.voice_item) {
    const voice = item.voice_item
    const reference = voice.media
    // A voice item carries its key on the reference, and also declares the encoding.
    if (!hasReference(reference) || !reference?.aes_key) return undefined
    const silk = await fetchAndDecrypt({
      reference,
      key: resolveItemKey({ base64: reference.aes_key, label: '语音' }),
      cdnBaseUrl,
      label: '语音',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    // Voice arrives as SILK, which nothing here can play. Transcode it when the codec is
    // available; otherwise hand over the raw bytes rather than losing the note, and let the
    // server-side transcript carry the meaning.
    const wav = await silkToWav(silk)
    const data = wav?.data ?? silk
    return {
      kind: 'voice',
      data,
      fileName: wav === undefined ? `voice-${timestamp()}.silk` : `voice-${timestamp()}.wav`,
      contentType: wav === undefined ? 'audio/silk' : 'audio/wav',
      ...(voice.text === undefined ? {} : { transcript: voice.text }),
      ...(voice.encode_type === undefined ? {} : { codec: voice.encode_type }),
      ...(wav === undefined ? {} : { durationMs: wav.durationMs }),
    }
  }

  if (item.type === MessageItemType.VIDEO && item.video_item) {
    const video = item.video_item
    const reference = video.media
    // Like a file, a video carries its key on the reference. Skipping the fetch when either
    // half is missing keeps a malformed item from becoming a network error.
    if (!hasReference(reference) || !reference?.aes_key) return undefined
    const data = await fetchAndDecrypt({
      reference,
      key: resolveItemKey({ base64: reference.aes_key, label: '视频' }),
      cdnBaseUrl,
      label: '视频',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return {
      kind: 'video',
      data,
      fileName: `video-${timestamp()}.mp4`,
      contentType: 'video/mp4',
      // The sender declares the length; carrying it lets the agent reason about the clip
      // without opening it.
      ...(video.play_length === undefined ? {} : { durationMs: video.play_length }),
      ...(video.video_md5 === undefined ? {} : { md5: video.video_md5 }),
    }
  }

  return undefined
}

/**
 * Whether an item carries downloadable media.
 *
 * The payload check matters as much as the type tag: a malformed or stripped item can
 * keep its type while losing its `media` reference, and treating that as an attachment
 * produces an inbound message with neither text nor anything to fetch.
 */
export function isMediaItem(item: MessageItem): boolean {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return item.image_item?.media !== undefined
    case MessageItemType.FILE:
      return item.file_item?.media !== undefined
    case MessageItemType.VOICE:
      return item.voice_item?.media !== undefined
    case MessageItemType.VIDEO:
      return item.video_item?.media !== undefined
    default:
      return false
  }
}

/** Build the CDN download URL from a reference. */
export function buildDownloadUrl(reference: CDNMedia, cdnBaseUrl = CDN_BASE_URL): string {
  const full = reference.full_url?.trim()
  if (full) return full
  const param = reference.encrypt_query_param?.trim()
  if (!param) throw new Error('媒体引用里既没有 full_url 也没有 encrypt_query_param')
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(param)}`
}

/** Retries for a CDN download. A just-uploaded object can need a moment to be readable. */
const DOWNLOAD_MAX_RETRIES = 4

/** Base delay between download retries; grows linearly. */
const DOWNLOAD_RETRY_DELAY_MS = 600

/** Fetch ciphertext and decrypt it. */
async function fetchAndDecrypt(params: {
  reference: CDNMedia
  key: Buffer
  cdnBaseUrl: string
  label: string
  signal?: AbortSignal
}): Promise<Buffer> {
  const url = buildDownloadUrl(params.reference, params.cdnBaseUrl)
  const ciphertext = await fetchCdnBytes({
    url,
    label: params.label,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  })
  try {
    return decryptAesEcb(ciphertext, params.key)
  } catch (error) {
    throw new Error(
      `${params.label}: 解密失败（${ciphertext.length} 字节密文）—— key 与内容不匹配。${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Download ciphertext with retries.
 *
 * A 4xx other than 404 is not retried: the request itself is wrong. A 404 or 5xx is
 * retried, because a freshly uploaded object is not always readable immediately.
 */
async function fetchCdnBytes(params: {
  url: string
  label: string
  signal?: AbortSignal
}): Promise<Buffer> {
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt += 1) {
    const response = await fetch(params.url, {
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    })
    if (response.ok) return Buffer.from(await response.arrayBuffer())

    // Keep the service's own explanation: without it a failure is undiagnosable.
    const body = await response.text().catch(() => '')
    const detail = `HTTP ${response.status}${body ? ` — ${body.slice(0, 300)}` : ''}`
    const retryable = response.status === 404 || response.status >= 500
    if (!retryable || attempt === DOWNLOAD_MAX_RETRIES) {
      throw new Error(`${params.label} 下载失败 ${detail}`)
    }
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_RETRY_DELAY_MS * attempt))
  }
  throw new Error(`${params.label} 下载失败（已重试 ${DOWNLOAD_MAX_RETRIES} 次）`)
}

/**
 * Whether a reference names something that can actually be fetched.
 *
 * A type predicate, so callers that guard with it get a non-optional reference afterwards
 * instead of a second undefined check.
 */
function hasReference(reference: CDNMedia | undefined): reference is CDNMedia {
  if (reference === undefined) return false
  return Boolean(reference.full_url?.trim() || reference.encrypt_query_param?.trim())
}

/** Pick the key an inbound item offers, preferring the item-level hex form. */
function resolveItemKey(params: {
  hex?: string
  base64?: string
  label: string
}): Buffer {
  if (params.hex) return Buffer.from(params.hex, 'hex')
  if (params.base64) return parseAesKey(params.base64, params.label)
  throw new Error(`${params.label}: 消息里没有可用的 AES key`)
}

/** Choose the CDN target from what the service returned. */
function resolveUploadTarget(params: {
  slot: GetUploadUrlResp
  cdnBaseUrl: string
  fileKey: string
}): string {
  const full = params.slot.upload_full_url?.trim()
  if (full) return full
  const param = params.slot.upload_param?.trim()
  if (!param) {
    throw new Error('服务端未返回上传地址（upload_full_url 与 upload_param 都为空）')
  }
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(params.fileKey)}`
}

/**
 * The media reference a message item must carry.
 *
 * This is the upload response's own `x-encrypted-param` header, and nothing else. The long
 * parameter inside `upload_full_url` is the *upload* grant: it is refused when used to read
 * the object back, so substituting it produces an item the recipient cannot resolve.
 *
 * @param headerParam - Value of the upload response's `x-encrypted-param` header.
 * @returns The reference to embed.
 */
function resolveDownloadParam(headerParam: string): string {
  return headerParam
}

/** Encrypt and POST to the reserved CDN target, returning the upload receipt header. */
async function pushToCdn(params: {
  target: string
  data: Buffer
  aesKey: Buffer
  label: string
  signal?: AbortSignal
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.data, params.aesKey)
  let lastError: unknown

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(params.target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        ...(params.signal === undefined ? {} : { signal: params.signal }),
      })

      if (response.status >= 400 && response.status < 500) {
        // A rejected request will be rejected again; do not retry it.
        const detail = response.headers.get('x-error-message') ?? (await response.text())
        throw new Error(`CDN 拒绝了上传 (HTTP ${response.status}): ${detail.slice(0, 200)}`)
      }
      if (!response.ok) {
        throw new Error(`CDN 上传失败 HTTP ${response.status}`)
      }

      const downloadParam = response.headers.get('x-encrypted-param')
      if (!downloadParam) throw new Error('CDN 上传成功但未返回 x-encrypted-param')
      return downloadParam
    } catch (error) {
      lastError = error
      // Client errors are terminal; everything else gets another try.
      if (error instanceof Error && error.message.startsWith('CDN 拒绝')) throw error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('CDN 上传多次失败')
}

/** Timestamp fragment for synthesised file names. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
