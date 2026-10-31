/**
 * 任务台账的文本渲染：系统提示段、变动注入、续跑提示。
 *
 * 模型侧文本集中在这里，面板侧文案在 client.js，工具结果在 tools.js 复用本文件。
 *
 * @module dsh-quest-log/render
 */

/** 注入消息的固定前缀，自动捕获据此跳过自己注入的上下文。 */
export const INJECT_MARKER = '[任务台账]';

/** 系统提示段一次最多列出的未完成任务条数。 */
export const MAX_LEDGER_LINES = 20;

/** 单行标题在提示里的长度上限。 */
const LINE_TITLE_CHARS = 160;

/**
 * 标题压成一行。
 * @param {string} title 标题。
 * @returns {string} 单行标题。
 */
function oneLine(title) {
  const text = String(title ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > LINE_TITLE_CHARS ? `${text.slice(0, LINE_TITLE_CHARS)}…` : text;
}

/**
 * 未完成任务的条目行。
 * @param {Array<object>} quests 任务。
 * @param {number} max 最多条数。
 * @returns {string[]} 行。
 */
function itemLines(quests, max) {
  return quests.slice(0, max).map((quest, index) => `${index + 1}. #${quest.id} ${oneLine(quest.title)}`);
}

/**
 * 系统提示里的台账段：只列未完成任务，没有未完成时不出现。
 * @param {Array<object>} quests 该会话的任务（任意顺序）。
 * @param {object} [options] 选项。
 * @param {number} [options.max] 最多条数。
 * @returns {string} 提示文本，空字符串表示不注入。
 */
export function renderLedger(quests, options = {}) {
  const open = Array.isArray(quests) ? quests.filter((quest) => quest.status !== 'done') : [];
  if (open.length === 0) return '';
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : MAX_LEDGER_LINES;
  const lines = itemLines(open, max);
  const more = open.length > lines.length ? `\n…另有 ${open.length - lines.length} 项，用 quest_log_list 查看全部。` : '';
  return [
    '# 任务台账（Quest Log）',
    '下面是用户在本会话任务执行过程中通过插话补充、目前仍未完成的任务。完成一项就调用 `quest_log_update` 把它的 status 设为 done；不要静默跳过它们。',
    ...lines,
    more,
  ].filter((line) => line !== '').join('\n');
}

/**
 * 轮末续跑提示：列出未完成任务，要求继续推进。
 * @param {Array<object>} openQuests 未完成任务。
 * @returns {string} 续跑提示文本。
 */
export function renderContinuePrompt(openQuests) {
  const lines = itemLines(openQuests, MAX_LEDGER_LINES);
  const more = openQuests.length > lines.length ? `\n…另有 ${openQuests.length - lines.length} 项，用 quest_log_list 查看。` : '';
  return [
    `${INJECT_MARKER} 本轮结束，但任务台账里还有 ${openQuests.length} 项未完成任务：`,
    ...lines,
    more,
    '请继续把这些任务做完；每完成一项就调用 quest_log_update（status=done）标记。若某项确实无法继续或缺少信息，请说明原因并保留为未完成。',
  ].filter((line) => line !== '').join('\n');
}

/**
 * 任务变动注入文本（用户/插话造成的变动）。
 * @param {object} change 变更描述。
 * @param {{open: number, done: number}} stats 操作后的统计。
 * @returns {string} 注入文本。
 */
export function renderChangeNote(change, stats) {
  const quest = change?.quest;
  const head = `${INJECT_MARKER} `;
  const tail = `（当前未完成 ${stats.open} 项、已完成 ${stats.done} 项）`;
  if (change?.kind === 'add' && quest !== undefined) {
    return `${head}用户新增了一条任务 #${quest.id}：${oneLine(quest.title)}${tail}。需要时把它纳入当前工作，完成后用 quest_log_update 标记 done。`;
  }
  if (change?.kind === 'update' && quest !== undefined) {
    if (quest.status === 'done') {
      return `${head}任务 #${quest.id} 已被用户标记为完成${tail}。`;
    }
    return `${head}任务 #${quest.id} 已被用户更新：${oneLine(quest.title)}${tail}。`;
  }
  if (change?.kind === 'remove' && quest !== undefined) {
    return `${head}任务 #${quest.id} 已被用户删除：${oneLine(quest.title)}${tail}。不要再去执行它。`;
  }
  if (change?.kind === 'clearDone') {
    return `${head}用户清空了 ${Number(change.removed) || 0} 条已完成任务${tail}。`;
  }
  return '';
}

/**
 * 工具结果里的任务清单。
 * @param {Array<object>} quests 任务。
 * @param {{open: number, done: number}} stats 统计。
 * @returns {string} 清单文本。
 */
export function renderQuestList(quests, stats) {
  if (!Array.isArray(quests) || quests.length === 0) {
    return `任务台账：没有任务（未完成 0 项、已完成 0 项）。`;
  }
  const lines = quests.map((quest) => {
    const box = quest.status === 'done' ? '[x]' : '[ ]';
    const source = quest.source === 'steer' ? '插话' : quest.source === 'agent' ? 'Agent' : '手动';
    const detail = quest.detail ? ` — ${String(quest.detail).replace(/\s+/gu, ' ').slice(0, 200)}` : '';
    return `${box} #${quest.id} ${oneLine(quest.title)}（${source}）${detail}`;
  });
  return [
    `任务台账：未完成 ${stats.open} 项、已完成 ${stats.done} 项。`,
    ...lines,
  ].join('\n');
}
