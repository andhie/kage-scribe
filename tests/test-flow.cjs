/* Test: lib/exportflow.js — export scope filters, chat summaries/completeness
 * and the load-before-export wait/retry loop (fake SW state machine, no DOM).
 * Run against the real captured fixture like the other suites. */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

require('../extension/lib/merge.js');
require('../extension/lib/exportflow.js');
const M = globalThis.KSMerge;
const F = globalThis.KSFlow;

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8'));
const msgs = M.extractMessages(sample);
const CHAT_ID = '6adf35d941b1d32e4ee75f98';
assert.strictEqual(msgs.length, 10, 'fixture loaded');

/* ---- 1. filteredMessages: scope, deleted flag, search, order */
{
  const withDeleted = msgs.map((m, i) => (i === 0 ? { ...m, deleted: true } : m));
  assert.strictEqual(F.filteredMessages(withDeleted, 'all', 'all', '', 'asc').length, 9, 'deleted stay hidden');
  assert.strictEqual(F.filteredMessages(msgs, 'other999', 'all', '', 'asc').length, 0, 'chat scope filters');
  const users = F.filteredMessages(msgs, 'all', 'user', '', 'asc');
  assert.ok(users.length >= 2 && users.every((m) => m.role === 'user'), 'role scope filters');

  const a = F.filteredMessages(msgs, 'all', 'all', 'mira', 'asc').map((m) => m._id);
  const b = F.filteredMessages(msgs, 'all', 'all', 'MIRA', 'asc').map((m) => m._id);
  assert.deepStrictEqual(a, b, 'search is case-insensitive');
  assert.ok(a.length >= 2, 'characterName search matches user rows');

  const asc = F.filteredMessages(msgs, 'all', 'all', '', 'asc').map((m) => m.createdAt);
  const desc = F.filteredMessages(msgs, 'all', 'all', '', 'desc').map((m) => m.createdAt);
  assert.deepStrictEqual(desc, asc.slice().reverse(), 'desc mirrors asc');

  assert.strictEqual(F.messagesFor(msgs, CHAT_ID).length, 10, 'messagesFor: chat scope');
  assert.strictEqual(F.messagesFor(withDeleted, 'all').length, 9, 'messagesFor: deleted hidden');
}

/* ---- 2. chatSummaries: grouping, names/totals from meta, newest first */
{
  const other = { _id: 'o1', _chatId: 'other999', role: 'user', createdAt: '2026-10-30T00:00:00.000Z', choices: [{ _id: 'oc', content: 'x' }] };
  const list = F.chatSummaries(msgs.concat([other]), { other999: { name: 'Second', totalCount: 1, site: 'isekaizero' } });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'other999', 'newest activity first');
  assert.strictEqual(list[0].name, 'Second');
  assert.strictEqual(list[0].site, 'isekaizero', 'site label carried onto the summary row');
  assert.strictEqual(list[0].count, 1);
  assert.strictEqual(list[0].total, 1);
  assert.strictEqual(list[1].id, CHAT_ID);
  assert.strictEqual(list[1].count, 10);
  assert.strictEqual(list[1].name, '', 'no meta → blank name');
  assert.strictEqual(list[1].total, null, 'no meta → unknown total');
}

/* ---- 3. chatIsIncomplete */
{
  const chats = { [CHAT_ID]: { totalCount: 12 } };
  assert.strictEqual(F.chatIsIncomplete(chats, msgs, CHAT_ID), true, '10 live < 12 total');
  assert.strictEqual(F.chatIsIncomplete({ [CHAT_ID]: { totalCount: 10 } }, msgs, CHAT_ID), false, 'equal → complete');
  assert.strictEqual(F.chatIsIncomplete({ [CHAT_ID]: { totalCount: 8 } }, msgs, CHAT_ID), true, '10 live > 8 total: a deleted message is still saved');
  assert.strictEqual(F.chatIsIncomplete({}, msgs, CHAT_ID), false, 'unknown total → not known incomplete');
  const withDeleted = msgs.map((m, i) => (i === 0 ? { ...m, deleted: true } : m));
  assert.strictEqual(F.chatIsIncomplete({ [CHAT_ID]: { totalCount: 10 } }, withDeleted, CHAT_ID), true, 'deleted-flagged don\'t count as live');
}

