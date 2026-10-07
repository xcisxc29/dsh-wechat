/**
 * Tests for outbound attachment classification.
 *
 * A wrong kind is not a cosmetic mistake: the service stores image, video, and file objects
 * separately, so a video classified as a file is uploaded under the wrong media type and
 * announced with the wrong item — the recipient gets an opaque download instead of a clip.
 * The mapping is cheap to test and expensive to get wrong, so every branch is pinned.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UploadMediaType } from '@dsh-wechat/core'

import {
  MEDIA_LABEL_BY_KIND,
  MEDIA_TYPE_BY_KIND,
  mediaKindOf,
} from '../src/media-kind.ts'

test('image extensions classify as image', () => {
  for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.heic', 'a.HEIF']) {
    assert.equal(mediaKindOf(name), 'image', name)
  }
})

test('video extensions classify as video', () => {
  for (const name of ['a.mp4', 'a.mov', 'a.m4v', 'a.avi', 'a.mkv', 'a.webm', 'a.3gp', 'A.MP4']) {
    assert.equal(mediaKindOf(name), 'video', name)
  }
})

test('everything else is a file attachment', () => {
  // A file always arrives, just as a download, so this is the safe default rather than a
  // fallback that silently sends the wrong item type.
  for (const name of ['a.pdf', 'a.zip', 'a.txt', 'a.xlsx', 'a', 'a.', 'a.mp3', 'a.wav']) {
    assert.equal(mediaKindOf(name), 'file', name)
  }
})

test('the media type per kind matches the service constants', () => {
  // These values are what `getuploadurl` receives; swapping image and video would have the
  // service prepare the object for the wrong use.
  assert.equal(MEDIA_TYPE_BY_KIND.image, UploadMediaType.IMAGE)
  assert.equal(MEDIA_TYPE_BY_KIND.video, UploadMediaType.VIDEO)
  assert.equal(MEDIA_TYPE_BY_KIND.file, UploadMediaType.FILE)
  // The service's own numbering, pinned so a reordering of the enum cannot pass unnoticed.
  assert.equal(UploadMediaType.IMAGE, 1)
  assert.equal(UploadMediaType.VIDEO, 2)
  assert.equal(UploadMediaType.FILE, 3)
})

test('every kind has a boot-log label', () => {
  // The label is how an outbound send is identified in the log; a missing one would make a
  // failed video indistinguishable from a failed file.
  for (const kind of ['image', 'video', 'file'] as const) {
    assert.ok(MEDIA_LABEL_BY_KIND[kind].length > 0, kind)
  }
})
