/**
 * 任务台账的存储层。
 *
 * 每个会话一份 JSON：`<dir>/<sessionId>.json`。进程内缓存一份，写入用
 * 「临时文件 + rename」保证原子性；读盘只发生在第一次访问某个会话时。
 *
 * 结构刻意保持扁平，方便面板、工具、注入三处共用同一份实现：
 * `{ version, sessionId, quests: Quest[] }`。
 *
 * @module dsh-quest-log/store
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 存储结构版本；字段语义变化时 +1（旧文件仍按缺省值读取）。 */
export const STORE_VERSION = 1;

/** 单会话最多保留的任务条数，超出时丢弃最旧的已完成任务，再不行就拒绝新增。 */
export const MAX_QUESTS_PER_SESSION = 200;

/** 标题与说明的字符上限，防止插话长文把台账撑爆。 */
export const MAX_TITLE_CHARS = 400;
export const MAX_DETAIL_CHARS = 4000;

const STATUSES = new Set(['open', 'done']);
const SOURCES = new Set(['user', 'steer', 'agent']);

/**
 * 默认存储目录：`~/.dsh/dsh-quest-log`。
 *
 * 刻意不写进 `~/.dsh/storages/`：那是宿主 storage-json backend 的根，
 * 那里每个 `<name>.json` 都被当作一个 domain unit 文档，插件数据不该混进去。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试注入用）。
 * @returns {string} 目录绝对路径。
 */
export function defaultStoreDir(env = process.env) {
  const explicit = typeof env?.DSH_QUEST_LOG_DIR === 'string' ? env.DSH_QUEST_LOG_DIR.trim() : '';
  if (explicit !== '') return explicit;
  return join(homedir(), '.dsh', 'dsh-quest-log');
}

/**
 * 会话 id → 安全文件名。
 * @param {string} sessionId 会话 id。
 * @returns {string} 可用作文件名的字符串。
 */
export function safeFileName(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '');
  const safe = text.replace(/[^A-Za-z0-9._-]/gu, '_').replace(/^\.+/u, '_');
  return safe === '' ? 'unknown-session' : safe.slice(0, 160);
}

/**
 * 把任意输入收敛成单行文本。
 * @param {unknown} value 原始值。
 * @param {number} max 最大字符数。
 * @returns {string} 收敛后的文本。
 */
export function normalizeText(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const trimmed = text.replace(/\r\n?/gu, '\n').trim();
  return trimmed.slice(0, max);
}

/**
 * 标题从多行文本折叠成一行。
 * @param {string} text 原始文本。
 * @returns {string} 单行标题。
 */
export function titleFromText(text) {
  const collapsed = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return collapsed.slice(0, MAX_TITLE_CHARS);
}

/**
 * 生成任务 id：`q-` + 时间 + 随机短串，便于模型引用与人工辨认。
 * @returns {string} 任务 id。
 */
export function newQuestId() {
  const uuid = randomUUID().replace(/-/gu, '');
  return `q-${uuid.slice(0, 8)}`;
}

/**
 * @typedef {object} Quest
 * @property {string} id 任务 id。
 * @property {string} title 任务标题。
 * @property {string} detail 补充说明。
 * @property {'open'|'done'} status 状态。
 * @property {'user'|'steer'|'agent'} source 来源。
 * @property {number} createdAt 创建时间戳。
 * @property {number} updatedAt 最后更新时间戳。
 * @property {number|null} completedAt 完成时间戳。
 * @property {string|null} sourceMessageId 自动捕获时的原始消息 id。
 */

/**
 * 把磁盘/外界传入的任务对象归一化。
 * @param {unknown} raw 原始对象。
 * @returns {Quest|null} 合法任务，或 null。
 */