/* ---- 4. friendlyFetchError mapping */
{
  assert.ok(/logged this session out/.test(F.friendlyFetchError('HTTP 401 on page 1 — auth rejected. Refresh the site tab.')));
  assert.ok(/hasn’t been opened/.test(F.friendlyFetchError('No captured messages request found for this chat.')));
  assert.ok(/still loading/.test(F.friendlyFetchError('A "fetch all pages" run is already in progress.')));
  assert.ok(/didn’t respond/.test(F.friendlyFetchError('HTTP 500 on page 2')));
  assert.ok(/isekaizero tab/.test(F.friendlyFetchError('HTTP 500 on page 2', 'isekaizero')), 'names the chat\'s site');
  assert.ok(/site tab/.test(F.friendlyFetchError('HTTP 401', '')) && !/kagesekai/.test(F.friendlyFetchError('HTTP 401', '')), 'no site → "site tab"');
}

/* ---- 4b. storyBlocks: what the storybook Word export shows */
{
  let n = 0;
  const mk = (role, content, over) => ({
    _id: 'sb' + (++n), _chatId: 'c1', role, type: 'normal', createdAt: '2026-01-01T00:00:' + String(n).padStart(2, '0') + '.000Z',
    choices: [{ _id: 'sbc' + n, content, characterName: role === 'user' ? 'Mira' : 'Narrator' }], ...(over || {})
  });
  const persona = (m, name) => ({ ...m, choices: [{ ...m.choices[0], characterName: name }] });
  const list = [
    mk('user', 'first'),
    mk('assistant', '< t >Day: Monday | Time: 08:00 | Location: Pier</t>\nShe *smiles*.'),
    persona(mk('user', 'second'), 'Rin'),                       // persona swap
    persona(mk('user', 'third'), ''),                           // empty name
    mk('assistant', '<t>Day 1 · Afternoon · Gull House</t>The second spelling.'),
    mk('assistant', '<x>Unknown tag</x> stays raw'),
    mk('user', 'secret side talk', { type: 'ooc' }),
    mk('assistant', 'continued', { type: 'continue' })
  ];
  const story = F.storyBlocks(list.slice().reverse(), { c1: { name: 'My Story', site: 'isekaizero', plotSummary: 'Plot.' } }); // newest first in
  assert.strictEqual(story.chats.length, 1);
  const c = story.chats[0];
  assert.deepStrictEqual([c.title, c.site, c.plotSummary, c.count], ['My Story', 'isekaizero', 'Plot.', 7]);
  assert.deepStrictEqual(c.items.map((i) => i.text.slice(0, 5)), ['first', 'She *', 'secon', 'third', 'The s', '<x>Un', 'conti'], 'oldest first, OOC dropped');
  assert.deepStrictEqual(c.items.filter((i) => i.isUser).map((i) => i.name), ['Mira', 'Rin', 'You'], 'persona swap shown from that message on; empty name → You');
  assert.ok(c.items.filter((i) => !i.isUser).every((i) => i.name === null), 'AI items have no name');
  assert.strictEqual(c.items[1].header, 'Day: Monday | Time: 08:00 | Location: Pier');
  assert.strictEqual(c.items[1].text, 'She *smiles*.', 'text is what follows the header');
  assert.strictEqual(c.items[4].header, 'Day 1 · Afternoon · Gull House', 'second spelling matches');
  assert.strictEqual(c.items[5].header, null, 'unknown tag: header null');
  assert.strictEqual(c.items[5].text, '<x>Unknown tag</x> stays raw', 'unknown tag: text unchanged');

  // two chats in order of first appearance; a chat with no name is "Untitled chat"
  const two = F.storyBlocks([mk('user', 'a'), { ...mk('user', 'b'), _chatId: 'c2' }, mk('user', 'c')], { c1: { name: 'One' } });
  assert.deepStrictEqual(two.chats.map((x) => [x.title, x.count]), [['One', 2], ['Untitled chat', 1]]);
  assert.deepStrictEqual(F.storyBlocks([], {}), { chats: [] });
}

