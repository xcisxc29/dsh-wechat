/**
 * Tests for reading interactive prompts back out of a chat reply.
 *
 * These parsers sit between a user's words and a decision that may grant permission to run
 * something, so the failure modes matter in both directions: reading a denial as consent grants
 * an action the user refused, and refusing to understand a reply strands someone at a prompt
 * with no way forward. Both are pinned here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseApprovalReply,
  parseQuestionReply,
  presentApproval,
  presentQuestions,
  type QuestionItem,
} from '../src/interactions.ts'

test('consent in either language allows once', () => {
  for (const reply of ['允许', '同意', '可以', '好', '行', 'yes', 'OK', 'allow', ' 允许 ']) {
    assert.equal(parseApprovalReply(reply), 'allowed-once', reply)
  }
})

test('a denial is never read as consent', () => {
  // "不允许" contains "允许", so a substring match would grant exactly what was refused.
  for (const reply of ['拒绝', '不允许', '不行', '不要', 'no', 'deny', '取消', 'cancel']) {
    assert.equal(parseApprovalReply(reply), 'rejected', reply)
  }
})

test('an unrecognised reply is not treated as a decision', () => {
  // Returning undefined keeps the prompt open. Guessing "rejected" here would silently refuse
  // work the user may have meant to allow.
  for (const reply of ['', '   ', '这是什么', '让我想想', 'maybe']) {
    assert.equal(parseApprovalReply(reply), undefined, JSON.stringify(reply))
  }
})

test('a prompt names the tool and the reason', () => {
  const shown = presentApproval({ toolName: 'shell', reason: 'rm -rf build' }).body
  assert.match(shown, /shell/)
  assert.match(shown, /rm -rf build/)
  assert.match(shown, /允许/)
  assert.match(shown, /拒绝/)
})

test('a prompt without a reason still reads sensibly', () => {
  const shown = presentApproval({ toolName: 'read' }).body
  assert.match(shown, /read/)
  // No empty "reason" line should be left dangling where the reason would have been.
  assert.doesNotMatch(shown, /\n\n\n/)
})

test('a question is numbered so it can be answered with one keypress', () => {
  const shown = presentQuestions([
    {
      id: 'q1',
      question: '用哪个方案？',
      options: [{ label: '重写', description: '改动大但彻底' }, { label: '打补丁' }],
    },
  ]).body
  assert.match(shown, /1\. 重写 — 改动大但彻底/)
  assert.match(shown, /2\. 打补丁/)
})

test('a number selects the option at that position', () => {
  const questions: QuestionItem[] = [
    { id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] },
  ]
  assert.deepEqual(parseQuestionReply(questions, '2'), {
    answers: [{ id: 'q1', selected: ['乙'] }],
  })
})

test('several numbers select several options for a multi-select question', () => {
  const questions: QuestionItem[] = [
    {
      id: 'q1',
      question: '选多个',
      multiSelect: true,
      options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
    },
  ]
  // A Chinese keyboard produces a full-width comma, so both separators have to work.
  assert.deepEqual(parseQuestionReply(questions, '1，3'), {
    answers: [{ id: 'q1', selected: ['甲', '丙'] }],
  })
  assert.deepEqual(parseQuestionReply(questions, '1, 2').answers[0].selected, ['甲', '乙'])
})

test('only the first option is kept when a single-select question gets several', () => {
  const questions: QuestionItem[] = [
    { id: 'q1', question: '只选一个', options: [{ label: '甲' }, { label: '乙' }] },
  ]
  assert.deepEqual(parseQuestionReply(questions, '2,1').answers[0].selected, ['乙'])
})

test('a number outside the options is not read as a choice', () => {
  const questions: QuestionItem[] = [
    { id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] },
  ]
  // Three options were not offered, so "3" is free text rather than a wrong option. Reading it
  // as a position would select nothing and stall the turn.
  assert.deepEqual(parseQuestionReply(questions, '3').answers[0], {
    id: 'q1',
    selected: [],
    custom: '3',
  })
})

test('free-form text is carried through rather than refused', () => {
  const withOptions: QuestionItem[] = [
    { id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] },
  ]
  assert.deepEqual(parseQuestionReply(withOptions, '都不太合适').answers[0], {
    id: 'q1',
    selected: [],
    custom: '都不太合适',
  })

  const withoutOptions: QuestionItem[] = [{ id: 'q1', question: '叫什么？' }]
  assert.deepEqual(parseQuestionReply(withoutOptions, '小助').answers[0], {
    id: 'q1',
    selected: [],
    custom: '小助',
  })
})

test('an exact option label is accepted as a selection', () => {
  const questions: QuestionItem[] = [
    { id: 'q1', question: '选一个', options: [{ label: '重写' }, { label: '打补丁' }] },
  ]
  assert.deepEqual(parseQuestionReply(questions, '打补丁').answers[0], {
    id: 'q1',
    selected: ['打补丁'],
  })
})

test('every question in a batch gets an answer', () => {
  // The harness validates one answer per question, so a short reply must still produce the full
  // set rather than an array that fails validation.
  const questions: QuestionItem[] = [
    { id: 'q1', question: '第一个', options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'q2', question: '第二个' },
  ]
  const batch = parseQuestionReply(questions, '2')
  assert.equal(batch.answers.length, 2)
  assert.deepEqual(batch.answers[0], { id: 'q1', selected: ['乙'] })
  assert.deepEqual(batch.answers[1], { id: 'q2', selected: [], custom: '2' })
})
