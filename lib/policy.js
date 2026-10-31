/**
 * 自动续跑的纯决策逻辑：把「是否该替 Agent 开下一轮」从事件处理里剥出来，
 * 便于离线测试，也便于以后加护栏。
 *
 * 设计参考宿主 dsh-goal-round-driver：等 Agent 真正 idle（一轮已正常关闭）再
 * 用 followup 排下一轮，而不是在 agent/turn-stopping 里 steer（那会同一轮无限
 * 加 step）；同时要求上一轮是 completed、没有别的排队消息、且未达续跑预算。
 *
 * @module dsh-quest-log/policy
 */

/**
 * 判断是否应该自动续跑。
 *
 * @param {object} input 输入。
 * @param {'idle'|'running'|undefined} input.status Agent 当前状态。
 * @param {boolean} input.live Agent 是否仍存活在当前注册表里。
 * @param {boolean} input.stopping 插件是否正在卸载。
 * @param {boolean} input.failed 本轮或上次运行是否失败（agent/error）。
 * @param {string|undefined} input.lastTurnEnd 上一轮 turn/end 的原因 kind。
 * @param {boolean} input.competingQueued 是否有其它来源（用户/其它插件）排队的下一轮消息。
 * @param {number} input.pendingNextTurn Agent inbox 里 next-turn 队列长度。
 * @param {number} input.pendingNextStep Agent inbox 里 next-step 队列长度。
 * @param {number} input.openCount 未完成任务数。
 * @param {number} input.rounds 已经自动续跑的轮数。
 * @param {number} input.maxRounds 续跑上限。
 * @param {boolean} input.enabled 配置里是否开启自动续跑。
 * @returns {{continue: boolean, reason: string}} 决策与原因（原因用于日志/测试）。
 */
export function shouldAutoContinue(input) {
  const state = input ?? {};
  if (state.enabled !== true) return { continue: false, reason: 'disabled' };
  if (state.stopping === true) return { continue: false, reason: 'unloading' };
  if (state.live !== true) return { continue: false, reason: 'not-live' };
  if (state.status !== 'idle') return { continue: false, reason: 'not-idle' };
  if (state.failed === true) return { continue: false, reason: 'failed' };
  if (state.competingQueued === true) return { continue: false, reason: 'competing-input' };
  if (state.lastTurnEnd !== 'completed') return { continue: false, reason: 'turn-not-completed' };
  if (Number(state.pendingNextTurn) > 0) return { continue: false, reason: 'next-turn-pending' };
  if (Number(state.pendingNextStep) > 0) return { continue: false, reason: 'next-step-pending' };
  if (Number(state.openCount) <= 0) return { continue: false, reason: 'nothing-open' };
  const rounds = Number.isFinite(state.rounds) ? state.rounds : 0;
  const maxRounds = Number.isFinite(state.maxRounds) ? state.maxRounds : 0;
  if (rounds >= maxRounds) return { continue: false, reason: 'round-limit' };
  return { continue: true, reason: 'open-quests' };
}

/**
 * 是否应该把「任务变动」注入给正在运行的 Agent。
 *
 * @param {object} input 输入。
 * @param {boolean} input.enabled 配置开关。
 * @param {string} input.actor 变动来源（user/steer/agent）。
 * @param {boolean} input.live Agent 是否存活。
 * @param {'idle'|'running'|undefined} input.status Agent 状态。
 * @returns {boolean} 是否注入。
 */
export function shouldInjectChange(input) {
  const state = input ?? {};
  if (state.enabled !== true) return false;
  if (state.actor !== 'user') return false;
  if (state.live !== true) return false;
  return state.status === 'running';
}
