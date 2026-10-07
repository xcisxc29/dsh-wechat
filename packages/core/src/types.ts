/**
 * Wire types for the Tencent iLink Bot API.
 *
 * The API speaks JSON over HTTP. Fields the protocol defines as `uint64` (message
 * identifiers) are parsed as strings on purpose — see {@link parseWireJson}.
 *
 * @module @dsh-wechat/core/types
 */

/** Common metadata attached to every request. */
export interface BaseInfo {
  channel_version?: string
  /** Observability-only identity hint. Never used for authentication or routing. */
  bot_agent?: string
}

/** `media_type` for `getuploadurl`. Phase 2 uses these. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

export type UploadMediaTypeValue = (typeof UploadMediaType)[keyof typeof UploadMediaType]

/** Request for a pre-signed CDN upload slot. */
export interface GetUploadUrlReq {
  filekey?: string
  media_type?: number
  to_user_id?: string
  /** Plaintext size in bytes. */
  rawsize?: number
  /** Plaintext MD5, hex. */
  rawfilemd5?: string
  /** Ciphertext size in bytes, after AES-128-ECB padding. */
  filesize?: number
  /** Thumbnail plaintext size. Required for IMAGE/VIDEO unless thumbnails are waived. */
  thumb_rawsize?: number
  /** Thumbnail plaintext MD5. */
  thumb_rawfilemd5?: string
  /** Thumbnail ciphertext size. */
  thumb_filesize?: number
  /** Set true to skip thumbnail allocation entirely. */
  no_need_thumb?: boolean
  /** AES-128 key as a hex string. */
  aeskey?: string
  base_info?: BaseInfo
}

/** The reserved CDN upload slot. */
export interface GetUploadUrlResp {
  /** Signed upload parameter; build the URL from it when `upload_full_url` is absent. */
  upload_param?: string
  /** Signed thumbnail upload parameter, when one was allocated. */
  thumb_upload_param?: string
  /** Complete upload URL, ready to POST to. */
  upload_full_url?: string
  ret?: number
  errmsg?: string
}

/** Author of a message. */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const

/**
 * Content element kinds.
 *
 * `TOOL_CALL_START` / `TOOL_CALL_RESULT` are rendered natively by the WeChat
 * client, which is what makes in-chat tool activity possible without any custom UI.
 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/**
 * Message lifecycle.
 *
 * `NEW -> GENERATING -> FINISH` is what enables progressive updates: an outbound
 * message can be revised while it is still generating.
 */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

/** `status` for `sendtyping`. */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const

export interface TextItem {
  text?: string
}

/** CDN reference to an AES-128-ECB encrypted blob. */
export interface CDNMedia {
  encrypt_query_param?: string
  /** Base64-encoded AES key. */
  aes_key?: string
  /** 0 = fileid only, 1 = thumbnail/mid-size metadata packed in. */
  encrypt_type?: number
  full_url?: string
}

export interface ImageItem {
  media?: CDNMedia
  thumb_media?: CDNMedia
  /** Raw AES-128 key as hex; preferred over `media.aes_key` for inbound decryption. */
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface VoiceItem {
  media?: CDNMedia
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number
  bits_per_sample?: number
  sample_rate?: number
  playtime?: number
  /** Server-side speech-to-text, present on inbound voice when available. */
  text?: string
}

export interface FileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  /** uint64 on the wire, hence string. */
  len?: string
}

export interface VideoItem {
  media?: CDNMedia
  video_size?: number
  play_length?: number
  video_md5?: string
  thumb_media?: CDNMedia
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
}

export interface ToolCallStartItem {
  tool_name?: string
  tool_call_id?: string
}

export interface ToolCallResultItem {
  tool_name?: string
  tool_call_id?: string
  status?: string
}

export interface PartialText {
  start: string
  end: string
  startindex: number
  endindex: number
  quotemd5: string
}

/** A quoted message. Newer clients only send the server id, so local caching is required. */
export interface RefMessage {
  message_item?: MessageItem
  title?: string
  svr_id?: string
  partial_text?: PartialText
}

export interface MessageItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: RefMessage
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
  tool_call_start_item?: ToolCallStartItem
  tool_call_result_item?: ToolCallResultItem
}

/** One inbound or outbound message. */
export interface WeixinMessage {
  seq?: number
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  /** Present for group conversations. */
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  /** Issued per inbound message and required verbatim on the reply. */
  context_token?: string
  run_id?: string
}

export interface GetUpdatesReq {
  /** Cached incremental cursor; empty string on first request or after a reset. */
  get_updates_buf?: string
  base_info?: BaseInfo
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  /** Server-suggested hold time for the next long poll. */
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WeixinMessage
}

export interface SendMessageResp {
  message_id?: string
  /**
   * Refusal code.
   *
   * The service answers a refused send with `errcode`, not `ret`, and with HTTP 200 — so a missing
   * `errcode` here meant every failure looked like a success. `-14` is a timed-out session; see
   * {@link STALE_TOKEN_ERRCODE}.
   */
  errcode?: number
  ret?: number
  errmsg?: string
}

export interface SendTypingReq {
  ilink_user_id?: string
  typing_ticket?: string
  status?: number
}

export interface SendTypingResp {
  ret?: number
  errmsg?: string
}

export interface GetConfigResp {
  ret?: number
  errmsg?: string
  /** Base64 ticket required by `sendtyping`. */
  typing_ticket?: string
}

export interface NotifyResp {
  ret?: number
  errmsg?: string
}

/** One QR-code login attempt. */
export interface QRCodeResponse {
  /** Opaque session handle passed back to the status endpoint. */
  qrcode: string
  /** Rendered QR payload, normally a `liteapp.weixin.qq.com` link. */
  qrcode_img_content: string
}

/**
 * Every status the QR endpoint can report.
 *
 * `scaned_but_redirect` means the polling host must change; `binded_redirect`
 * means the server considers this client already bound and will not re-issue.
 */
export type QRStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface QRStatusResponse {
  status: QRStatus
  /** Issued on `confirmed`. */
  bot_token?: string
  /** Bot identity, e.g. `xxxx@im.bot`. Serves as the account id. */
  ilink_bot_id?: string
  /** API host to use after login. */
  baseurl?: string
  /** The WeChat user who scanned. */
  ilink_user_id?: string
  /** Host to switch to on `scaned_but_redirect`. */
  redirect_host?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

/** Persisted credential for one logged-in bot account. */
export interface WeixinAccount {
  accountId: string
  token: string
  baseUrl: string
  /** WeChat user id bound to this bot. */
  userId?: string
  savedAt?: string
  /** Observed bind time of the current token, for diagnostics. */
  boundAt?: string
}
