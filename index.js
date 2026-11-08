/**
 * Host half of the thinking-effort bundle.
 *
 * Owns the two inputs that the page cannot compute:
 *   - the importance score (one small judge call against the anchor question,
 *     or the active goal objective when a goal is running);
 *   - the deterministic failure score folded from Session events.
 *
 * It exposes one same-origin JSON route, /thinking-effort/evaluate, that the
 * Client half calls while `auto` is on. The route maps the weighted total onto
 * the model's real effort list and, when asked, applies the target through
 * sessionController.selectModel.
 *
 * Everything is optional and defensive: a missing service, a cold session, a
 * failing judge or a model without effort levels returns a structured failure
 * instead of throwing, so the Client half keeps its manual controls.
 */

const ROUTE_PATH = '/thinking-effort/evaluate';
const TURNS_PATH = '/thinking-effort/turns';
const MAX_BODY_BYTES = 32 * 1024;

/** Delay activation until the HTTP carrier exists; otherwise apply runs first and
 *  `ctx.get('webServer')` is undefined, which silently drops the route. */
export const inject = ['webServer'];

export const name = 'thinking-effort';

function readWeights(config) {
  const source = (config && typeof config === 'object' && config.weights) || {};
  const importance = Number(source.importance);
  const failure = Number(source.failure);
  const importanceWeight = Number.isFinite(importance) && importance >= 0 ? importance : 1;
  const failureWeight = Number.isFinite(failure) && failure >= 0 ? failure : 1;
  if (importanceWeight === 0 && failureWeight === 0) {
    return { importanceWeight: 1, failureWeight: 1 };
  }
  return { importanceWeight, failureWeight };
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer');
  if (!webServer) return;

  const weights = readWeights(config);

  const state = {
    judgeCache: new Map(),
    inflight: new Map(),
  };

  function json(res, status, body) {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let raw = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
          req.destroy();
          finish({});
        }
      });
      req.on('end', () => {
        try {
          finish(raw ? JSON.parse(raw) : {});
        } catch {
          finish({});
        }
      });
      req.on('error', () => finish({}));
      req.on('aborted', () => finish({}));
    });
  }

  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site === undefined) return true;
    return site === 'same-origin' || site === 'none';
  }

  /* ----------------------------- catalog ----------------------------- */

  function resolveLevels(catalog, provider, modelId) {
    const groups = (catalog && catalog.groups) || [];
    for (const group of groups) {
      if (group.id !== provider) continue;
      for (const model of group.models || []) {
        if (model.id !== modelId) continue;
        const efforts = (model.reasoning && model.reasoning.efforts) || [];
        return { model, efforts };
      }
    }
    return null;
  }

  function fallbackSelection(catalog) {
    return (catalog && catalog.default) || null;
  }

  /* --------------------------- failure score --------------------------- */

  function failureScore(session) {
    let events;
    try {
      events = session.snapshotEvents();
    } catch {
      return { score: 0, repeats: 0, turnError: 0, turn: 0 };
    }

    let turn = 0;
    let lastTurn = 0;
    const calls = new Map();
    const repeats = new Map();
    let turnError = 0;

    for (const event of events) {
      const data = event.data || {};
      if (event.type === 'turn/start') {
        if (typeof data.turn === 'number') {
          turn = data.turn;
          lastTurn = Math.max(lastTurn, turn);
        }
        continue;
      }
      if (event.type === 'turn/end') {
        if (typeof data.turn === 'number') {
          lastTurn = Math.max(lastTurn, data.turn);
          if (data.turn === lastTurn && data.reason && data.reason.kind === 'error') turnError = 1;
        }
        continue;
      }
      if (event.type === 'tool/call') {
        calls.set(data.callId, {
          name: data.name,
          digest: String(data.arguments || '').replace(/\s+/g, ' ').slice(0, 160),
        });
        continue;
      }
      if (event.type === 'tool/result' && turn === lastTurn) {
        const failed = Boolean(data.error) || Boolean(data.message && data.message.isError);
        if (!failed) continue;
        const call = calls.get(data.callId);
        if (!call) continue;
        const key = call.name + '\u0000' + call.digest;
        const count = (repeats.get(key) || 0) + 1;
        repeats.set(key, count);
      }
    }

    let repeatGroups = 0;
    for (const count of repeats.values()) {
      if (count >= 2) repeatGroups += 1;
    }

    return {
      score: Math.min(5, repeatGroups * 2 + turnError * 2),
      repeats: repeatGroups,
      turnError,
      turn: lastTurn,
    };
  }

  /* -------------------------- importance score -------------------------- */

  function textOf(message) {
    const content = message && message.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  function userTexts(session) {
    try {
      return session
        .deriveMessages()
        .filter((message) => message.role === 'user')
        .map(textOf)
        .filter((text) => text && text.length > 0);
    } catch {
      return [];
    }
  }

  function goalObjective(sessionId) {
    try {
      const goals = ctx.get('goals');
      const agents = ctx.get('agents');
      if (!goals || !agents) return null;
      const agent = agents.get(sessionId);
      if (!agent) return null;
      const view = goals.get(agent);
      if (!view || view.phase !== 'active' || !view.objective) return null;
      return view.objective;
    } catch {
      return null;
    }
  }

  function lowestEffort(efforts) {
    /* 判分只想要一行 JSON：优先关掉推理，避免推理 token 吃光 maxTokens、正文为空 */
    for (const wanted of ['off', 'none', 'minimal', 'low']) {
      const found = efforts.find((item) => item.id === wanted);
      if (found) return found.id;
    }
    return efforts.length ? efforts[efforts.length - 1].id : undefined;
  }

  async function collectText(stream) {
    let text = '';
    for await (const chunk of stream) {
      if ((chunk && chunk.type === 'text-delta') || (chunk && chunk.type === 'reasoning-delta')) {
        if (typeof chunk.text === 'string') text += chunk.text;
        if (text.length > 4000) break;
      }
    }
    return text;
  }

  function parseScore(text) {
    if (!text) return null;
    const trimmed = text.trim();
    const candidates = [];
    const braced = trimmed.match(/\{[\s\S]*\}/);
    if (braced) candidates.push(braced[0]);
    candidates.push(trimmed);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const value = Number(parsed.score);
        if (Number.isFinite(value)) return Math.max(0, Math.min(10, Math.round(value)));
      } catch {
        /* try the next shape */
      }
    }
    /* 模型偶尔只回一个数字或 "score: 7" */
    const match = trimmed.match(/score\s*[:：=]?\s*(-?\d{1,2})/i) || trimmed.match(/^\s*(-?\d{1,2})\s*$/);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(10, Math.round(value)));
    }
    return null;
  }

  async function importantScore(session, sessionId, selection, efforts) {
    const texts = userTexts(session);
    const anchor = goalObjective(sessionId) || texts[0] || '';
    const current = texts.length ? texts[texts.length - 1] : '';
    if (!anchor || !current) return { score: 5, reason: 'no-anchor', cached: false };

    const key = sessionId + ':' + selection.model + ':' + texts.length + ':' + current.slice(0, 60);
    const cached = state.judgeCache.get(key);
    if (cached && Date.now() - cached.at < 90_000) {
      return { score: cached.score, reason: cached.reason, cached: true };
    }
    if (state.inflight.has(key)) return state.inflight.get(key);

    const llm = ctx.get('llm');
    if (!llm) return { score: 5, reason: 'no-llm', cached: false };

    const prompt = [
      '你在为一个编码助手评估"当前任务相对锚点的距离"。',
      '锚点（最初的问题或当前目标）：',
      anchor.slice(0, 2000),
      '',
      '最近的用户消息：',
      texts.slice(-3).map((text, index) => `${index + 1}. ${text.slice(0, 1200)}`).join('\n'),
      '',
      '规则：越贴近锚点、影响面越大 → 分数越高；越偏离锚点、越是边角/探索 → 分数越低。',
      '只输出一行 JSON：{"score": 0-10, "reason": "不超过 12 个字"}。不要输出别的。',
    ].join('\n');

    const request = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: lowestEffort(efforts),
      temperature: 0,
      maxTokens: 300,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };

    const task = (async () => {
      try {
        const stream = llm.stream(request);
        const text = await collectText(stream);
        const score = parseScore(text);
        if (score === null) {
          return { score: 5, reason: 'unparsed', raw: text.slice(0, 160), cached: false };
        }
        state.judgeCache.set(key, { at: Date.now(), score, reason: 'judge' });
        return { score, reason: 'judge', cached: false };
      } catch (error) {
        return { score: 5, reason: 'judge-error', cached: false, error: String(error && error.message ? error.message : error) };
      } finally {
        state.inflight.delete(key);
      }
    })();

    state.inflight.set(key, task);
    return task;
  }

  /* ---------------------------- evaluation ---------------------------- */

  async function evaluate(request) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    const sessions = ctx.get('sessions');
    const sessionController = ctx.get('sessionController');
    if (!sessionId) return { ok: false, error: 'missing-session' };
    if (!sessions || !sessionController) return { ok: false, error: 'missing-service' };
    if (typeof sessionController.modelCatalog !== 'function' || typeof sessionController.selectModel !== 'function') {
      return { ok: false, error: 'controller-unsupported' };
    }

    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'session-not-live' };

    let catalog;
    try {
      catalog = await sessionController.modelCatalog();
    } catch (error) {
      return { ok: false, error: 'catalog-failed', detail: String(error && error.message ? error.message : error) };
    }

    let header = null;
    try {
      header = session.requestHeader();
    } catch {
      header = null;
    }
    const config = (header && header.config) || {};
    const fallback = fallbackSelection(catalog) || {};
    /* 客户端带上它此刻选中的 provider/model：请求头是上一轮的，模型刚换过时会引起回退 */
    const requestedProvider = typeof request.provider === 'string' ? request.provider : '';
    const requestedModel = typeof request.model === 'string' ? request.model : '';

    let provider = requestedProvider || config.provider || fallback.provider;
    let model = requestedModel || config.model || fallback.model;
    if (!provider || !model) return { ok: false, error: 'no-selection' };

    let resolved = resolveLevels(catalog, provider, model);
    if (!resolved && requestedProvider) {
      provider = config.provider || fallback.provider;
      model = config.model || fallback.model;
      resolved = resolveLevels(catalog, provider, model);
    }
    if (!resolved || !resolved.efforts.length) {
      return { ok: false, error: 'no-efforts', provider, model };
    }

    const failure = failureScore(session);
    const importance = await importantScore(session, sessionId, { provider, model }, resolved.efforts);

    const importanceWeight = weights.importanceWeight;
    const failureWeight = weights.failureWeight;
    const total = importanceWeight * importance.score + failureWeight * failure.score;
    const maximum = importanceWeight * 10 + failureWeight * 5;
    const interval = maximum / resolved.efforts.length;
    const index = Math.max(0, Math.min(resolved.efforts.length - 1, Math.floor(total / interval)));
    const target = resolved.efforts[index].id;

    let applied = false;
    let applyError = null;
    if (request.apply === true) {
      try {
        await sessionController.selectModel({ sessionId, provider, model, reasoningEffort: target });
        applied = true;
      } catch (error) {
        applyError = String(error && error.message ? error.message : error);
      }
    }

    return {
      ok: true,
      provider,
      model,
      levels: resolved.efforts.map((item) => ({ id: item.id, name: item.name })),
      importance: importance.score,
      importanceReason: importance.reason,
      ...(importance.raw ? { importanceRaw: importance.raw } : {}),
      failure: failure.score,
      failureDetail: { repeats: failure.repeats, turnError: failure.turnError, turn: failure.turn },
      total,
      maximum,
      interval,
      weights: { importance: importanceWeight, failure: failureWeight },
      index,
      target,
      applied,
      applyError,
    };
  }

  /* ---------------------------- turn efforts ---------------------------- */

  /* 每一轮真正用来发请求的档位来自 request/header 事件；用 turn/start 区间归属，
     并记住该轮 turn/end 的 seq，供客户端把轮尾标签对上来。 */
  function turnEfforts(session) {
    const byTurn = new Map();
    let turn = 0;
    let events;
    try {
      events = session.snapshotEvents();
    } catch {
      return null;
    }
    for (const event of events) {
      const data = event.data || {};
      if (event.type === 'turn/start' && typeof data.turn === 'number') {
        turn = data.turn;
        continue;
      }
      if (event.type === 'turn/end' && typeof data.turn === 'number') {
        const record = byTurn.get(data.turn);
        if (record) record.endSeq = event.seq;
        continue;
      }
      if (event.type !== 'request/header' || !turn) continue;
      const config = data.header && data.header.config;
      if (!config) continue;
      byTurn.set(turn, {
        turn,
        effort: config.reasoningEffort || null,
        provider: config.provider || null,
        model: config.model || null,
        at: event.time || null,
        seq: event.seq,
      });
    }
    return [...byTurn.values()];
  }

  async function turns(request) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
    const sessions = ctx.get('sessions');
    if (!sessionId) return { ok: false, error: 'missing-session' };
    if (!sessions) return { ok: false, error: 'missing-service' };
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'session-not-live' };
    const list = turnEfforts(session);
    if (!list) return { ok: false, error: 'events-unavailable' };
    return { ok: true, turns: list };
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, error: 'cross-origin' });
          return;
        }
        const body = await readJson(req);
        const result = await evaluate(body);
        json(res, result.ok ? 200 : 200, result);
      } catch (error) {
        json(res, 200, {
          ok: false,
          error: 'internal',
          detail: String(error && error.message ? error.message : error),
        });
      }
    },
  });

  const disposeTurns = webServer.register({
    kind: 'exact',
    path: TURNS_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        if (!sameOrigin(req)) {
          json(res, 403, { ok: false, error: 'cross-origin' });
          return;
        }
        const body = await readJson(req);
        json(res, 200, await turns(body));
      } catch (error) {
        json(res, 200, {
          ok: false,
          error: 'internal',
          detail: String(error && error.message ? error.message : error),
        });
      }
    },
  });

  ctx.effect(() => () => {
    for (const close of [dispose, disposeTurns]) {
      try {
        close();
      } catch {
        /* already disposed */
      }
    }
    state.judgeCache.clear();
    state.inflight.clear();
  });
}
