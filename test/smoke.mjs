/**
 * 离线冒烟测试：不加载 DSH 宿主，只测纯逻辑（存储 / 渲染 / 面板 API 操作）。
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QuestStore, normalizeQuest, safeFileName, titleFromText } from '../lib/store.js';
import { renderChangeNote, renderContinuePrompt, renderLedger, renderQuestList, INJECT_MARKER } from '../lib/render.js';
import { createOperations, isLoopback } from '../lib/routes.js';
import { captureSteering } from '../lib/capture.js';
import { shouldAutoContinue, shouldInjectChange } from '../lib/policy.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-quest-log-test-'));
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL ${name}\n`);
    throw error;
  }
}

try {
  test('safeFileName 收敛非法字符', () => {
    assert.equal(safeFileName('session-abc/../x'), 'session-abc_.._x');
    assert.equal(safeFileName(''), 'unknown-session');
  });

  test('normalizeQuest 拒绝空标题并补齐字段', () => {
    assert.equal(normalizeQuest({ title: '   ' }), null);
    const quest = normalizeQuest({ id: 'q-1', title: '写测试', status: 'done', createdAt: 10, updatedAt: 20 });
    assert.equal(quest.status, 'done');
    assert.equal(quest.completedAt, 20);
    assert.equal(quest.source, 'user');
  });

  test('titleFromText 折叠成一行', () => {
    assert.equal(titleFromText('第一行\n第二行'), '第一行 第二行');
  });

  const changes = [];
  const store = new QuestStore({ dir, now: () => 1000, onChange: (sessionId, change) => changes.push([sessionId, change]) });
  const sessionId = 'session-1';

  test('store 增删改查 + 落盘', () => {
    const added = store.add(sessionId, { title: '补 README', source: 'steer', sourceMessageId: 'm-1' });
    assert.equal(added.ok, true);
    assert.equal(added.quest.title, '补 README');
    assert.equal(store.stats(sessionId).open, 1);
    assert.equal(store.hasSourceMessage(sessionId, 'm-1'), true);

    const done = store.update(sessionId, added.quest.id, { status: 'done' }, 'agent');
    assert.equal(done.ok, true);
    assert.equal(done.quest.status, 'done');
    assert.equal(store.stats(sessionId).done, 1);

    const file = JSON.parse(readFileSync(store.fileFor(sessionId), 'utf8'));
    assert.equal(file.quests.length, 1);
    assert.equal(file.quests[0].status, 'done');

    const removed = store.remove(sessionId, added.quest.id, 'user');
    assert.equal(removed.ok, true);
    assert.equal(store.stats(sessionId).total, 0);
    assert.equal(changes.length, 3);
  });

  test('store 按未完成优先排序', () => {
    const before = store.list(sessionId).map((quest) => quest.id);
    const open = store.add(sessionId, { title: 'A' }).quest;
    const older = store.add(sessionId, { title: 'B' }).quest;
    store.update(sessionId, older.id, { status: 'done' }, 'user');
    const list = store.list(sessionId);
    assert.equal(list[0].id, open.id);
    assert.equal(list[1].id, older.id);
    assert.notDeepEqual(before, list.map((quest) => quest.id));
  });

  test('store 单会话配额只淘汰最旧的已完成任务', () => {
    const small = new QuestStore({ dir: join(dir, 'quota'), maxQuests: 2, now: () => 2000 });
    const a = small.add(sessionId, { title: 'A' }).quest;
    small.update(sessionId, a.id, { status: 'done' }, 'user');
    small.add(sessionId, { title: 'B' });
    const third = small.add(sessionId, { title: 'C' });
    assert.equal(third.ok, true);
    assert.equal(small.stats(sessionId).total, 2);
    assert.equal(small.get(sessionId, a.id), undefined);
  });

  test('renderLedger 只列未完成并带注释', () => {
    const fresh = new QuestStore({ dir: join(dir, 'render'), now: () => 3000 });
    const id = 'session-render';
    assert.equal(renderLedger(fresh.list(id)), '');
    const quest = fresh.add(id, { title: '跑一遍测试', detail: '包含 UI' }).quest;
    const text = renderLedger(fresh.list(id));
    assert.ok(text.includes('# 任务台账（Quest Log）'));
    assert.ok(text.includes(`#${quest.id} 跑一遍测试`));
    fresh.update(id, quest.id, { status: 'done' }, 'user');
    assert.equal(renderLedger(fresh.list(id)), '');
  });

  test('renderContinuePrompt 带标记与任务行', () => {
    const text = renderContinuePrompt([{ id: 'q-1', title: '继续 A' }, { id: 'q-2', title: '继续 B' }]);
    assert.ok(text.startsWith(INJECT_MARKER));
    assert.ok(text.includes('#q-1 继续 A'));
    assert.ok(text.includes('#q-2 继续 B'));
  });

  test('renderChangeNote 区分操作类型', () => {
    assert.ok(renderChangeNote({ kind: 'add', quest: { id: 'q-1', title: 'X' } }, { open: 1, done: 0 }).includes('新增'));
    assert.ok(renderChangeNote({ kind: 'remove', quest: { id: 'q-1', title: 'X' } }, { open: 0, done: 0 }).includes('删除'));
    assert.ok(renderChangeNote({ kind: 'update', quest: { id: 'q-1', title: 'X', status: 'done' } }, { open: 0, done: 1 }).includes('完成'));
    assert.equal(renderChangeNote({ kind: 'unknown' }, { open: 0, done: 0 }), '');
  });

  test('renderQuestList 空/非空', () => {
    assert.ok(renderQuestList([], { open: 0, done: 0 }).includes('没有任务'));
    assert.ok(renderQuestList([{ id: 'q-1', title: 'X', status: 'open', source: 'steer' }], { open: 1, done: 0 }).includes('[ ] #q-1 X（插话）'));
  });

  test('面板 API 操作与工具共用存储', () => {
    const apiStore = new QuestStore({ dir: join(dir, 'api'), now: () => 4000 });
    const ops = createOperations(apiStore);
    const added = ops.add({ sessionId, title: '面板任务' });
    assert.equal(added.ok, true);
    const listed = ops.list({ sessionId });
    assert.equal(listed.quests.length, 1);
    const updated = ops.update({ sessionId, id: added.quest.id, status: 'done' });
    assert.equal(updated.ok, true);
    assert.equal(ops.clearDone({ sessionId }).removed, 1);
    assert.equal(ops.list({ sessionId }).quests.length, 0);
    assert.equal(ops.add({ sessionId, title: '' }).ok, false);
    assert.equal(ops.list({}).ok, false);
  });

  test('isLoopback 仅接受本机地址', () => {
    assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
    assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.2' } }), false);
    assert.equal(isLoopback({}), false);
  });

  test('captureSteering 只捕获 next-step 的用户消息', () => {
    const captureStore = new QuestStore({ dir: join(dir, 'capture'), now: () => 5000 });
    const session = { header: { id: 'session-capture' } };
    const userMessage = {
      id: 'm-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '顺手把 README 的发布说明补一下' }],
    };
    const added = captureSteering(captureStore, session, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', inserted: [userMessage] },
    });
    assert.equal(added.length, 1);
    assert.equal(added[0].source, 'steer');
    assert.equal(added[0].sourceMessageId, 'm-1');

    // 同一条消息重复出现（重放/重复投影）不会重复记
    assert.equal(captureSteering(captureStore, session, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', inserted: [userMessage] },
    }).length, 0);

    // 排队（next-turn）不是插话
    assert.equal(captureSteering(captureStore, session, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', inserted: [{ ...userMessage, id: 'm-2' }] },
    }).length, 0);

    // 本插件注入的上下文不捕获
    assert.equal(captureSteering(captureStore, session, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', inserted: [{ ...userMessage, id: 'm-3', source: { kind: 'quest-log' } }] },
    }).length, 0);

    // 子 Agent 会话不捕获
    assert.equal(captureSteering(captureStore, { header: { id: 'sub', origin: 'subagent' } }, {
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', inserted: [{ ...userMessage, id: 'm-4' }] },
    }).length, 0);
  });

  test('captureSteering 多行插话拆成标题 + 说明', () => {
    const captureStore = new QuestStore({ dir: join(dir, 'capture2'), now: () => 6000 });
    const added = captureSteering(captureStore, { header: { id: 'session-capture2' } }, {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        inserted: [{
          id: 'm-9', role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: '补发布说明\n\n记得写 changelog 和 npm 版本号' }],
        }],
      },
    });
    assert.equal(added.length, 1);
    assert.equal(added[0].title, '补发布说明');
    assert.ok(added[0].detail.includes('changelog'));
  });

  test('overview 汇总所有会话并排除空台账', () => {
    const overviewDir = join(dir, 'overview');
    const overviewStore = new QuestStore({ dir: overviewDir, now: () => 7000 });
    const sessionA = 'session-overview-a';
    const sessionB = 'session-overview-b';
    const sessionC = 'session-overview-c';
    overviewStore.add(sessionA, { title: 'A1' });
    overviewStore.add(sessionA, { title: 'A2' });
    const b = overviewStore.add(sessionB, { title: 'B1' }).quest;
    overviewStore.update(sessionB, b.id, { status: 'done' }, 'user');
    const c = overviewStore.add(sessionC, { title: 'C1' }).quest;
    overviewStore.remove(sessionC, c.id);
    // 直接把 A1 标完成，制造 1 未完成 + 1 完成
    const a1 = overviewStore.get(sessionA, overviewStore.list(sessionA)[0].id);
    overviewStore.update(sessionA, a1.id, { status: 'done' }, 'user');

    const overview = overviewStore.overview();
    assert.equal(overview.totals.sessions, 2);
    assert.equal(overview.totals.open, 1);
    assert.equal(overview.totals.done, 2);
    const rows = overview.sessions.map((row) => row.sessionId);
    assert.ok(rows.includes(sessionA));
    assert.ok(rows.includes(sessionB));
    assert.ok(!rows.includes(sessionC));
    // 未完成多的会话排前面：A 有 1 项未完成，B 没有
    assert.equal(overview.sessions[0].sessionId, sessionA);

    const apiOps = createOperations(overviewStore);
    const apiOverview = apiOps.overview({});
    assert.equal(apiOverview.ok, true);
    assert.equal(apiOverview.totals.sessions, 2);
    assert.equal(apiOverview.sessions.length, 2);
  });

  test('overview 在台账目录不存在时返回空', () => {
    const emptyStore = new QuestStore({ dir: join(dir, 'overview-empty'), now: () => 8000 });
    const overview = emptyStore.overview();
    assert.deepEqual(overview.totals, { open: 0, done: 0, total: 0, sessions: 0 });
    assert.deepEqual(overview.sessions, []);
  });

  test('shouldAutoContinue 护栏', () => {
    const base = {
      enabled: true, stopping: false, live: true, status: 'idle', failed: false,
      lastTurnEnd: 'completed', competingQueued: false, pendingNextTurn: 0, pendingNextStep: 0,
      openCount: 2, rounds: 0, maxRounds: 3,
    };
    assert.equal(shouldAutoContinue(base).continue, true);
    assert.equal(shouldAutoContinue({ ...base, status: 'running' }).reason, 'not-idle');
    assert.equal(shouldAutoContinue({ ...base, lastTurnEnd: 'aborted' }).reason, 'turn-not-completed');
    assert.equal(shouldAutoContinue({ ...base, competingQueued: true }).reason, 'competing-input');
    assert.equal(shouldAutoContinue({ ...base, pendingNextTurn: 1 }).reason, 'next-turn-pending');
    assert.equal(shouldAutoContinue({ ...base, pendingNextStep: 1 }).reason, 'next-step-pending');
    assert.equal(shouldAutoContinue({ ...base, openCount: 0 }).reason, 'nothing-open');
    assert.equal(shouldAutoContinue({ ...base, rounds: 3 }).reason, 'round-limit');
    assert.equal(shouldAutoContinue({ ...base, enabled: false }).reason, 'disabled');
    assert.equal(shouldAutoContinue({ ...base, failed: true }).reason, 'failed');
    assert.equal(shouldAutoContinue({ ...base, live: false }).reason, 'not-live');
  });

  test('shouldInjectChange 只注入运行中的用户侧变动', () => {
    const base = { enabled: true, actor: 'user', live: true, status: 'running' };
    assert.equal(shouldInjectChange(base), true);
    assert.equal(shouldInjectChange({ ...base, actor: 'agent' }), false);
    assert.equal(shouldInjectChange({ ...base, actor: 'steer' }), false);
    assert.equal(shouldInjectChange({ ...base, status: 'idle' }), false);
    assert.equal(shouldInjectChange({ ...base, live: false }), false);
  });

  test('客户端样式使用主题语义 token（深色模式回归）', () => {
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
    const start = source.indexOf('const CSS = `');
    const end = source.indexOf('`;', start);
    assert.ok(start > 0 && end > start, 'client.js 里应有 CSS 模板串');
    const css = source.slice(start, end);

    // 主按钮：深色主题 brand-primary 是近白色，白字会直接看不见。
    assert.match(css, /\.dql-btn-primary\{[^}]*background:var\(--dsw-alias-button-primary-fill/);
    assert.match(css, /\.dql-btn-primary\{[^}]*color:var\(--dsw-alias-label-primary-foreground\)/);
    assert.doesNotMatch(css, /\.dql-btn-primary\{[^}]*color:#fff/);

    // hover/选中态：bg-layer-2 在浅色主题下与底同色，交互反馈必须用 interactive token。
    for (const [, selector, body] of css.matchAll(/([^{}]+):hover[^{}]*\{([^}]*)\}/g)) {
      assert.ok(!body.includes('bg-layer-2'), `${selector.trim()} :hover 不应使用 bg-layer-2`);
    }
    assert.match(css, /\.dql-tab\[aria-selected="true"\]\{[^}]*background:var\(--dsw-alias-interactive-bg-active\)/);

    // 焦点环交给宿主的 :focus-visible 主题规则，不硬编码 brand-primary。
    assert.doesNotMatch(css, /:focus-visible\{[^}]*outline:2px solid/);
  });

  process.stdout.write(`\n${passed} tests passed\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
