/**
 * dsh-quest-log — Host half.
 *
 * 「任务台账」：按会话记录用户在 Agent 执行任务期间通过「插话发送」塞进来的
 * 额外任务，并让 Agent 一直记得它们。
 *
 * 组成：
 *   1. QuestStore：按会话落盘的台账（~/.dsh/dsh-quest-log/<session>.json）；
 *   2. 回环 HTTP 路由 /dsh-quest-log/api：供侧边栏面板增删改查；
 *   3. Agent 工具 quest_log_list/add/update/remove：与面板共用同一套操作；
 *   4. 运行时上下文（systemPrompt.context）：把当前未完成任务挂进每一步；
 *   5. 变动注入：面板改动时用 agent.inject() 把变动上下文送进正在运行的一步；
 *   6. 轮末检查：Agent 真正 idle 后若仍有未完成任务，用 agent.followup() 开下一轮。
 *
 * 注意两件事（宿主源码验证过）：
 *   - 发给 Agent 的消息必须是完整 UserMessage，用 createUserMessage() 造；
 *     手搓 {content, source} 会缺 role，永久毒化该会话（422 missing field role）。
 *   - 不要在 agent/turn-stopping 里 steer/inject：那会在同一 turn 里无限加 step。
 *     宿主自己的「自动开新一轮」也是等 idle 后再 followup（dsh-goal-round-driver）。
 *
 * @module dsh-quest-log
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { QuestStore, defaultStoreDir } from './lib/store.js';
import { createQuestTools } from './lib/tools.js';
import { mountRoutes } from './lib/routes.js';
import { captureSteering, isTopLevelSession } from './lib/capture.js';
import { shouldAutoContinue, shouldInjectChange } from './lib/policy.js';
import { renderChangeNote, renderContinuePrompt, renderLedger } from './lib/render.js';

/** 本插件消息的 source.kind 前缀，用于识别自己注入/续跑的消息。 */
const PLUGIN_SOURCE = 'quest-log';

const field = (type, description, extra = {}) => ({
  type,
  meta: { volatile: true, description },
  ...extra,
});

const CONFIG_FIELDS = {
  captureSteering: field(
    'boolean',
    '把用户插话（steering）发来的消息自动记进当前会话的任务台账。',
  ),
  injectChanges: field(
    'boolean',
    '面板上的任务变动发生时，把变动上下文注入正在运行的 Agent（空闲 Agent 等下一轮的系统上下文）。',
  ),
  promptLedger: field(
    'boolean',
    '把当前会话未完成的任务清单作为运行时上下文挂进每一步，让 Agent 一直看得到。',
  ),
  autoContinue: field(
    'boolean',
    '每轮结束检查：仍有未完成任务时，等 Agent 空闲后自动开下一轮继续。',
  ),
  maxAutoRounds: field(
    'integer',
    '同一会话连续自动续跑的最大轮数（0 表示不续跑），防止 Agent 卡在无法完成的任务上死循环。',
    { min: 0, max: 50 },
  ),
  storeDir: field(
    'string',
    '任务台账的存储目录；留空表示 <用户目录>/.dsh/dsh-quest-log。',
  ),
};

const DEFAULTS = {
  captureSteering: true,
  injectChanges: true,
  promptLedger: true,
  autoContinue: true,
  maxAutoRounds: 3,
  storeDir: '',
};