export function normalizeQuest(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 80) : newQuestId();
  const title = normalizeText(raw.title, MAX_TITLE_CHARS);
  if (title === '') return null;
  const detail = normalizeText(raw.detail, MAX_DETAIL_CHARS);
  const status = STATUSES.has(raw.status) ? raw.status : 'open';
  const source = SOURCES.has(raw.source) ? raw.source : 'user';
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  const completedAt = Number.isFinite(raw.completedAt) ? Number(raw.completedAt) : status === 'done' ? updatedAt : null;
  const sourceMessageId = typeof raw.sourceMessageId === 'string' && raw.sourceMessageId !== ''
    ? raw.sourceMessageId.slice(0, 120)
    : null;
  return { id, title, detail, status, source, createdAt, updatedAt, completedAt, sourceMessageId };
}

/**
 * 任务排序：未完成在前（旧→新），已完成在后（新→旧）。
 * @param {Quest} a 任务 a。
 * @param {Quest} b 任务 b。
 * @returns {number} 排序值。
 */
export function compareQuests(a, b) {
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  if (a.status === 'done') return (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt);
  return a.createdAt - b.createdAt;
}

/**
 * 任务台账：单进程内的会话级存储。
 */
export class QuestStore {
  /**
   * @param {object} [options] 选项。
   * @param {string} [options.dir] 存储目录。
   * @param {(sessionId: string, change: object) => void} [options.onChange] 变更回调。
   * @param {() => number} [options.now] 时钟（测试注入）。
   * @param {number} [options.maxQuests] 单会话上限。
   */
  constructor(options = {}) {
    this.dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : defaultStoreDir();
    this.onChange = typeof options.onChange === 'function' ? options.onChange : undefined;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxQuests = Number.isInteger(options.maxQuests) && options.maxQuests > 0
      ? options.maxQuests
      : MAX_QUESTS_PER_SESSION;
    /** @type {Map<string, {version: number, sessionId: string, quests: Quest[]}>} */
    this.cache = new Map();
  }

  /**
   * @param {string} sessionId 会话 id。
   * @returns {string} 该会话的存储文件。
   */
  fileFor(sessionId) {
    return join(this.dir, `${safeFileName(sessionId)}.json`);
  }