/* ---- 4c. blockNumbers: 20 non-OOC messages per block, per chat, before any filter */
{
  const mk = (n, chat, role, type) => ({ _id: 'b' + chat + n, _chatId: chat, role, type: type || 'normal',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), choices: [{ _id: 'bc' + n, content: 'm' + n }] });
  const list = [];
  for (let i = 0; i < 45; i++) list.push(mk(i, 'A', i % 2 ? 'assistant' : 'user', i % 15 === 7 ? 'ooc' : 'normal')); // 3 OOC
  for (let i = 0; i < 3; i++) list.push(mk(i, 'B', 'user'));
  const blocks = F.blockNumbers(list.slice().reverse()); // order of the input does not matter
  const ofChat = (c) => list.filter((m) => m._chatId === c && m.type !== 'ooc').map((m) => blocks.get(m._id));
  const a = ofChat('A');
  assert.strictEqual(a.length, 42);
  assert.deepStrictEqual([a.filter((b) => b === 1).length, a.filter((b) => b === 2).length, a.filter((b) => b === 3).length], [20, 20, 2]);
  assert.ok(list.filter((m) => m.type === 'ooc').every((m) => !blocks.has(m._id)), 'OOC rows get no block');
  assert.deepStrictEqual(ofChat('B'), [1, 1, 1], 'a second chat is numbered on its own');
  // a role filter applied to the input would renumber; the export passes the whole store
  const onlyUsers = F.blockNumbers(list.filter((m) => m.role === 'user'));
  assert.notDeepStrictEqual(onlyUsers.get('bA40'), blocks.get('bA40'), 'filtering BEFORE blockNumbers moves numbers (so the panel never does)');
  assert.strictEqual(F.blockNumbers(list.map((m) => (m._id === 'bA0' ? { ...m, deleted: true } : m))).has('bA0'), false, 'deleted messages are skipped');
  assert.strictEqual(F.BLOCK_SIZE, 20);
}

/* ---- 5. createFlow: fake SW state machine drives the wait loop */

/** Two synthetic backfill messages: what a finished replay would have merged. */
const fill = (cid) => ['f1', 'f2'].map((n, i) => ({
  _id: 'fill-' + n, _chatId: cid, role: 'user',
  createdAt: '2026-10-01T00:00:0' + i + '.000Z',
  choices: [{ _id: 'fill-c' + n, content: 'backfill ' + n }]
}));

function makeFlow(script, opts) {
  const o = opts || {};
  const state = {
    merged: msgs.slice(),
    chats: { [CHAT_ID]: { name: 'Test Chat', totalCount: 12 } }, // 10 live < 12 → incomplete
    fetchStatus: null
  };
  const sent = [];
  const flow = F.createFlow({
    getState: async () => ({ merged: state.merged, chats: state.chats, fetchStatus: state.fetchStatus }),
    send: (type, extra) => {
      sent.push({ type, extra });
      return script(state, extra);
    },
    pollMs: o.pollMs != null ? o.pollMs : 5,
    waitMs: o.waitMs != null ? o.waitMs : 2000
  });
  return { flow, state, sent };
}

/** Standard script: the requested chat's run walks pages then finishes,
 *  merging the missing history. */
const runThatFills = (state, extra) => {
  state.fetchStatus = { running: true, chatId: extra.chatId, page: 1, pages: 2 };
  setTimeout(() => {
    state.merged = state.merged.concat(fill(extra.chatId));
    state.fetchStatus = { running: false, chatId: extra.chatId, doneAt: Date.now(), error: null };
  }, 10);
  return { ok: true };
};

