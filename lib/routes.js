/**
 * 面板用的回环 HTTP 路由。
 *
 * 客户端面板走 `fetch('/dsh-quest-log/api?...')`，与 Agent 工具共享同一份
 * QuestStore 操作；这里只做参数校验、会话校验和 JSON 包装。
 *
 * 只服务于本机回环连接：远程连接（pocket 隧道以外）直接 403。
 *
 * @module dsh-quest-log/routes
 */

/** 路由前缀。 */
export const ROUTE = '/dsh-quest-log';

/** 请求体上限，任务说明够用了。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 判断请求是否来自本机回环。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否回环。
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.');
}

/**
 * 读完整请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<string>} 文本。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {unknown} value 响应体。
 * @param {number} [status] HTTP 状态码。
 * @returns {void}
 */
export function sendJson(res, value, status = 200) {
  try {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (error) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    } catch {
      /* 响应已断开 */
    }
  }
}

/**
 * 校验会话 id 参数。
 * @param {unknown} value 输入。
 * @returns {string|undefined} 合法会话 id。
 */
function sessionIdOf(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 300 ? value.trim() : undefined;
}

/**
 * 面板操作表。
 * @param {import('./store.js').QuestStore} store 台账存储。
 * @returns {Record<string, (payload: object) => object>} op → 处理函数。
 */
export function createOperations(store) {
  const fail = (error) => ({ ok: false, error });

  return {
    ping() {
      return { ok: true, plugin: 'dsh-quest-log', version: 1 };
    },

    list(payload) {
      const sessionId = sessionIdOf(payload?.sessionId);
      if (sessionId === undefined) return fail('缺少 sessionId');
      const status = payload?.status === 'open' || payload?.status === 'done' ? payload.status : undefined;
      return {
        ok: true,
        sessionId,
        quests: store.list(sessionId, status === undefined ? {} : { status }),
        stats: store.stats(sessionId),
      };
    },

    add(payload) {
      const sessionId = sessionIdOf(payload?.sessionId);
      if (sessionId === undefined) return fail('缺少 sessionId');
      if (typeof payload?.title !== 'string' || payload.title.trim() === '') return fail('任务标题不能为空');
      const result = store.add(sessionId, {
        title: payload.title,
        detail: typeof payload.detail === 'string' ? payload.detail : undefined,
        source: 'user',
      });
      if (!result.ok) return fail(result.error);
      return { ok: true, quest: result.quest, stats: store.stats(sessionId) };
    },

    update(payload) {
      const sessionId = sessionIdOf(payload?.sessionId);
      if (sessionId === undefined) return fail('缺少 sessionId');
      if (typeof payload?.id !== 'string' || payload.id.trim() === '') return fail('缺少任务 id');
      const patch = {};
      if (typeof payload.title === 'string') patch.title = payload.title;
      if (typeof payload.detail === 'string') patch.detail = payload.detail;
      if (payload.status === 'open' || payload.status === 'done') patch.status = payload.status;
      const result = store.update(sessionId, payload.id, patch, 'user');
      if (!result.ok) return fail(result.error);
      return { ok: true, quest: result.quest, stats: store.stats(sessionId) };
    },

    remove(payload) {
      const sessionId = sessionIdOf(payload?.sessionId);
      if (sessionId === undefined) return fail('缺少 sessionId');
      if (typeof payload?.id !== 'string' || payload.id.trim() === '') return fail('缺少任务 id');
      const result = store.remove(sessionId, payload.id, 'user');
      if (!result.ok) return fail(result.error);
      return { ok: true, quest: result.quest, stats: store.stats(sessionId) };
    },

    clearDone(payload) {
      const sessionId = sessionIdOf(payload?.sessionId);
      if (sessionId === undefined) return fail('缺少 sessionId');
      const result = store.clearDone(sessionId, 'user');
      return { ok: true, removed: result.removed, stats: store.stats(sessionId) };
    },
  };
}

/**
 * 挂载回环路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 已注入 webServer 的上下文。
 * @param {{store: import('./store.js').QuestStore, logger?: object}} options 选项。
 * @returns {void}
 */
export function mountRoutes(ctx, options) {
  const webServer = ctx?.webServer ?? ctx?.get?.('webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[dsh-quest-log] webServer service missing; panel API disabled');
    return;
  }
  const store = options.store;
  const operations = createOperations(store);
  const logger = options.logger;

  try {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        if (!isLoopback(req)) {
          sendJson(res, { ok: false, error: '仅支持本机回环访问' }, 403);
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : '';
        try {
          if (req.method === 'GET') {
            const op = pathname === '/api' || pathname === '' ? url.searchParams.get('op') ?? 'ping' : pathname.replace(/^\//u, '');
            const handler = operations[op];
            if (handler === undefined) {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const payload = Object.fromEntries(url.searchParams.entries());
            const result = await handler(payload);
            sendJson(res, result, result.ok ? 200 : 400);
            return;
          }
          if (req.method === 'POST') {
            let body = {};
            const raw = await readBody(req);
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                sendJson(res, { ok: false, error: '无效的 JSON 请求体' }, 400);
                return;
              }
            }
            const op = typeof body?.op === 'string' ? body.op : pathname.replace(/^\//u, '');
            const handler = operations[op];
            if (handler === undefined) {
              sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
              return;
            }
            const result = await handler(body ?? {});
            sendJson(res, result, result.ok ? 200 : 400);
            return;
          }
          sendJson(res, { ok: false, error: '只支持 GET 与 POST' }, 405);
        } catch (error) {
          logger?.warn?.(`[dsh-quest-log] route error: ${error?.stack ?? error}`);
          sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        }
      },
    }), 'dsh-quest-log: panel routes');
  } catch (error) {
    logger?.warn?.(`[dsh-quest-log] could not mount panel routes: ${error?.message ?? error}`);
  }
}