  /**
   * 读取（必要时从磁盘加载）一个会话的台账。
   * @param {string} sessionId 会话 id。
   * @returns {{version: number, sessionId: string, quests: Quest[]}} 台账。
   */
  stateOf(sessionId) {
    const key = String(sessionId ?? '');
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let state = { version: STORE_VERSION, sessionId: key, quests: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(key), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.quests)) {
        state = {
          version: STORE_VERSION,
          sessionId: key,
          quests: parsed.quests.map(normalizeQuest).filter((quest) => quest !== null),
        };
      }
    } catch {
      /* 文件不存在或损坏：从空台账开始，下一次写入会覆盖 */
    }
    this.cache.set(key, state);
    return state;
  }

  /**
   * 原子落盘。
   * @param {string} sessionId 会话 id。
   * @returns {boolean} 是否写入成功。
   */
  persist(sessionId) {
    const state = this.stateOf(sessionId);
    try {
      mkdirSync(this.dir, { recursive: true });
      const target = this.fileFor(sessionId);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(temp, target);
      return true;
    } catch (error) {
      console.warn('[dsh-quest-log] persist failed:', error?.message ?? error);
      return false;
    }
  }

  /**
   * 触发变更通知（内部使用）。
   * @param {string} sessionId 会话 id。
   * @param {object} change 变更描述。
   * @returns {void}
   */
  emit(sessionId, change) {
    try {
      this.onChange?.(sessionId, change);
    } catch (error) {
      console.warn('[dsh-quest-log] onChange failed:', error?.message ?? error);
    }
  }

  /**
   * 列表。
   * @param {string} sessionId 会话 id。
   * @param {{status?: string}} [options] 过滤。
   * @returns {Quest[]} 排序后的任务（副本）。
   */
  list(sessionId, options = {}) {
    const status = STATUSES.has(options.status) ? options.status : undefined;
    const quests = this.stateOf(sessionId).quests
      .filter((quest) => status === undefined || quest.status === status)
      .slice()
      .sort(compareQuests);
    return quests;
  }

  /**
   * 统计。
   * @param {string} sessionId 会话 id。
   * @returns {{open: number, done: number, total: number}} 统计。
   */
  stats(sessionId) {
    const quests = this.stateOf(sessionId).quests;
    let open = 0;
    let done = 0;
    for (const quest of quests) {
      if (quest.status === 'done') done += 1;
      else open += 1;
    }
    return { open, done, total: quests.length };
  }

  /**
   * 查找一条任务。
   * @param {string} sessionId 会话 id。
   * @param {string} id 任务 id。
   * @returns {Quest|undefined} 任务。
   */
  get(sessionId, id) {
    const wanted = String(id ?? '').trim();
    if (wanted === '') return undefined;
    return this.stateOf(sessionId).quests.find((quest) => quest.id === wanted);
  }

  /**
   * 新增任务。
   * @param {string} sessionId 会话 id。
   * @param {object} input 输入。
   * @param {string} input.title 标题。
   * @param {string} [input.detail] 说明。
   * @param {'user'|'steer'|'agent'} [input.source] 来源。
   * @param {string|null} [input.sourceMessageId] 原始消息 id。
   * @returns {{ok: true, quest: Quest} | {ok: false, error: string}} 结果。
   */
  add(sessionId, input) {
    const title = normalizeText(input?.title, MAX_TITLE_CHARS);
    if (title === '') return { ok: false, error: 'EMPTY_TITLE' };
    const state = this.stateOf(sessionId);
    if (state.quests.length >= this.maxQuests) {
      const oldestDone = state.quests
        .filter((quest) => quest.status === 'done')
        .sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt))[0];
      if (oldestDone !== undefined) {
        state.quests = state.quests.filter((quest) => quest.id !== oldestDone.id);
      } else {
        return { ok: false, error: 'QUOTA_EXCEEDED' };
      }
    }
    const now = this.now();
    const quest = normalizeQuest({
      id: newQuestId(),
      title,
      detail: normalizeText(input?.detail, MAX_DETAIL_CHARS),
      status: 'open',
      source: SOURCES.has(input?.source) ? input.source : 'user',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      sourceMessageId: input?.sourceMessageId ?? null,
    });
    if (quest === null) return { ok: false, error: 'EMPTY_TITLE' };
    state.quests.push(quest);
    this.persist(sessionId);
    this.emit(sessionId, { kind: 'add', actor: quest.source, quest });
    return { ok: true, quest };
  }

  /**
   * 更新任务。
   * @param {string} sessionId 会话 id。
   * @param {string} id 任务 id。
   * @param {object} patch 补丁。
   * @param {string} [patch.title] 新标题。
   * @param {string} [patch.detail] 新说明。
   * @param {'open'|'done'} [patch.status] 新状态。
   * @param {'user'|'agent'|'steer'} [actor] 操作者。
   * @returns {{ok: true, quest: Quest} | {ok: false, error: string}} 结果。
   */
  update(sessionId, id, patch, actor = 'user') {
    const quest = this.get(sessionId, id);
    if (quest === undefined) return { ok: false, error: 'NOT_FOUND' };
    const now = this.now();
    let changed = false;
    if (patch?.title !== undefined) {
      const title = normalizeText(patch.title, MAX_TITLE_CHARS);
      if (title === '') return { ok: false, error: 'EMPTY_TITLE' };
      if (title !== quest.title) {
        quest.title = title;
        changed = true;
      }
    }
    if (patch?.detail !== undefined) {
      const detail = normalizeText(patch.detail, MAX_DETAIL_CHARS);
      if (detail !== quest.detail) {
        quest.detail = detail;
        changed = true;
      }
    }
    if (patch?.status !== undefined) {
      if (!STATUSES.has(patch.status)) return { ok: false, error: 'INVALID_STATUS' };
      if (patch.status !== quest.status) {
        quest.status = patch.status;
        quest.completedAt = patch.status === 'done' ? now : null;
        changed = true;
      }
    }
    if (!changed) return { ok: true, quest };
    quest.updatedAt = now;
    this.persist(sessionId);
    this.emit(sessionId, { kind: 'update', actor, quest });
    return { ok: true, quest };
  }

  /**
   * 删除任务。
   * @param {string} sessionId 会话 id。
   * @param {string} id 任务 id。
   * @param {'user'|'agent'|'steer'} [actor] 操作者。
   * @returns {{ok: true, quest: Quest} | {ok: false, error: string}} 结果。
   */
  remove(sessionId, id, actor = 'user') {
    const quest = this.get(sessionId, id);
    if (quest === undefined) return { ok: false, error: 'NOT_FOUND' };
    const state = this.stateOf(sessionId);
    state.quests = state.quests.filter((item) => item.id !== quest.id);
    this.persist(sessionId);
    this.emit(sessionId, { kind: 'remove', actor, quest });
    return { ok: true, quest };
  }

  /**
   * 清空已完成任务。
   * @param {string} sessionId 会话 id。
   * @param {'user'|'agent'} [actor] 操作者。
   * @returns {{ok: true, removed: number}} 结果。
   */
  clearDone(sessionId, actor = 'user') {
    const state = this.stateOf(sessionId);
    const before = state.quests.length;
    state.quests = state.quests.filter((quest) => quest.status !== 'done');
    const removed = before - state.quests.length;
    if (removed > 0) {
      this.persist(sessionId);
      this.emit(sessionId, { kind: 'clearDone', actor, removed });
    }
    return { ok: true, removed };
  }

  /**
   * 是否已经记录过某条原始消息（自动捕获去重）。
   * @param {string} sessionId 会话 id。
   * @param {string} messageId 消息 id。
   * @returns {boolean} 是否已存在。
   */
  hasSourceMessage(sessionId, messageId) {
    if (typeof messageId !== 'string' || messageId === '') return false;
    return this.stateOf(sessionId).quests.some((quest) => quest.sourceMessageId === messageId);
  }

  /**
   * 从磁盘读一份台账（不进入缓存，供全量统计扫描用）。
   * @param {string} key 文件名（不含 .json）。
   * @returns {{version: number, sessionId: string, quests: Quest[]}|undefined} 台账。
   */
  readStateFile(key) {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.quests)) {
        return {
          version: STORE_VERSION,
          sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : key,
          quests: parsed.quests.map(normalizeQuest).filter((quest) => quest !== null),
        };
      }
    } catch {
      /* 不可读或损坏的文件在总览里直接跳过 */
    }
    return undefined;
  }

  /**
   * 全部会话的任务总览（侧边栏入口用）。
   *
   * 合并内存缓存与磁盘文件：缓存里的会话是当前进程正在改的，优先用缓存；
   * 其它会话从各自的 JSON 文件读，没任务的会话不列出。
   *
   * @returns {{totals: {open: number, done: number, total: number, sessions: number},
   *            sessions: Array<{sessionId: string, open: number, done: number, total: number, updatedAt: number}>}} 总览。
   */
  overview() {
    const keys = new Set(this.cache.keys());
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.endsWith('.json')) keys.add(name.slice(0, -'.json'.length));
      }
    } catch {
      /* 目录还不存在 = 还没有任何台账 */
    }
    const sessions = [];
    const totals = { open: 0, done: 0, total: 0, sessions: 0 };
    for (const key of keys) {
      const state = this.cache.get(key) ?? this.readStateFile(key);
      if (state === undefined) continue;
      let open = 0;
      let done = 0;
      let updatedAt = 0;
      for (const quest of state.quests) {
        if (quest.status === 'done') done += 1;
        else open += 1;
        updatedAt = Math.max(updatedAt, Number(quest.updatedAt) || 0, Number(quest.createdAt) || 0);
      }
      if (open + done === 0) continue;
      sessions.push({ sessionId: state.sessionId, open, done, total: open + done, updatedAt });
      totals.open += open;
      totals.done += done;
      totals.total += open + done;
      totals.sessions += 1;
    }
    sessions.sort((a, b) => (b.open - a.open) || (b.updatedAt - a.updatedAt));
    return { totals, sessions };
  }
}
