/**
 * Tests for the sent-message record that resolves quoted messages.
 *
 * A quote arrives as an id and nothing else — the inbound `ref_msg.message_item` carries
 * `type: 0`, no text, and only a `msg_id` — so the quoted content exists nowhere unless this
 * record kept it. These pin the lookup and, more importantly, its bound: an unbounded record
 * would grow the state file forever.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SENT_MESSAGE_HISTORY,
  findSentMessage,
  rememberSentMessage,
  type ChannelState,
  type SentMessage,
} from '../src/state.ts'

/** A minimal state to record into. */
function emptyState(): ChannelState {
  return {
    version: 1,
    accounts: {},
    syncBufs: {},
    contextTokens: {},
    bindings: {},
    sentMessages: {},
  }
}

/** One recorded message. */
function entry(messageId: string, preview = `body ${messageId}`): SentMessage {
  return { messageId, kind: 'text', preview, at: Date.now() }
}

test('a recorded message is found by the id a quote carries', () => {
  const state = emptyState()
  rememberSentMessage(state, 'acct', 'acct:peer', entry('7513217119399260936', '阿房宫赋是唐代杜牧'))

  const found = findSentMessage(state, 'acct', '7513217119399260936')
  assert.equal(found?.preview, '阿房宫赋是唐代杜牧')
  assert.equal(found?.kind, 'text')
})

test('an unknown id resolves to nothing rather than to a wrong message', () => {
  const state = emptyState()
  rememberSentMessage(state, 'acct', 'acct:peer', entry('111'))
  // A quote of a message from another channel, or one that aged out, must not be answered with
  // whichever entry happens to be first.
  assert.equal(findSentMessage(state, 'acct', '999'), undefined)
})

test('a message is not found under a different account', () => {
  const state = emptyState()
  rememberSentMessage(state, 'acct-a', 'acct-a:peer', entry('111'))
  assert.equal(findSentMessage(state, 'acct-b', '111'), undefined)
})

test('the lookup searches every conversation of the account', () => {
  // A quote carries an id and no conversation. Ids are unique, so searching wider can only help:
  // a message sent into a conversation the quote did not name is still the right message.
  const state = emptyState()
  rememberSentMessage(state, 'acct', 'acct:peer-one', entry('111'))
  rememberSentMessage(state, 'acct', 'acct:peer-two', entry('222'))

  assert.equal(findSentMessage(state, 'acct', '222')?.messageId, '222')
})

test('the record stays bounded, dropping the oldest first', () => {
  const state = emptyState()
  for (let i = 0; i < SENT_MESSAGE_HISTORY + 10; i += 1) {
    rememberSentMessage(state, 'acct', 'acct:peer', entry(String(i)))
  }
  const history = state.sentMessages.acct['acct:peer']
  assert.equal(history.length, SENT_MESSAGE_HISTORY, 'bounded per conversation')

  // The newest survive, which is what matters: only a recent message is ever quoted.
  assert.equal(findSentMessage(state, 'acct', String(SENT_MESSAGE_HISTORY + 9)) !== undefined, true)
  assert.equal(findSentMessage(state, 'acct', '0'), undefined, 'the oldest is gone')
})

test('the bound is per conversation, so one busy chat cannot evict another', () => {
  const state = emptyState()
  for (let i = 0; i < SENT_MESSAGE_HISTORY + 5; i += 1) {
    rememberSentMessage(state, 'acct', 'acct:busy', entry(`busy-${String(i)}`))
  }
  rememberSentMessage(state, 'acct', 'acct:quiet', entry('quiet-1'))

  assert.equal(state.sentMessages.acct['acct:quiet'].length, 1)
  assert.equal(findSentMessage(state, 'acct', 'quiet-1')?.messageId, 'quiet-1')
})