/**
 * 把行配置补齐成完整设置。
 * @param {unknown} raw 行配置。
 * @returns {typeof DEFAULTS} 完整设置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const integer = (value, fallback, min, max) => {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  };
  return {
    captureSteering: bool(source.captureSteering, DEFAULTS.captureSteering),
    injectChanges: bool(source.injectChanges, DEFAULTS.injectChanges),
    promptLedger: bool(source.promptLedger, DEFAULTS.promptLedger),
    autoContinue: bool(source.autoContinue, DEFAULTS.autoContinue),
    maxAutoRounds: integer(source.maxAutoRounds, DEFAULTS.maxAutoRounds, 0, 50),
    storeDir: typeof source.storeDir === 'string' ? source.storeDir.trim() : DEFAULTS.storeDir,
  };
}

function descriptor(node) {
  // settings.describe 会读取每个节点的 schema.meta.volatile，根节点缺少 meta
  // 会让桌面欢迎页的 settings 请求直接抛错；因此所有节点都要带 meta。
  const result = {
    ...node,
    meta: { ...(node.meta ?? {}) },
    toJSON() {
      return JSON.parse(JSON.stringify({ ...this, toJSON: undefined }));
    },
  };
  if (node.dict !== undefined) {
    result.dict = Object.fromEntries(
      Object.entries(node.dict).map(([key, child]) => [key, descriptor(child)]),
    );
  }
  return result;
}

export const Config = Object.assign(descriptor({ type: 'object', dict: CONFIG_FIELDS }), {
  '~standard': {
    version: 1,
    vendor: 'dsh-quest-log',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
});

/**
 * 从 Agent 取会话 id（`sessionId === agent.id === agent.session.id`）。
 * @param {object} agent Agent。
 * @returns {string|undefined} 会话 id。
 */
