/**
 * Agent 侧工具：任务台账的增删改查。
 *
 * 工具只负责参数校验与文本渲染，真正的存储操作由 index.js 传入的 `ops` 完成，
 * 与面板共用同一条实现路径（参考 harness 的「一个操作、两个调用方」约定）。
 *
 * @module dsh-quest-log/tools
 */

import { renderQuestList } from './render.js';

/** 工具名前缀，方便与其它插件区分。 */
export const TOOL_NAMES = {
  list: 'quest_log_list',
  add: 'quest_log_add',
  update: 'quest_log_update',
  remove: 'quest_log_remove',
};

/** 单次工具结果里最多列出的任务条数。 */
const MAX_LIST_ROWS = 100;

/**
 * 从宿主工具执行上下文取会话 id。
 * @param {object} exec 宿主 execute 的第二参数。
 * @returns {string|undefined} 会话 id。
 */
export function sessionIdOf(exec) {
  try {
    const agent = exec?.agent;
    const session = agent?.session;
    const id = session?.header?.id ?? session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 统一包装会话缺失的错误文本。
 * @returns {string} 错误文本。
 */
function noSession() {
  return '任务台账操作失败：当前工具调用没有关联会话，无法读写台账。';
}

/**
 * 把存储错误码翻译成模型能理解的说明。
 * @param {string} code 错误码。
 * @returns {string} 说明。
 */
function explainError(code) {
  if (code === 'NOT_FOUND') return '没有找到这条任务：id 不存在或已被删除。';
  if (code === 'EMPTY_TITLE') return '任务标题不能为空。';
  if (code === 'INVALID_STATUS') return '状态只能是 open 或 done。';
  if (code === 'QUOTA_EXCEEDED') return '该会话的任务太多（单会话上限），请先清理已完成任务。';
  return `未知错误（${code}）。`;
}

/**
 * 创建四个工具的 ToolDefinition 列表。
 * @param {(definition: object) => object} defineTool 宿主的工具 DSL。
 * @param {object} ops 存储操作集合。
 * @param {(sessionId: string, status?: string) => Array<object>} ops.list 列任务。
 * @param {(sessionId: string, stats: object) => object} ops.stats 统计。
 * @param {(sessionId: string, input: object) => object} ops.add 新增。
 * @param {(sessionId: string, id: string, patch: object, actor: string) => object} ops.update 更新。
 * @param {(sessionId: string, id: string, actor: string) => object} ops.remove 删除。
 * @returns {Array<object>} 工具定义。
 */
export function createQuestTools(defineTool, ops) {
  if (typeof defineTool !== 'function') throw new TypeError('createQuestTools requires defineTool');
  const text = (value) => [{ type: 'text', text: value }];

  const listTool = defineTool({
    name: TOOL_NAMES.list,
    description: [
      '查看当前会话的任务台账（Quest Log）：用户在任务执行过程中通过插话补充的额外任务。',
      '返回未完成/已完成任务及其 id；完成或修改任务前先用它确认真实 id。',
    ].join(''),
    parameters: {
      status: {
        type: 'string',
        description: '过滤：open 只看未完成，done 只看已完成，all 或省略看全部（默认 all）。',
        enum: ['all', 'open', 'done'],
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    timeoutMs: 15_000,
    async execute(args = {}, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return noSession();
      const status = args.status === 'open' || args.status === 'done' ? args.status : undefined;
      const quests = ops.list(sessionId, status);
      const stats = ops.stats(sessionId);
      return renderQuestList(quests.slice(0, MAX_LIST_ROWS), stats);
    },
  });

  const addTool = defineTool({
    name: TOOL_NAMES.add,
    description: [
      '往当前会话的任务台账添加一条任务。',
      '当用户通过插话/补充要求塞进来一个当前主任务之外的额外任务时，用它记录下来，避免后续遗忘。',
      '如果同一条任务来自插话，台账已自动记录过时不要重复添加。',
    ].join(''),
    parameters: {
      title: { type: 'string', required: true, description: '一句话任务标题（必填）。' },
      detail: { type: 'string', description: '补充说明：验收标准、注意点、相关文件等（可选）。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args = {}, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return noSession();
      const result = ops.add(sessionId, { title: args.title, detail: args.detail, source: 'agent' });
      if (!result.ok) return `添加任务失败：${explainError(result.error)}`;
      return `已添加任务 #${result.quest.id}：${result.quest.title}`;
    },
  });

  const updateTool = defineTool({
    name: TOOL_NAMES.update,
    description: [
      '更新当前会话任务台账里的一条任务：改标题/说明，或把 status 设为 done 标记完成。',
      '完成一项未完成任务时必须调用它并传 status=done，否则轮末检查会认为任务仍未完成。',
    ].join(''),
    parameters: {
      id: { type: 'string', required: true, description: '任务 id，例如 q-1a2b3c4d（用 quest_log_list 查询）。' },
      title: { type: 'string', description: '新的任务标题（可选）。' },
      detail: { type: 'string', description: '新的补充说明（可选）。' },
      status: { type: 'string', enum: ['open', 'done'], description: '新状态：done 表示完成，open 表示重新打开。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args = {}, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return noSession();
      const patch = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.detail !== undefined) patch.detail = args.detail;
      if (args.status !== undefined) patch.status = args.status;
      const result = ops.update(sessionId, args.id, patch, 'agent');
      if (!result.ok) return `更新任务失败：${explainError(result.error)}`;
      const state = result.quest.status === 'done' ? '已完成' : '未完成';
      return `已更新任务 #${result.quest.id}（${state}）：${result.quest.title}`;
    },
  });

  const removeTool = defineTool({
    name: TOOL_NAMES.remove,
    description: [
      '删除当前会话任务台账里的一条任务。',
      '只在任务被用户取消或确认不再需要时使用；正常完成请用 quest_log_update 标记 done，保留记录。',
    ].join(''),
    parameters: {
      id: { type: 'string', required: true, description: '任务 id（用 quest_log_list 查询）。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args = {}, exec) {
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return noSession();
      const result = ops.remove(sessionId, args.id, 'agent');
      if (!result.ok) return `删除任务失败：${explainError(result.error)}`;
      return `已删除任务 #${result.quest.id}：${result.quest.title}`;
    },
  });

  return [listTool, addTool, updateTool, removeTool];
}