(async () => {

// 5a. happy path: exactly one fetch-all started, chat completed
{
  const { flow, sent } = makeFlow(runThatFills);
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(sent.length, 1, 'one fetch-all started');
  assert.strictEqual(sent[0].type, 'ks:fetchAll');
  assert.strictEqual(sent[0].extra.chatId, CHAT_ID);
  assert.strictEqual(sent[0].extra.pageSize, 100, 'page size raised for the replay');
}

// 5b. adoption: a foreign in-flight run is waited out, then our own starts
{
  const { flow, state, sent } = makeFlow(runThatFills);
  state.fetchStatus = { running: true, chatId: 'someone-else', page: 3 };
  setTimeout(() => { state.fetchStatus = { running: false, chatId: 'someone-else', doneAt: Date.now() }; }, 10);
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(sent.length, 1, 'own run started only after the foreign one finished');
}

// 5c. busy rejection: retried exactly once
{
  let calls = 0;
  const { flow } = makeFlow((state, extra) => {
    calls++;
    if (calls === 1) return { error: 'A "fetch all pages" run is already in progress.' };
    return runThatFills(state, extra);
  });
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(calls, 2, 'retried once after the busy rejection');
}

// 5d. run error surfaced as the friendly message
{
  const { flow, state } = makeFlow((st, extra) => {
    st.fetchStatus = { running: true, chatId: extra.chatId };
    setTimeout(() => {
      st.fetchStatus = { running: false, chatId: extra.chatId, doneAt: Date.now(), error: 'HTTP 401 on page 1 — auth rejected.' };
    }, 10);
    return { ok: true };
  });
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(!r.ok);
  assert.ok(/logged this session out/.test(r.error), 'friendly error: ' + r.error);
  assert.strictEqual(state.merged.length, 10, 'nothing merged by the failed run');
}

// 5e. timeout while another run holds the lock
{
  const { flow, state, sent } = makeFlow(() => ({ ok: true }), { waitMs: 40 });
  state.fetchStatus = { running: true, chatId: 'stuck-forever' }; // never finishes
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(!r.ok && /took too long/.test(r.error), 'timeout message: ' + JSON.stringify(r));
  assert.strictEqual(sent.length, 0, 'no fetch started behind the stuck run');
}

// 5f. live > totalCount and the reload fails on any path: the export goes on with a warning
{
  const over = (script, o) => {
    const r = makeFlow(script, o);
    r.state.chats[CHAT_ID].totalCount = 8; // 10 live > 8 total
    return r;
  };
  // start error (nothing replayable)
  let { flow } = over(() => ({ error: 'No captured messages request found for this chat.' }));
  let r = await flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok && /deleted messages may still be in the file/.test(r.warning), 'start error: ' + JSON.stringify(r));
  // a run that starts and then fails (401)
  ({ flow } = over((st, extra) => {
    st.fetchStatus = { running: true, chatId: extra.chatId };
    setTimeout(() => { st.fetchStatus = { running: false, chatId: extra.chatId, doneAt: Date.now(), error: 'HTTP 401 on page 1' }; }, 10);
    return { ok: true };
  }));
  r = await flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok && r.warning, 'failed run: ' + JSON.stringify(r));
  // timeout behind a stuck run
  let o;
  o = over(() => ({ ok: true }), { waitMs: 40 });
  o.state.fetchStatus = { running: true, chatId: 'stuck-forever' };
  r = await o.flow.ensureComplete(CHAT_ID);
  assert.ok(r.ok && r.warning, 'timeout: ' + JSON.stringify(r));
  // live < totalCount keeps the error (the file would be incomplete)
  o = makeFlow(() => ({ error: 'No captured messages request found for this chat.' }));
  r = await o.flow.ensureComplete(CHAT_ID);
  assert.ok(!r.ok && !r.warning, 'live below total stays an error');
  // 'all': one warning that names the affected chat; one broken chat does not hide it
  o = over(() => ({ error: 'HTTP 500 on page 1' }));
  r = await o.flow.ensureComplete('all');
  assert.ok(r.ok && /Test Chat/.test(r.warning), 'all: warning names the chat: ' + JSON.stringify(r));
  o = makeFlow(runThatFills);
  r = await o.flow.ensureComplete('all');
  assert.ok(r.ok && !r.warning, 'all: no warning when the reload works');
}

// 5g. the error text names the chat's own site
{
  const { flow, state } = makeFlow(() => ({ error: 'HTTP 500 on page 1' }));
  state.chats[CHAT_ID].site = 'isekaizero';
  const r = await flow.ensureComplete(CHAT_ID);
  assert.ok(!r.ok && /isekaizero tab/.test(r.error), r.error);
}

console.log('PASS flow: filters/summaries/completeness + 7 wait-loop scenarios (happy, adoption, retry, error, timeout, warning on failed reload, site name)');

})().catch((err) => { console.error(err); process.exit(1); });
