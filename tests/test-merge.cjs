/* Test: merge logic against the real captured API response. */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

require('../extension/lib/merge.js');
const M = globalThis.KSMerge;

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8'));

// --- envelope extraction
const msgs = M.extractMessages(sample);
assert.strictEqual(msgs.length, 10, 'extracts 10 messages');
assert.deepStrictEqual(M.extractMessages(null), []);
assert.deepStrictEqual(M.extractMessages({ data: { data: [{ _id: 'x' }] } }), [{ _id: 'x' }]);
assert.deepStrictEqual(M.extractMessages({ data: [{ _id: 'y' }] }), [{ _id: 'y' }]);
assert.deepStrictEqual(M.extractMessages([{ _id: 'z' }]), [{ _id: 'z' }]);
assert.deepStrictEqual(M.extractMessages({ nope: 1 }), []);

// --- selected choice logic
const withChoices = msgs.find((m) => m.choices && m.choices.length > 1);
assert.ok(withChoices, 'sample has a multi-choice message');
const sel = M.selectedChoice(withChoices);
assert.strictEqual(sel._id, withChoices._selectedChoiceId, 'picks _selectedChoiceId');
assert.ok(M.selectedChoice({ choices: [{ _id: 'a' }, { _id: 'b' }], choiceIndex: 1 })._id === 'b', 'falls back to choiceIndex');
assert.ok(M.selectedChoice({ choices: [{ _id: 'a' }] })._id === 'a', 'falls back to first choice');
assert.strictEqual(M.selectedChoice({}), null);

// --- rows (content is required!)
const rows = M.sortMessages(msgs, 'asc').map((m, i) => M.messageToRow(m, i + 1));
assert.strictEqual(rows.length, 10);
for (const r of rows) {
  assert.ok(typeof r.content === 'string' && r.content.length > 20, 'every row has content: ' + r.id);
  assert.ok(r.createdAt, 'createdAt set');
  assert.ok(r.chatId === '6adf35d941b1d32e4ee75f98', 'chatId parsed');
}
const userRows = rows.filter((r) => r.role === 'user');
const asstRows = rows.filter((r) => r.role === 'assistant');
assert.ok(userRows.length >= 2 && asstRows.length >= 5, 'both roles present');
assert.ok(userRows.every((r) => r.characterName === 'Mira'), 'user rows carry characterName');
assert.ok(asstRows.every((r) => r.model.includes('Qwen')), 'assistant rows carry model');
assert.ok(asstRows.every((r) => typeof r.totalTokens === 'number' && r.totalTokens > 0), 'token counts numeric');
assert.ok(rows.some((r) => r.moderation.includes('sexual=')), 'moderation flattened');

// chronological order
for (let i = 1; i < rows.length; i++) {
  assert.ok(rows[i - 1].createdAt <= rows[i].createdAt, 'sorted ascending by createdAt');
}

// descending sort mirrors it
const desc = M.sortMessages(msgs, 'desc').map((m) => m.createdAt);
assert.deepStrictEqual(desc, rows.map((r) => r.createdAt).slice().reverse());

// slim message (what ks:getState sends): same rows, about a third of the size
const asSlim = (list) => list.map(M.slimMessage);
assert.deepStrictEqual(asSlim(msgs).map((m, i) => M.messageToRow(m, i)), msgs.map((m, i) => M.messageToRow(m, i)), 'slim rows equal full rows');
assert.strictEqual(M.selectedChoice(M.slimMessage(withChoices))._id, withChoices._selectedChoiceId, 'slim keeps the selected choice');
const byIndex = { _id: 'i', choices: [{ _id: 'a', content: 'A' }, { _id: 'b', content: 'B' }], choiceIndex: 1 };
assert.strictEqual(M.messageToRow(M.slimMessage(byIndex)).content, 'B', 'slim resolves choiceIndex');
assert.deepStrictEqual(M.messageToRow(M.slimMessage({ _id: 'n' })), M.messageToRow({ _id: 'n' }), 'no choices');
assert.ok(JSON.stringify(asSlim(msgs)).length < JSON.stringify(msgs).length / 2, 'slim is much smaller');

// column contract: content present and early
const keys = M.MERGED_COLUMNS.map(([k]) => k);
assert.ok(keys.includes('content') && keys.indexOf('content') < 6, 'content column exists near front');
assert.strictEqual(keys[keys.length - 1], 'block', 'block is the last column');
assert.strictEqual(M.MERGED_COLUMNS[keys.length - 1][1], 'Block (20 msgs)');
assert.strictEqual(M.messageToRow(msgs[0], 1).block, '', 'no block given → empty cell');
assert.strictEqual(M.messageToRow(msgs[0], 1, 3).block, 3);

console.log('PASS merge: %d messages, %d user / %d assistant, content OK', rows.length, userRows.length, asstRows.length);