export function sessionIdOfAgent(agent) {
  try {
    const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取宿主 agents 服务。
 * @param {object} ctx 上下文。
 * @returns {object|undefined} agents 服务。
 */
function agentsOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取宿主 sessions 服务（用于 followup 前的 durability checkpoint）。
 * @param {object} ctx 上下文。
 * @returns {object|undefined} sessions 服务。
 */
function sessionsOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发一条完整 UserMessage。
 * @param {{content: Array<object>, source: object}} input 消息内容。
 * @returns {object} 不可变的 UserMessage。
 */
function userMessage(input) {
  return createUserMessage(input);
}

/**
 * 插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx Host 上下文。
 * @param {unknown} [rawConfig] 行配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger;
  /** 每个会话的自动续跑状态（rounds / 上一轮结果 / 竞争输入）。 */
  const states = new Map();
  let stopping = false;

  const store = new QuestStore({
    dir: config.storeDir === '' ? defaultStoreDir() : config.storeDir,
    onChange(sessionId, change) {
      // 只把「用户侧」的变动注入会话：Agent 自己的工具调用不需要回声，
      // 插话捕获本身也已经出现在对话里；空闲 Agent 看下一步的运行时上下文即可。
      const actor = change?.actor;
      const agent = agentsOf(ctx)?.get?.(sessionId);
      const inject = shouldInjectChange({
        enabled: config.injectChanges,
        actor,
        live: agent !== undefined,
        status: agent?.status,
      });
      if (!inject) return;
      try {
        agent.inject(userMessage({
          content: [{ type: 'text', text: renderChangeNote(change, store.stats(sessionId)) }],
          source: { kind: PLUGIN_SOURCE },
        }));
      } catch (error) {
        logger?.warn?.(`[dsh-quest-log] change injection failed: ${error?.message ?? error}`);
      }
    },
  });

  const ops = {
    list: (sessionId, status) => store.list(sessionId, status === undefined ? {} : { status }),
    stats: (sessionId) => store.stats(sessionId),
    add: (sessionId, input) => store.add(sessionId, input),
    update: (sessionId, id, patch, actor) => store.update(sessionId, id, patch, actor),
    remove: (sessionId, id, actor) => store.remove(sessionId, id, actor),
  };

  // ------------------------------------------------------------------
  // 自动续跑状态机
  // ------------------------------------------------------------------

  /**
   * 取（或创建）会话状态。
   * @param {string} sessionId 会话 id。
   * @returns {object} 状态。
   */
  function stateFor(sessionId) {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        sessionId,
        agent: undefined,
        rounds: 0,
        lastTurnEnd: undefined,
        competingQueued: false,
        failed: false,
        run: undefined,
        requested: false,
      };
      states.set(sessionId, state);
    }
    return state;
  }

  /**
   * 汇总一次续跑决策所需的输入。
   * @param {object} state 会话状态。
   * @returns {object} 决策输入。
   */
  function decisionInput(state) {
    const agents = agentsOf(ctx);
    const agent = agents?.get?.(state.sessionId);
    return {
      enabled: config.autoContinue && config.maxAutoRounds > 0,
      stopping,
      live: agent !== undefined && agent === state.agent,
      status: agent?.status,
      failed: state.failed,
      lastTurnEnd: state.lastTurnEnd,
      competingQueued: state.competingQueued,
      pendingNextTurn: Array.isArray(agent?.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0,
      pendingNextStep: Array.isArray(agent?.inbox?.nextStep) ? agent.inbox.nextStep.length : 0,
      openCount: store.stats(state.sessionId).open,
      rounds: state.rounds,
      maxRounds: config.maxAutoRounds,
      agent,
    };
  }

  /**
   * 真正执行一次续跑检查。
   * @param {object} state 会话状态。
   * @returns {Promise<void>}
   */
  async function drive(state) {
    const first = decisionInput(state);
    const decision = shouldAutoContinue(first);
    if (!decision.continue) {
      if (decision.reason === 'nothing-open') state.rounds = 0;
      return;
    }
    const agent = first.agent;
    // followup 之前先把会话日志刷到持久层（宿主 goal-round-driver 同款做法）。
    try {
      const sessions = sessionsOf(ctx);
      if (typeof sessions?.flush === 'function') await sessions.flush(agent.session);
    } catch (error) {
      logger?.warn?.(`[dsh-quest-log] durability checkpoint failed: ${error?.message ?? error}`);
    }
    // await 之后状态可能已变（用户插话、Agent 取消、插件卸载），重新判定。
    const second = decisionInput(state);
    const again = shouldAutoContinue(second);
    if (!again.continue) return;
    const open = store.list(state.sessionId, { status: 'open' });
    const round = state.rounds + 1;
    state.rounds = round;
    state.lastTurnEnd = undefined;
    try {
      agent.followup(userMessage({
        content: [{ type: 'text', text: renderContinuePrompt(open) }],
        source: { kind: PLUGIN_SOURCE, round },
      }));
      logger?.info?.(`[dsh-quest-log] auto-continue round ${round}/${config.maxAutoRounds} for ${state.sessionId} (${open.length} open)`);
    } catch (error) {
      state.rounds = round - 1;
      logger?.warn?.(`[dsh-quest-log] auto-continue failed: ${error?.message ?? error}`);
    }
  }

  /**
   * 合并触发：同一会话同一时刻只跑一个 driver。
   * @param {object} state 会话状态。
   * @param {object} [agent] 触发时的 Agent。
   * @returns {void}
   */
  function requestDrive(state, agent) {
    if (stopping || state.stopping === true) return;
    if (agent !== undefined) state.agent = agent;
    state.requested = true;
    if (state.run !== undefined) return;
    const loop = async () => {
      while (state.requested && !stopping && state.stopping !== true) {
        state.requested = false;
        try {
          await drive(state);
        } catch (error) {
          logger?.warn?.(`[dsh-quest-log] driver error: ${error?.message ?? error}`);
        }
      }
    };
    let run;
    try {
      const agents = agentsOf(ctx);
      run = typeof agents?.withoutInitiator === 'function'
        ? agents.withoutInitiator(loop)
        : loop();
    } catch (error) {
      logger?.warn?.(`[dsh-quest-log] driver start failed: ${error?.message ?? error}`);
      return;
    }
    state.run = run;
    const retire = () => {
      state.run = undefined;
      if (state.requested && !stopping && state.stopping !== true) requestDrive(state);
    };
    Promise.resolve(run).then(retire, retire);
  }

  // ------------------------------------------------------------------
  // 1. 面板 API
  // ------------------------------------------------------------------
  ctx.inject(['webServer'], (scoped) => {
    mountRoutes(scoped, { store, logger });
  });

  // ------------------------------------------------------------------
  // 2. Agent 工具（全局注册，数据按 sessionId 隔离）
  // ------------------------------------------------------------------
  ctx.inject(['tools'], (scoped) => {
    try {
      const definitions = createQuestTools(defineTool, ops);
      for (const definition of definitions) {
        scoped.effect(() => scoped.tools.register(definition), `dsh-quest-log: ${definition.name} tool`);
      }
    } catch (error) {
      logger?.warn?.(`[dsh-quest-log] tools registration failed: ${error?.message ?? error}`);
    }
  });

  // ------------------------------------------------------------------
  // 3. 运行时上下文：未完成任务清单（原地替换，不涨历史）
  // ------------------------------------------------------------------
  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = scoped.systemPrompt;
    if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return;
    try {
      scoped.effect(() => systemPrompt.context({
        name: 'quest-log:ledger',
        order: 300,
        interpolate: false,
        text: (context) => {
          if (!config.promptLedger) return '';
          const sessionId = sessionIdOfAgent(context?.agent);
          if (sessionId === undefined) return '';
          return renderLedger(store.list(sessionId));
        },
      }), 'dsh-quest-log: ledger context');
    } catch (error) {
      logger?.warn?.(`[dsh-quest-log] prompt context registration failed: ${error?.message ?? error}`);
    }
  });

  // ------------------------------------------------------------------
  // 4. 事件接线：插话捕获、轮末检查、状态维护
  // ------------------------------------------------------------------
  ctx.effect(() => {
    const disposers = [];
    const on = (name, listener) => {
      try {
        const disposer = ctx.on(name, listener);
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        logger?.warn?.(`[dsh-quest-log] could not listen to ${name}: ${error?.message ?? error}`);
      }
    };

    /** 会话事件：插话捕获、turn/end 结果、用户新输入。 */
    on('session/event', (session, event) => {
      const sessionId = (() => {
        try {
          return typeof session?.header?.id === 'string' ? session.header.id : undefined;
        } catch {
          return undefined;
        }
      })();
      if (sessionId === undefined || sessionId === '') return;

      if (event?.type === 'turn/end') {
        stateFor(sessionId).lastTurnEnd = event.data?.reason?.kind;
        return;
      }
      if (event?.type === 'user/message') {
        if (event.data?.source?.kind === 'user') {
          const state = stateFor(sessionId);
          state.rounds = 0;
          state.failed = false;
        }
        return;
      }
      if (event?.type === 'agent/inbox/spliced') {
        if (!config.captureSteering) return;
        try {
          captureSteering(store, session, event);
        } catch (error) {
          logger?.warn?.(`[dsh-quest-log] steering capture failed: ${error?.message ?? error}`);
        }
      }
    });

    /** Agent 状态：idle 时检查是否需要自动续跑。 */
    on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return;
      const agent = payload.agent;
      const sessionId = sessionIdOfAgent(agent);
      if (sessionId === undefined) return;
      const state = stateFor(sessionId);
      state.agent = agent;
      state.competingQueued = false;
      if (!isTopLevelSession(agent?.session)) return;
      requestDrive(state, agent);
    });

    /** 一次运行失败后不再自动续跑，等用户发新消息再恢复。 */
    on('agent/error', (payload) => {
      const sessionId = sessionIdOfAgent(payload?.agent);
      if (sessionId === undefined) return;
      stateFor(sessionId).failed = true;
    });

    on('agent/disposed', (payload) => {
      const sessionId = sessionIdOfAgent(payload?.agent);
      if (sessionId === undefined) return;
      const state = states.get(sessionId);
      if (state !== undefined) {
        state.stopping = true;
        states.delete(sessionId);
      }
    });

    /** 别人往 next-turn 排了消息（用户的排队输入等）→ 不插队。 */
    on('agent/inbox/inserted', (payload) => {
      const message = payload?.message;
      const agent = payload?.agent;
      const sessionId = sessionIdOfAgent(agent);
      if (sessionId === undefined) return;
      const state = stateFor(sessionId);
      state.agent = agent;
      if (message?.source?.kind === PLUGIN_SOURCE) return;
      if (message?.source?.kind === 'user') {
        state.rounds = 0;
        state.failed = false;
      }
      try {
        const queued = Array.isArray(agent?.inbox?.nextTurn)
          && agent.inbox.nextTurn.some((candidate) => candidate?.id === message?.id);
        if (queued) state.competingQueued = true;
      } catch {
        /* inbox 投影不可用时忽略 */
      }
    });

    return () => {
      stopping = true;
      for (const state of states.values()) state.stopping = true;
      states.clear();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 忽略重复释放 */
        }
      }
    };
  }, 'dsh-quest-log: lifecycle');
}
