/**
 * dsh-quest-log — Client half.
 *
 * 两个界面：
 *
 * 1. 侧边栏「任务台账」主面板 = **全部会话的任务统计面板**：
 *    汇总未完成/已完成/有任务的会话数，并按未完成数排出各会话的任务量，
 *    点一行跳到对应会话。
 * 2. 每个会话右侧边栏的「任务看板」标签页（`sidebarRightTabs` 注册的扩展页）：
 *    看板本体（增删改查、筛选、清空已完成）在这里，按右侧边栏所属会话取数。
 *
 * 数据全部由宿主回环路由 `/dsh-quest-log/api` 提供：`overview` 供总览，
 * `list/add/update/remove/clearDone` 供看板；同一套 Host 操作同时暴露成 Agent
 * 工具，界面与工具走同一条实现路径。
 *
 * - 整个文件包在 IIFE 里：客户端 bundle 被拼进同一个 classic-script 批次执行，
 *   顶层绑定会与其它插件冲突。
 * - 样式只用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token，浅色/深色由宿主继承。
 */
(() => {
  const MODULE_ID = '@restregular/dsh-quest-log';

  /** 宿主 facade 是否已经登记过本模块（重复加载时直接退出）。 */
  function alreadyRegistered() {
    const factories = window.__ModuleLoader__?.factories;
    return factories !== undefined && typeof factories.has === 'function' && factories.has(MODULE_ID);
  }

  if (alreadyRegistered()) return;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useMemo, useRef, useState } = React;

      const NS = 'dsh-quest-log';
      const API = '/dsh-quest-log/api';
      const POLL_MS = 1500;
      const OVERVIEW_POLL_MS = 3000;
      const PANEL_ID = 'quest-log';
      /** 右侧边栏标签页的类型 kind。 */
      const TAB_KIND = 'quest-log';

      // ------------------------------------------------------------------
      // 文案
      // ------------------------------------------------------------------
      const DICT = {
        zh: {
          'panel.title': '任务台账',
          'panel.subtitle': '记住插话里塞进来的额外任务',
          'panel.session': '会话 {id}',
          'panel.noSession': '当前标签页没有会话上下文',
          'panel.statsOpen': '未完成 {count}',
          'panel.statsDone': '已完成 {count}',
          'panel.addPlaceholder': '记一条任务，例如：等主流程跑完后补上 README 的发布说明',
          'panel.detailPlaceholder': '补充说明（可选）：验收标准、注意点、相关文件…',
          'panel.add': '添加',
          'panel.addDetail': '添加说明',
          'panel.cancel': '取消',
          'panel.filterAll': '全部 {count}',
          'panel.filterOpen': '未完成 {count}',
          'panel.filterDone': '已完成 {count}',
          'panel.emptyNoSession': '当前标签页没有会话上下文，无法显示任务看板。',
          'panel.empty': '这个会话还没有任务。用户插话发来的额外任务会自动记在这里，也可以手动添加。',
          'panel.emptyDone': '还没有已完成的任务。',
          'panel.emptyOpen': '太好了，没有未完成任务。',
          'panel.edit': '编辑',
          'panel.save': '保存',
          'panel.remove': '删除',
          'panel.clearDone': '清空已完成',
          'panel.clearDoneConfirm': '确定清空 {count} 条已完成任务？',
          'panel.refresh': '刷新',
          'panel.sourceSteer': '插话',
          'panel.sourceUser': '手动',
          'panel.sourceAgent': 'Agent',
          'panel.sourceUnknown': '任务',
          'panel.footer': '每轮结束若仍有未完成任务，Agent 会自动收到继续提醒；完成时它应该把任务标记为已完成。',
          'panel.failed': '操作失败：{message}',
          'panel.added': '已添加任务',
          'panel.updated': '已更新任务',
          'panel.removed': '已删除任务',
          'panel.cleared': '已清空 {count} 条已完成任务',
          'panel.busy': '处理中…',
          'panel.hintTools': '工具：quest_log_add / quest_log_list / quest_log_update / quest_log_remove',
          'panel.editTitle': '任务内容',
          'panel.editDetail': '任务说明',
          'panel.created': '创建于 {time}',
          'panel.doneAt': '完成于 {time}',
          'panel.counts': '{open} 项未完成 · {done} 项已完成',
          'board.title': '任务看板',
          'board.subtitle': '本会话的任务台账',
          'board.tabTitle': '任务看板',
          'board.guideTitle': '任务看板',
          'board.guideDescription': '查看并管理本会话的任务：插话发来的额外任务会自动记录，每轮结束还会检查未完成项。',
          'overview.title': '任务台账',
          'overview.subtitle': '全部会话的任务统计',
          'overview.totalsOpen': '未完成 {count}',
          'overview.totalsDone': '已完成 {count}',
          'overview.totalsSessions': '有任务的会话 {count}',
          'overview.refresh': '刷新',
          'overview.sessions': '按未完成数排序',
          'overview.untitled': '未命名会话',
          'overview.rowMeta': '{where} · 更新于 {time}',
          'overview.rowCounts': '未完成 {open} · 已完成 {done}',
          'overview.openHint': '点击打开这个会话',
          'overview.emptyTitle': '还没有任务',
          'overview.empty': '任务看板在会话右侧边栏：打开任意会话，点右侧边栏里的「任务看板」卡片即可添加和管理该会话的任务；用户插话发来的任务会自动记录。',
          'overview.hint': '这里只统计有任务的会话；任务看板在会话右侧边栏打开。',
          'overview.loading': '加载中…',
          'overview.failed': '加载失败：{message}',
          'overview.workspaceUnknown': '未知工作区',
        },
        en: {
          'panel.title': 'Quest Log',
          'panel.subtitle': 'Keep the extra tasks you interject',
          'panel.session': 'Session {id}',
          'panel.noSession': 'No session in this tab',
          'panel.statsOpen': 'Open {count}',
          'panel.statsDone': 'Done {count}',
          'panel.addPlaceholder': 'Add a task, e.g. update the README after the main flow is done',
          'panel.detailPlaceholder': 'Optional notes: acceptance criteria, gotchas, related files…',
          'panel.add': 'Add',
          'panel.addDetail': 'Add notes',
          'panel.cancel': 'Cancel',
          'panel.filterAll': 'All {count}',
          'panel.filterOpen': 'Open {count}',
          'panel.filterDone': 'Done {count}',
          'panel.emptyNoSession': 'This tab has no session context, so no quest board can be shown.',
          'panel.empty': 'No quests in this session yet. Extra tasks sent while the agent works are recorded here automatically; you can add one manually too.',
          'panel.emptyDone': 'No completed quests yet.',
          'panel.emptyOpen': 'Nice — nothing left to do.',
          'panel.edit': 'Edit',
          'panel.save': 'Save',
          'panel.remove': 'Delete',
          'panel.clearDone': 'Clear done',
          'panel.clearDoneConfirm': 'Clear {count} completed quests?',
          'panel.refresh': 'Refresh',
          'panel.sourceSteer': 'Steer',
          'panel.sourceUser': 'Manual',
          'panel.sourceAgent': 'Agent',
          'panel.sourceUnknown': 'Quest',
          'panel.footer': 'At the end of a turn with unfinished quests the agent is asked to continue; it marks quests done when they are finished.',
          'panel.failed': 'Action failed: {message}',
          'panel.added': 'Quest added',
          'panel.updated': 'Quest updated',
          'panel.removed': 'Quest deleted',
          'panel.cleared': 'Cleared {count} completed quests',
          'panel.busy': 'Working…',
          'panel.hintTools': 'Tools: quest_log_add / quest_log_list / quest_log_update / quest_log_remove',
          'panel.editTitle': 'Quest text',
          'panel.editDetail': 'Notes',
          'panel.created': 'Created {time}',
          'panel.doneAt': 'Done {time}',
          'panel.counts': '{open} open · {done} done',
          'board.title': 'Quest Board',
          'board.subtitle': 'This session’s quest ledger',
          'board.tabTitle': 'Quest Board',
          'board.guideTitle': 'Quest Board',
          'board.guideDescription': 'View and manage this session’s quests: interjected tasks are recorded automatically and unfinished ones are checked at every turn end.',
          'overview.title': 'Quest Log',
          'overview.subtitle': 'Task statistics across all sessions',
          'overview.totalsOpen': 'Open {count}',
          'overview.totalsDone': 'Done {count}',
          'overview.totalsSessions': 'Sessions with quests {count}',
          'overview.refresh': 'Refresh',
          'overview.sessions': 'Sorted by open quests',
          'overview.untitled': 'Untitled session',
          'overview.rowMeta': '{where} · updated {time}',
          'overview.rowCounts': '{open} open · {done} done',
          'overview.openHint': 'Open this session',
          'overview.emptyTitle': 'No quests yet',
          'overview.empty': 'The quest board lives in the session’s right sidebar: open a session and click the “Quest Board” card there to add and manage its quests. Interjected tasks are recorded automatically.',
          'overview.hint': 'Only sessions with quests are listed here; the board opens in the session’s right sidebar.',
          'overview.loading': 'Loading…',
          'overview.failed': 'Load failed: {message}',
          'overview.workspaceUnknown': 'Unknown workspace',
        },
      };

      /** 兜底翻译器：locale 服务缺席时也能渲染出中文。 */
      function fallbackTranslate(key, params) {
        const dict = DICT.zh;
        let text = dict[key] !== undefined ? dict[key] : key;
        for (const [name, value] of Object.entries(params || {})) {
          text = text.split(`{${name}}`).join(String(value));
        }
        return text;
      }

      let translateCurrent = fallbackTranslate;

      function bindLocale(ctx) {
        const locale = ctx.get('locale');
        if (locale === undefined || typeof locale.register !== 'function') return;
        try {
          const dispose = locale.register(NS, DICT);
          if (typeof locale.bind === 'function') translateCurrent = locale.bind(NS);
          ctx.effect(() => () => {
            translateCurrent = fallbackTranslate;
            try {
              dispose?.();
            } catch {
              /* 移除字典失败不应影响卸载 */
            }
          }, 'dsh-quest-log: dictionaries');
        } catch (error) {
          console.warn('[dsh-quest-log] locale registration failed:', error?.message ?? error);
        }
      }

      // ------------------------------------------------------------------
      // 宿主路由（回环 HTTP）
      // ------------------------------------------------------------------
      async function apiGet(op, params = {}) {
        const url = new URL(API, window.location.origin);
        url.searchParams.set('op', op);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      }

      async function apiPost(body) {
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      }

      // ------------------------------------------------------------------
      // 会话元数据（标题 / 工作区）来自客户端 uiWorkspace 快照
      // ------------------------------------------------------------------
      /**
       * 读宿主 uiWorkspace 快照里的会话行。
       * @param ctx - 客户端上下文。
       * @returns {Array<object>} 会话行。
       */
      function sessionRows(ctx) {
        try {
          const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          const snapshot = uiWorkspace?.sessions?.list?.getSnapshot?.();
          const byId = snapshot && typeof snapshot.byId === 'object' ? snapshot.byId : undefined;
          if (byId === undefined) return [];
          return Object.entries(byId).map(([id, row]) => ({
            id: typeof row?.id === 'string' && row.id !== '' ? row.id : id,
            title: typeof row?.title === 'string' ? row.title : undefined,
            cwd: typeof row?.cwd === 'string' ? row.cwd : undefined,
            updatedAt: typeof row?.updatedAt === 'number' ? row.updatedAt : undefined,
            running: row?.running === true,
          }));
        } catch {
          return [];
        }
      }

      /** 会话元数据索引：sessionId → 行。 */
      function sessionMetaMap(ctx) {
        const map = new Map();
        for (const row of sessionRows(ctx)) {
          if (typeof row.id === 'string') map.set(row.id, row);
        }
        return map;
      }

      function shortSession(sessionId) {
        const text = typeof sessionId === 'string' ? sessionId : '';
        const parts = text.split('-');
        const tail = parts[parts.length - 1] || text;
        return tail.slice(0, 8);
      }

      function workspaceLabel(cwd) {
        if (typeof cwd !== 'string' || cwd === '') return undefined;
        const parts = cwd.split(/[\\/]+/u).filter((part) => part !== '');
        return parts.length === 0 ? undefined : parts[parts.length - 1];
      }

      function formatTime(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
        try {
          const date = new Date(value);
          const pad = (n) => String(n).padStart(2, '0');
          return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        } catch {
          return '';
        }
      }

      /**
       * 打开某个会话（总览行点击）。
       * @param ctx - 客户端上下文。
       * @param sessionId - 会话 id。
       * @returns {boolean} 是否已派发。
       */
      function openSession(ctx, sessionId) {
        try {
          const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
          if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
            uiWorkspace.openSession(sessionId);
            return true;
          }
        } catch (error) {
          console.warn('[dsh-quest-log] openSession failed:', error?.message ?? error);
        }
        return false;
      }

      // ------------------------------------------------------------------
      // 样式
      // ------------------------------------------------------------------
      const CSS = `
.dql-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dql-head{flex:none;padding:18px 22px 0}
.dql-pane .dql-head{padding:14px 14px 0}
.dql-title-row{display:flex;align-items:flex-start;gap:12px}
.dql-title{font-size:16px;font-weight:650;margin:0;letter-spacing:.01em}
.dql-pane .dql-title{font-size:14px}
.dql-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:3px 0 0}
.dql-session{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);padding-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.dql-stats{display:flex;gap:8px;align-items:center;margin:12px 0 0;flex-wrap:wrap}
.dql-pane .dql-stats{margin:10px 0 0}
.dql-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dql-chip-open{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);color:var(--dsw-alias-state-warn-primary)}
.dql-chip-done{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-state-success-primary)}
.dql-head-actions{margin-left:auto;display:flex;gap:6px}
.dql-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;font-size:12px;line-height:18px;padding:4px 10px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dql-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dql-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dql-btn[disabled]{opacity:.5;cursor:default}
.dql-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dql-btn-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}
.dql-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dql-btn-ghost:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dql-btn-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dql-form{margin:14px 22px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dql-pane .dql-form{margin:12px 14px 0}
.dql-textarea,.dql-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.6;padding:7px 9px;resize:vertical;outline:none}
.dql-textarea{min-height:44px;max-height:180px}
.dql-textarea:focus,.dql-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dql-form-actions{display:flex;gap:8px;align-items:center}
.dql-form-actions .dql-grow{flex:1}
.dql-form-hint{color:var(--dsw-alias-label-secondary);font-size:11px}
.dql-tabs{flex:none;display:flex;gap:6px;padding:14px 22px 0;flex-wrap:wrap}
.dql-pane .dql-tabs{padding:12px 14px 0}
.dql-tab{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.dql-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dql-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.dql-banner{margin:12px 22px 0;border-radius:8px;padding:7px 10px;font-size:12px;display:flex;gap:8px;align-items:center;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.dql-pane .dql-banner{margin:10px 14px 0}
.dql-banner-error{color:var(--dsw-alias-state-error-primary)}
.dql-banner-error .dql-banner-close{margin-left:auto;cursor:pointer;background:none;border:0;color:inherit;font-size:14px;line-height:1;padding:2px 4px}
.dql-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 22px 20px;display:flex;flex-direction:column;gap:8px}
.dql-pane .dql-list{padding:10px 14px 16px}
.dql-empty{margin:auto;max-width:420px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.8;padding:28px 12px}
.dql-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 6px}
.dql-row{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;transition:border-color .12s ease,background .12s ease}
.dql-row:hover{border-color:var(--dsw-alias-border-l2)}
.dql-row-done{opacity:.72;background:var(--dsw-alias-bg-layer-2)}
.dql-check{flex:none;width:20px;height:20px;border-radius:6px;border:1.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;color:#fff;margin-top:1px}
.dql-check[aria-checked="true"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.dql-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dql-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dql-row-title{font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.dql-row-done .dql-row-title{text-decoration:line-through;text-decoration-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-secondary)}
.dql-row-detail{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.dql-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dql-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;line-height:17px;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dql-badge-steer{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)}
.dql-badge-agent{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)}
.dql-row-actions{flex:none;display:flex;gap:2px;align-items:center;opacity:0;transition:opacity .12s ease}
.dql-row:hover .dql-row-actions,.dql-row:focus-within .dql-row-actions{opacity:1}
.dql-mini{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:11px;padding:3px 7px;cursor:pointer;font-family:inherit}
.dql-mini:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dql-mini-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dql-editor{display:flex;flex-direction:column;gap:6px;width:100%}
.dql-foot{flex:none;padding:8px 22px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;flex-direction:column;gap:3px}
.dql-pane .dql-foot{padding:8px 14px 10px}
.dql-foot-tools{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.9;word-break:break-all}
.dql-loading{color:var(--dsw-alias-label-secondary);font-size:12px;padding:14px 0}
.dql-ov{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dql-ov-head{flex:none;padding:18px 22px 0}
.dql-ov-title{font-size:16px;font-weight:650;margin:0;letter-spacing:.01em}
.dql-ov-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin:3px 0 0}
.dql-ov-totals{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0 0}
.dql-ov-totals .dql-head-actions{margin-left:auto}
.dql-ov-section{flex:none;display:flex;align-items:center;gap:8px;padding:16px 22px 0;color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.02em}
.dql-ov-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 22px 18px;display:flex;flex-direction:column;gap:8px}
.dql-ov-row{display:flex;align-items:center;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;cursor:pointer;transition:border-color .12s ease,background .12s ease;text-align:left;font-family:inherit;color:inherit;width:100%}
.dql-ov-row:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dql-ov-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dql-ov-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dql-ov-name{font-size:13px;font-weight:600;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dql-ov-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dql-ov-counts{flex:none;display:flex;gap:6px;align-items:center}
.dql-ov-empty{margin:auto;max-width:440px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.8;padding:28px 12px}
.dql-ov-foot{flex:none;padding:8px 22px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}
`;

      /** 注入一次样式表，卸载时移除。 */
      function installStyles(ctx) {
        try {
          ctx.effect(() => {
            const style = document.createElement('style');
            style.dataset.dshPlugin = 'dsh-quest-log';
            style.textContent = CSS;
            document.head.appendChild(style);
            return () => {
              style.remove();
            };
          }, 'dsh-quest-log: styles');
        } catch (error) {
          console.warn('[dsh-quest-log] style installation failed:', error?.message ?? error);
        }
      }

      // ------------------------------------------------------------------
      // 小图标
      // ------------------------------------------------------------------
      function QuestLogIcon({ size = 16 }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          'aria-hidden': 'true', focusable: 'false',
        },
        h('rect', { x: 3.1, y: 1.9, width: 9.8, height: 12.2, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M5.4 5.1h5.2M5.4 8h5.2M5.4 10.9h3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M1.9 4.6v6.9c0 .7.6 1.3 1.3 1.3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.55 }),
        );
      }

      function CheckIcon() {
        return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true' },
          h('path', { d: 'M2.4 6.3 4.9 8.8 9.7 3.4', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        );
      }

      // ------------------------------------------------------------------
      // 会话任务看板（右侧边栏标签页）
      // ------------------------------------------------------------------
      const FILTERS = ['all', 'open', 'done'];

      /**
       * 一个会话的任务看板。
       * @param props - { ctx, sessionId, pane }。
       * @returns 看板元素。
       */
      function QuestBoard({ ctx, sessionId, pane = false }) {
        const [quests, setQuests] = useState([]);
        const [stats, setStats] = useState({ open: 0, done: 0 });
        const [loaded, setLoaded] = useState(false);
        const [filter, setFilter] = useState('all');
        const [draft, setDraft] = useState('');
        const [draftDetail, setDraftDetail] = useState('');
        const [showDetail, setShowDetail] = useState(false);
        const [editing, setEditing] = useState(null);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(undefined);
        const [notice, setNotice] = useState(undefined);
        const noticeTimer = useRef(undefined);
        const t = translateCurrent;
        const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;

        const flash = useCallback((message) => {
          setNotice(message);
          if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(() => setNotice(undefined), 2400);
        }, []);

        useEffect(() => () => {
          if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
        }, []);

        const clearView = useCallback(() => {
          setQuests([]);
          setStats({ open: 0, done: 0 });
          setLoaded(true);
        }, []);

        const refresh = useCallback(async () => {
          if (sid === undefined) {
            clearView();
            return;
          }
          try {
            const data = await apiGet('list', { sessionId: sid });
            setQuests(Array.isArray(data.quests) ? data.quests : []);
            setStats(data.stats !== null && typeof data.stats === 'object'
              ? { open: Number(data.stats.open) || 0, done: Number(data.stats.done) || 0 }
              : { open: 0, done: 0 });
            setLoaded(true);
            setError(undefined);
          } catch (err) {
            setError(String(err?.message ?? err));
          }
        }, [sid, clearView]);

        useEffect(() => {
          let alive = true;
          const tick = async () => {
            if (!alive) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            await refresh();
          };
          setLoaded(false);
          setFilter('all');
          setEditing(null);
          tick();
          const timer = setInterval(tick, POLL_MS);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, [refresh]);

        const run = useCallback(async (operation, successText) => {
          setBusy(true);
          try {
            const result = await operation();
            if (successText !== undefined) flash(successText(result));
            setError(undefined);
            await refresh();
            return result;
          } catch (err) {
            setError(String(err?.message ?? err));
            return undefined;
          } finally {
            setBusy(false);
          }
        }, [flash, refresh]);

        const addQuest = useCallback(async () => {
          const title = draft.trim();
          if (title === '' || sid === undefined) return;
          const detail = draftDetail.trim();
          await run(
            () => apiPost({ op: 'add', sessionId: sid, title, ...(detail === '' ? {} : { detail }) }),
            () => t('panel.added'),
          );
          setDraft('');
          setDraftDetail('');
          setShowDetail(false);
        }, [draft, draftDetail, sid, run, t]);

        const toggleQuest = useCallback(async (quest) => {
          if (sid === undefined) return;
          const nextStatus = quest.status === 'done' ? 'open' : 'done';
          await run(
            () => apiPost({ op: 'update', sessionId: sid, id: quest.id, status: nextStatus }),
            () => t('panel.updated'),
          );
        }, [sid, run, t]);

        const saveEditing = useCallback(async () => {
          if (editing === null || sid === undefined) return;
          const title = String(editing.title ?? '').trim();
          if (title === '') return;
          await run(
            () => apiPost({ op: 'update', sessionId: sid, id: editing.id, title, detail: String(editing.detail ?? '') }),
            () => t('panel.updated'),
          );
          setEditing(null);
        }, [editing, sid, run, t]);

        const removeQuest = useCallback(async (quest) => {
          if (sid === undefined) return;
          await run(
            () => apiPost({ op: 'remove', sessionId: sid, id: quest.id }),
            () => t('panel.removed'),
          );
        }, [sid, run, t]);

        const clearDone = useCallback(async () => {
          if (sid === undefined || stats.done === 0) return;
          const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(t('panel.clearDoneConfirm', { count: stats.done }))
            : true;
          if (!confirmed) return;
          await run(
            () => apiPost({ op: 'clearDone', sessionId: sid }),
            (result) => t('panel.cleared', { count: Number(result?.removed) || 0 }),
          );
        }, [sid, stats.done, run, t]);

        const visible = useMemo(() => {
          const rows = Array.isArray(quests) ? quests : [];
          if (filter === 'open') return rows.filter((quest) => quest.status !== 'done');
          if (filter === 'done') return rows.filter((quest) => quest.status === 'done');
          return rows;
        }, [quests, filter]);

        const sourceLabel = useCallback((source) => {
          if (source === 'steer') return t('panel.sourceSteer');
          if (source === 'agent') return t('panel.sourceAgent');
          if (source === 'user') return t('panel.sourceUser');
          return t('panel.sourceUnknown');
        }, [t]);

        const renderRow = (quest) => {
          if (editing !== null && editing.id === quest.id) {
            return h('div', { key: quest.id, className: 'dql-row' },
              h('div', { className: 'dql-editor' },
                h('textarea', {
                  className: 'dql-textarea',
                  value: editing.title,
                  'aria-label': t('panel.editTitle'),
                  onChange: (event) => setEditing({ ...editing, title: event.target.value }),
                }),
                h('textarea', {
                  className: 'dql-textarea',
                  value: editing.detail,
                  placeholder: t('panel.detailPlaceholder'),
                  'aria-label': t('panel.editDetail'),
                  onChange: (event) => setEditing({ ...editing, detail: event.target.value }),
                }),
                h('div', { className: 'dql-form-actions' },
                  h('button', {
                    type: 'button', className: 'dql-btn dql-btn-primary', disabled: busy,
                    onClick: saveEditing,
                  }, t('panel.save')),
                  h('button', {
                    type: 'button', className: 'dql-btn dql-btn-ghost',
                    onClick: () => setEditing(null),
                  }, t('panel.cancel')),
                ),
              ),
            );
          }
          const done = quest.status === 'done';
          return h('div', { key: quest.id, className: `dql-row${done ? ' dql-row-done' : ''}` },
            h('button', {
              type: 'button',
              className: 'dql-check',
              role: 'checkbox',
              'aria-checked': done ? 'true' : 'false',
              'aria-label': done ? 'open' : 'done',
              disabled: busy,
              onClick: () => toggleQuest(quest),
            }, done ? h(CheckIcon) : null),
            h('div', { className: 'dql-body' },
              h('div', { className: 'dql-row-title' }, quest.title),
              quest.detail ? h('div', { className: 'dql-row-detail' }, quest.detail) : null,
              h('div', { className: 'dql-meta' },
                h('span', { className: `dql-badge dql-badge-${quest.source === 'steer' ? 'steer' : quest.source === 'agent' ? 'agent' : 'user'}` }, sourceLabel(quest.source)),
                h('span', null, done && quest.completedAt
                  ? t('panel.doneAt', { time: formatTime(quest.completedAt) })
                  : t('panel.created', { time: formatTime(quest.createdAt) })),
              ),
            ),
            h('div', { className: 'dql-row-actions' },
              h('button', {
                type: 'button', className: 'dql-mini',
                onClick: () => setEditing({ id: quest.id, title: quest.title, detail: quest.detail ?? '' }),
              }, t('panel.edit')),
              h('button', {
                type: 'button', className: 'dql-mini dql-mini-danger',
                disabled: busy,
                onClick: () => removeQuest(quest),
              }, t('panel.remove')),
            ),
          );
        };

        const filterCount = (kind) => {
          if (kind === 'open') return stats.open;
          if (kind === 'done') return stats.done;
          return stats.open + stats.done;
        };

        const canAdd = sid !== undefined && draft.trim() !== '' && !busy;

        return h('div', { className: `dql-root${pane ? ' dql-pane' : ''}` },
          h('div', { className: 'dql-head' },
            h('div', { className: 'dql-title-row' },
              h('div', null,
                h('h2', { className: 'dql-title' }, t('board.title')),
                h('p', { className: 'dql-sub' }, t('board.subtitle')),
              ),
              h('div', { className: 'dql-session', title: sid || '' },
                sid !== undefined ? t('panel.session', { id: shortSession(sid) }) : t('panel.noSession')),
            ),
            h('div', { className: 'dql-stats' },
              h('span', { className: 'dql-chip dql-chip-open' }, t('panel.statsOpen', { count: stats.open })),
              h('span', { className: 'dql-chip dql-chip-done' }, t('panel.statsDone', { count: stats.done })),
              h('div', { className: 'dql-head-actions' },
                h('button', {
                  type: 'button', className: 'dql-btn dql-btn-ghost', disabled: busy || sid === undefined,
                  onClick: () => { void refresh(); },
                }, t('panel.refresh')),
                h('button', {
                  type: 'button', className: 'dql-btn dql-btn-ghost dql-btn-danger',
                  disabled: busy || stats.done === 0,
                  onClick: clearDone,
                }, t('panel.clearDone')),
              ),
            ),
          ),

          sid === undefined ? null : h('div', { className: 'dql-form' },
            h('textarea', {
              className: 'dql-textarea',
              value: draft,
              placeholder: t('panel.addPlaceholder'),
              'aria-label': t('panel.addPlaceholder'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canAdd) void addQuest();
                }
              },
            }),
            showDetail ? h('textarea', {
              className: 'dql-textarea',
              value: draftDetail,
              placeholder: t('panel.detailPlaceholder'),
              'aria-label': t('panel.detailPlaceholder'),
              onChange: (event) => setDraftDetail(event.target.value),
            }) : null,
            h('div', { className: 'dql-form-actions' },
              h('button', {
                type: 'button', className: 'dql-btn dql-btn-primary', disabled: !canAdd,
                onClick: () => void addQuest(),
              }, t('panel.add')),
              h('button', {
                type: 'button', className: 'dql-btn dql-btn-ghost',
                onClick: () => {
                  setShowDetail((value) => !value);
                  if (showDetail) setDraftDetail('');
                },
              }, t('panel.addDetail')),
              h('span', { className: 'dql-grow' }),
              h('span', { className: 'dql-form-hint' }, t('panel.counts', { open: stats.open, done: stats.done })),
            ),
          ),

          h('div', { className: 'dql-tabs', role: 'tablist' },
            ...FILTERS.map((kind) => h('button', {
              key: kind,
              type: 'button',
              role: 'tab',
              className: 'dql-tab',
              'aria-selected': filter === kind ? 'true' : 'false',
              onClick: () => setFilter(kind),
            }, t(kind === 'all' ? 'panel.filterAll' : kind === 'open' ? 'panel.filterOpen' : 'panel.filterDone', { count: filterCount(kind) }))),
          ),

          error !== undefined ? h('div', { className: 'dql-banner dql-banner-error' },
            h('span', null, t('panel.failed', { message: error })),
            h('button', {
              type: 'button', className: 'dql-banner-close', 'aria-label': 'dismiss',
              onClick: () => setError(undefined),
            }, '×'),
          ) : null,

          notice !== undefined ? h('div', { className: 'dql-banner' }, h('span', null, notice)) : null,

          h('div', { className: 'dql-list' },
            sid === undefined
              ? h('div', { className: 'dql-empty' }, h('p', null, t('panel.emptyNoSession')))
              : loaded && visible.length === 0
                ? h('div', { className: 'dql-empty' },
                  h('p', { className: 'dql-empty-title' }, quests.length === 0 ? t('board.title') : t('panel.emptyOpen')),
                  h('p', null, quests.length === 0
                    ? t('panel.empty')
                    : filter === 'done' ? t('panel.emptyDone') : t('panel.emptyOpen')))
                : visible.map(renderRow),
          ),

          h('div', { className: 'dql-foot' },
            h('span', null, t('panel.footer')),
            h('span', { className: 'dql-foot-tools' }, t('panel.hintTools')),
          ),
        );
      }

      /** 右侧边栏标签页里的看板（会话上下文由 slot props 提供）。 */
      function QuestBoardTab({ ctx, sessionId }) {
        return h(QuestBoard, { ctx, sessionId, pane: true });
      }

      /** 右侧边栏标签页的标题。 */
      function QuestBoardTabTitle(props) {
        const t = typeof props?.t === 'function' ? props.t : translateCurrent;
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h(QuestLogIcon, { size: 15 }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('board.tabTitle')),
        );
      }

      // ------------------------------------------------------------------
      // 侧边栏主面板：全部会话的任务统计
      // ------------------------------------------------------------------
      function QuestOverviewPage({ ctx }) {
        const [overview, setOverview] = useState({
          totals: { open: 0, done: 0, total: 0, sessions: 0 },
          sessions: [],
        });
        const [meta, setMeta] = useState(() => sessionMetaMap(ctx));
        const [loaded, setLoaded] = useState(false);
        const [error, setError] = useState(undefined);
        const t = translateCurrent;

        const refresh = useCallback(async () => {
          try {
            const data = await apiGet('overview');
            setOverview({
              totals: data.totals !== null && typeof data.totals === 'object'
                ? {
                  open: Number(data.totals.open) || 0,
                  done: Number(data.totals.done) || 0,
                  total: Number(data.totals.total) || 0,
                  sessions: Number(data.totals.sessions) || 0,
                }
                : { open: 0, done: 0, total: 0, sessions: 0 },
              sessions: Array.isArray(data.sessions) ? data.sessions : [],
            });
            setMeta(sessionMetaMap(ctx));
            setError(undefined);
          } catch (err) {
            setError(String(err?.message ?? err));
          } finally {
            setLoaded(true);
          }
        }, [ctx]);

        useEffect(() => {
          let alive = true;
          const tick = async () => {
            if (!alive) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            await refresh();
          };
          tick();
          const timer = setInterval(tick, OVERVIEW_POLL_MS);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, [refresh]);

        const totals = overview.totals;
        const rows = overview.sessions;

        const titleOf = (sessionId) => {
          const row = meta.get(sessionId);
          const title = typeof row?.title === 'string' ? row.title.trim() : '';
          return title !== '' ? title : t('overview.untitled');
        };

        const whereOf = (sessionId) => {
          const row = meta.get(sessionId);
          const label = workspaceLabel(row?.cwd);
          return label !== undefined ? label : t('overview.workspaceUnknown');
        };

        return h('div', { className: 'dql-ov' },
          h('div', { className: 'dql-ov-head' },
            h('div', null,
              h('h2', { className: 'dql-ov-title' }, t('overview.title')),
              h('p', { className: 'dql-ov-sub' }, t('overview.subtitle')),
            ),
            h('div', { className: 'dql-ov-totals' },
              h('span', { className: 'dql-chip dql-chip-open' }, t('overview.totalsOpen', { count: totals.open })),
              h('span', { className: 'dql-chip dql-chip-done' }, t('overview.totalsDone', { count: totals.done })),
              h('span', { className: 'dql-chip' }, t('overview.totalsSessions', { count: totals.sessions })),
              h('div', { className: 'dql-head-actions' },
                h('button', {
                  type: 'button', className: 'dql-btn dql-btn-ghost',
                  onClick: () => { void refresh(); },
                }, t('overview.refresh')),
              ),
            ),
          ),

          error !== undefined ? h('div', { className: 'dql-banner dql-banner-error' },
            h('span', null, t('overview.failed', { message: error })),
            h('button', {
              type: 'button', className: 'dql-banner-close', 'aria-label': 'dismiss',
              onClick: () => setError(undefined),
            }, '×'),
          ) : null,

          h('div', { className: 'dql-ov-section' }, h('span', null, t('overview.sessions'))),

          h('div', { className: 'dql-ov-list' },
            !loaded
              ? h('div', { className: 'dql-loading' }, t('overview.loading'))
              : rows.length === 0
                ? h('div', { className: 'dql-ov-empty' },
                  h('p', { className: 'dql-empty-title' }, t('overview.emptyTitle')),
                  h('p', null, t('overview.empty')))
                : rows.map((row) => h('button', {
                  key: row.sessionId,
                  type: 'button',
                  className: 'dql-ov-row',
                  title: t('overview.openHint'),
                  onClick: () => { openSession(ctx, row.sessionId); },
                },
                h('div', { className: 'dql-ov-main' },
                  h('div', { className: 'dql-ov-name' }, titleOf(row.sessionId)),
                  h('div', { className: 'dql-ov-meta' }, t('overview.rowMeta', {
                    where: whereOf(row.sessionId),
                    time: formatTime(row.updatedAt) || '—',
                  })),
                ),
                h('div', { className: 'dql-ov-counts' },
                  h('span', { className: 'dql-chip dql-chip-open' }, t('overview.rowCounts', { open: row.open, done: row.done })),
                ),
                )),
          ),

          h('div', { className: 'dql-ov-foot' }, t('overview.hint')),
        );
      }

      // ------------------------------------------------------------------
      // 插件体
      // ------------------------------------------------------------------
      function apply(ctx) {
        bindLocale(ctx);
        installStyles(ctx);

        const slots = ctx.get('slots');
        if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-quest-log] slots service missing; panel disabled');
          return;
        }

        const register = (slot, options, component, label) => {
          try {
            ctx.effect(
              () => slots.inject(slot, () => slots.register({ name: slot, ...options }, component)),
              label,
            );
          } catch (error) {
            console.warn(`[dsh-quest-log] could not register ${slot}:`, error?.message ?? error);
          }
        };

        register('sidebar.panellist', {
          id: PANEL_ID,
          order: 42,
          label: () => translateCurrent('overview.title'),
        }, (props) => h(QuestLogIcon, { size: props?.size ?? 16 }), 'dsh-quest-log: sidebar entry');

        register('main', { key: PANEL_ID }, (props) => h(QuestOverviewPage, { ctx, ...props }), 'dsh-quest-log: overview page');

        // 右侧边栏标签页：类型 + 看板本体 + 标题。sidebarRightTabs 可能晚于
        // 本插件 provide，所以用 ctx.inject 等它就绪后再注册。
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.get('sidebarRightTabs');
          if (tabs === undefined || typeof tabs.register !== 'function') {
            console.warn('[dsh-quest-log] sidebarRightTabs service missing; quest board tab not registered');
            return;
          }
          scope.effect(() => tabs.register({
            id: MODULE_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => translateCurrent('board.tabTitle'),
            guide: [
              {
                id: 'open',
                order: 45,
                title: () => translateCurrent('board.guideTitle'),
                description: () => translateCurrent('board.guideDescription'),
              },
            ],
          }), 'dsh-quest-log: right sidebar tab type');
        });

        register(
          'sidebar.right.pane.tab',
          { key: MODULE_ID, locale: NS },
          (props) => h(QuestBoardTab, { ctx, sessionId: props?.sessionId }),
          'dsh-quest-log: quest board tab body',
        );
        register(
          'sidebar.right.pane.tab.title',
          { key: MODULE_ID, locale: NS },
          QuestBoardTabTitle,
          'dsh-quest-log: quest board tab title',
        );
      }

      return {
        inject: ['slots', 'locale'],
        apply,
        // 仅用于冒烟测试；宿主不会读取。
        __test: {
          DICT,
          QuestBoard,
          QuestOverviewPage,
          QuestBoardTab,
          QuestBoardTabTitle,
          QuestLogIcon,
          shortSession,
          workspaceLabel,
          formatTime,
          fallbackTranslate,
        },
      };
    },
  });
})();
