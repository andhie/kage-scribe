/*
 * Kage Scribe — shared merge logic.
 * Loaded by the background service worker (importScripts) and by the
 * dashboard panel (<script src>). Attaches plain helpers to the global as
 * KSMerge so it works in the SW, in an extension page and in Node tests.
 */
(function (g) {
  'use strict';

  function tryParse(text) {
    if (typeof text !== 'string' || !text) return null;
    const s = text.trim();
    if (!(s.startsWith('{') || s.startsWith('['))) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /**
   * Pull the messages array out of a messages-API response, tolerating a few
   * envelope shapes: {data:{data:[...]}}, {data:[...]}, {data:{messages:[...]}}, [...]
   */
  function extractMessages(parsed) {
    if (!parsed) return [];
    const d = parsed.data !== undefined ? parsed.data : parsed;
    let arr = null;
    if (Array.isArray(d)) arr = d;
    else if (d && Array.isArray(d.data)) arr = d.data;
    else if (d && Array.isArray(d.messages)) arr = d.messages;
    else if (Array.isArray(parsed)) arr = parsed;
    return (arr || []).filter((m) => m && typeof m === 'object');
  }

  /** The choice the UI currently shows: _selectedChoiceId, else choiceIndex, else first. */
  function selectedChoice(m) {
    const cs = Array.isArray(m.choices) ? m.choices.filter((c) => c && typeof c === 'object') : [];
    if (!cs.length) return null;
    let c = m._selectedChoiceId ? cs.find((x) => x._id === m._selectedChoiceId) : null;
    if (!c && typeof m.choiceIndex === 'number' && cs[m.choiceIndex]) c = cs[m.choiceIndex];
    return c || cs[0];
  }

  function firstUsage(choice) {
    return (choice && Array.isArray(choice.llmUsages) && choice.llmUsages[0]) || null;
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : '';
  }

  /** Flatten one raw message into one exportable row (content included). */
  function messageToRow(m, index, block) {
    const c = selectedChoice(m) || {};
    const u = firstUsage(c);
    const mod = (c && c.moderation) || {};
    let content = '';
    if (typeof c.content === 'string') content = c.content;
    else if (c.content != null) content = JSON.stringify(c.content);
    return {
      index: index == null ? '' : index,
      block: block == null ? '' : block,
      id: m._id || '',
      chatId: m._chatId || '',
      role: m.role || '',
      type: m.type || '',
      characterName: c.characterName || '',
      createdAt: m.createdAt || '',
      content,
      model: (u && ((u.llmSnapshot && u.llmSnapshot.name) || u.model)) || '',
      promptTokens: num(u && u.promptTokens),
      completionTokens: num(u && u.completionTokens),
      totalTokens: num(u && u.totalTokens),
      finishReason: (c && c.finishReason) || (u && u.finishReason) || '',
      totalCost: num(u && u.totalCost),
      genMs: num(c && c.timing && c.timing.totalElapsed),
      moderation: [
        mod.sexual ? 'sexual=' + mod.sexual : '',
        mod.violence ? 'violence=' + mod.violence : '',
        mod.hate ? 'hate=' + mod.hate : ''
      ].filter(Boolean).join('; '),
      deleted: m.deleted === true,
      choiceId: c._id || ''
    };
  }

  /**
   * The message reduced to what the panel reads (filters, table, every export
   * row): the selected choice only, with its first usage trimmed. About a
   * third of the stored size, so the panel's state reply stays small.
   */
  function slimMessage(m) {
    const c = selectedChoice(m);
    const u = firstUsage(c);
    const slimChoice = c && {
      _id: c._id,
      content: c.content,
      characterName: c.characterName,
      finishReason: c.finishReason,
      moderation: c.moderation,
      timing: c.timing && { totalElapsed: c.timing.totalElapsed },
      llmUsages: u ? [{
        model: u.model,
        llmSnapshot: u.llmSnapshot && { name: u.llmSnapshot.name },
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens,
        finishReason: u.finishReason,
        totalCost: u.totalCost
      }] : []
    };
    return {
      _id: m._id,
      _chatId: m._chatId,
      role: m.role,
      type: m.type,
      createdAt: m.createdAt,
      deleted: m.deleted,
      _selectedChoiceId: slimChoice ? slimChoice._id : undefined,
      choices: slimChoice ? [slimChoice] : []
    };
  }

  /** Sort ascending (or descending) by message createdAt; ties broken by _id. */
  function sortMessages(list, dir) {
    const sign = dir === 'desc' ? -1 : 1;
    return list.slice().sort((a, b) => {
      const ka = String(a.createdAt || '');
      const kb = String(b.createdAt || '');
      if (ka !== kb) return ka < kb ? -sign : sign;
      return String(a._id || '') < String(b._id || '') ? -sign : sign;
    });
  }

  /** Ordered export columns: [key, header]. `content` is the chat text. */
  const MERGED_COLUMNS = [
    ['index', '#'],
    ['createdAt', 'Created At'],
    ['role', 'Role'],
    ['characterName', 'Name'],
    ['type', 'Type'],
    ['content', 'Content'],
    ['model', 'Model'],
    ['promptTokens', 'Prompt Tokens'],
    ['completionTokens', 'Completion Tokens'],
    ['totalTokens', 'Total Tokens'],
    ['finishReason', 'Finish Reason'],
    ['totalCost', 'Total Cost'],
    ['genMs', 'Gen Time (ms)'],
    ['moderation', 'Moderation'],
    ['deleted', 'Deleted'],
    ['id', 'Message ID'],
    ['chatId', 'Chat ID'],
    ['choiceId', 'Choice ID'],
    ['block', 'Block (20 msgs)']
  ];

  g.KSMerge = {
    tryParse,
    extractMessages,
    selectedChoice,
    messageToRow,
    slimMessage,
    sortMessages,
    MERGED_COLUMNS
  };
})(typeof self !== 'undefined' ? self : globalThis);
