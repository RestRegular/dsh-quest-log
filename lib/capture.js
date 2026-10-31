/**
 * 插话捕获：把「用户以插话方式塞进当前一轮」的额外任务记进台账。
 *
 * 判据来自宿主会话日志：`agent/inbox/spliced` 且 `target === 'next-step'`
 * 就是插话（排队是 `'next-turn'`）。客户端 UI 上的 steering 只是本地乐观
 * 回显，不是日志标记。
 *
 * 纯函数形式，便于拿假的 session/event 做离线测试。
 *
 * @module dsh-quest-log/capture
 */

import { INJECT_MARKER } from './render.js';

/** 自动捕获标题的字符上限。 */
const MAX_CAPTURE_TITLE = 400;

/** 自动捕获说明的字符上限。 */
const MAX_CAPTURE_DETAIL = 4000;

/**
 * 会话是否是用户可见的顶层会话（子 Agent 不捕获，避免把父 Agent 的指令当任务）。
 * @param {object} session 会话对象。
 * @returns {boolean} 是否顶层会话。
 */
export function isTopLevelSession(session) {
  try {
    const header = session?.header;
    if (header === undefined || header === null) return true;
    if (header.origin === 'subagent') return false;
    return (Number(header.delegationDepth) || 0) === 0;
  } catch {
    return false;
  }
}

/**
 * 取消息里的文本（只读 text 块，图片/附件用占位符）。
 * @param {object} message UserMessage。
 * @returns {string} 文本。
 */
export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
    else if (block.type === 'file') parts.push('[附件]');
  }
  return parts.join('\n').trim();
}

/**
 * 消息是否是本插件自己注入的上下文。
 * @param {object} message UserMessage。
 * @param {string} text 已取出的文本。
 * @returns {boolean} 是否本插件注入。
 */
export function isPluginMessage(message, text) {
  const kind = message?.source?.kind;
  if (typeof kind === 'string' && kind.startsWith('quest-log')) return true;
  return text.startsWith(INJECT_MARKER);
}

/**
 * 从一次插话消息派生任务标题与说明。
 * @param {string} text 消息文本。
 * @returns {{title: string, detail: string}|null} 派生结果；无文本时 null。
 */
export function deriveQuestText(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  const firstLine = trimmed.split('\n').find((line) => line.trim() !== '') ?? trimmed;
  const title = firstLine.trim().slice(0, MAX_CAPTURE_TITLE);
  if (title === '') return null;
  const detail = trimmed.length > title.length ? trimmed.slice(0, MAX_CAPTURE_DETAIL) : '';
  return { title, detail };
}

/**
 * 处理一条会话事件，必要时把插话记进台账。
 *
 * @param {import('./store.js').QuestStore} store 台账存储。
 * @param {object} session 发生事件的会话。
 * @param {object} event 会话事件。
 * @returns {Array<object>} 本次新增的任务。
 */
export function captureSteering(store, session, event) {
  if (event?.type !== 'agent/inbox/spliced') return [];
  const data = event.data;
  if (data?.target !== 'next-step' || !Array.isArray(data.inserted) || data.inserted.length === 0) return [];
  if (!isTopLevelSession(session)) return [];
  const sessionId = (() => {
    try {
      return typeof session?.header?.id === 'string' ? session.header.id : undefined;
    } catch {
      return undefined;
    }
  })();
  if (sessionId === undefined || sessionId === '') return [];

  const added = [];
  for (const message of data.inserted) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    if (message.source?.kind !== 'user') continue;
    const text = textOfMessage(message);
    if (text === '' || isPluginMessage(message, text)) continue;
    const messageId = typeof message.id === 'string' && message.id !== '' ? message.id : null;
    if (messageId !== null && store.hasSourceMessage(sessionId, messageId)) continue;
    const derived = deriveQuestText(text);
    if (derived === null) continue;
    const result = store.add(sessionId, {
      title: derived.title,
      detail: derived.detail,
      source: 'steer',
      sourceMessageId: messageId,
    });
    if (result.ok) added.push(result.quest);
  }
  return added;
}
