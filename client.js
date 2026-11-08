window.__ModuleLoader__.load({
  id: '@local/thinking-effort',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = null; }

    const AUTO_KEY_PREFIX = 'thinking-effort:auto:';
    const NO_REPLACE_KEY = 'thinking-effort:no-replace';
    const AUTO_LABEL = 'Auto';

    /** One mounted seat owns the global ← → shortcut at a time. */
    const cycleRegistry = { fn: null, inDialog: false };

    /** 每轮标签在 auto 关闭后的淡出期间要显示的字：按 session+seq 记住，
     *  即使组件被重新挂载也不会丢。 */
    const autoLabels = new Map();

    /* ------------------------------------------------------------------ *
     * auto scoring bridge: ask the Host half to evaluate this session
     * ------------------------------------------------------------------ */

    const evalState = {
      routeDown: false,
      inflight: false,
      lastKey: '',
      timer: 0,
      latest: null,
    };

    async function postEvaluate(sessionId, applyTarget) {
      const response = await fetch('/thinking-effort/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId, apply: applyTarget === true }),
      });
      if (response.status === 404 || response.status === 405) {
        evalState.routeDown = true;
        try {
          window.dispatchEvent(new CustomEvent('thinking-effort:route-down'));
        } catch {
          /* ignore */
        }
        return { ok: false, error: 'route-unavailable' };
      }
      if (!response.ok) return { ok: false, error: 'http-' + response.status };
      return response.json();
    }

    async function runScheduledEval() {
      const target = evalState.latest;
      if (!target || evalState.inflight || evalState.routeDown) return;
      const key = target.sessionId + ':' + target.key;
      if (key === evalState.lastKey) return;
      evalState.inflight = true;
      try {
        const result = await postEvaluate(target.sessionId, true);
        if (result && result.ok) {
          evalState.lastKey = key;
          window.dispatchEvent(new CustomEvent('thinking-effort:evaluated', { detail: result }));
        }
      } catch {
        /* network failure: keep the manual controls, try again on the next turn */
      } finally {
        evalState.inflight = false;
      }
    }

    function scheduleAutoEval(sessionId, key) {
      if (!sessionId || evalState.routeDown) return;
      evalState.latest = { sessionId, key: String(key) };
      clearTimeout(evalState.timer);
      evalState.timer = setTimeout(runScheduledEval, 600);
    }

    function evaluateNow(sessionId, key) {
      if (!sessionId || evalState.routeDown) return;
      evalState.latest = { sessionId, key: String(key) };
      clearTimeout(evalState.timer);
      runScheduledEval();
    }

    /* ------------------------------------------------------------------ *
     * per-turn history: the effort each turn actually sent (request/header)
     * ------------------------------------------------------------------ */

    const turnsState = { bySession: new Map(), inflight: new Map(), listeners: new Set() };

    function notifyTurns() {
      for (const listener of turnsState.listeners) listener();
    }

    async function ensureTurns(sessionId, seq) {
      if (!sessionId) return;
      const cached = turnsState.bySession.get(sessionId);
      let covered = false;
      if (cached && typeof seq === 'number') {
        for (const entry of cached.bySeq.values()) {
          if (entry.endSeq <= seq) { covered = true; break; }
        }
      }
      const fresh = cached && Date.now() - cached.at < 10_000;
      if (cached && fresh && (typeof seq !== 'number' || covered)) return;
      if (turnsState.inflight.has(sessionId)) return;
      const task = (async () => {
        try {
          const response = await fetch('/thinking-effort/turns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId }),
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!data || data.ok !== true || !Array.isArray(data.turns)) return;
          const bySeq = new Map();
          const byTurn = new Map();
          for (const entry of data.turns) {
            if (!entry) continue;
            if (typeof entry.endSeq === 'number') bySeq.set(entry.endSeq, entry);
            if (typeof entry.turn === 'number') byTurn.set(entry.turn, entry);
          }
          turnsState.bySession.set(sessionId, { at: Date.now(), bySeq, byTurn });
          notifyTurns();
        } catch {
          /* the live label stays as the fallback */
        } finally {
          turnsState.inflight.delete(sessionId);
        }
      })();
      turnsState.inflight.set(sessionId, task);
    }

    function turnRecord(sessionId, seq, turnProp) {
      const cache = turnsState.bySession.get(sessionId);
      if (!cache) return null;
      if (typeof seq === 'number') {
        if (cache.bySeq.has(seq)) return cache.bySeq.get(seq);
        /* seq 可能不是轮尾那一条：取 endSeq 不超过它的最后一轮 */
        let best = null;
        for (const entry of cache.bySeq.values()) {
          if (entry.endSeq <= seq && (!best || entry.endSeq > best.endSeq)) best = entry;
        }
        if (best) return best;
      }
      const turn = typeof turnProp === 'number' ? turnProp : (turnProp && typeof turnProp.turn === 'number' ? turnProp.turn : null);
      return turn !== null && cache.byTurn.has(turn) ? cache.byTurn.get(turn) : null;
    }

    function stem(key) {
      return key ? String(key).split(':').pop() : '';
    }

    function autoKey(sessionId) {
      return AUTO_KEY_PREFIX + (sessionId || '');
    }

    function readAuto(sessionId) {
      try {
        return window.localStorage.getItem(autoKey(sessionId)) === '1';
      } catch {
        return false;
      }
    }

    function writeAuto(sessionId, on) {
      try {
        if (on) window.localStorage.setItem(autoKey(sessionId), '1');
        else window.localStorage.removeItem(autoKey(sessionId));
      } catch {
        /* storage is optional */
      }
      try {
        window.dispatchEvent(new CustomEvent('thinking-effort:auto-changed', { detail: { sessionId } }));
      } catch {
        /* ignore */
      }
    }

    function groupsOf(state) {
      return state && Array.isArray(state.groups) ? state.groups : [];
    }

    function findModel(state, provider, modelId) {
      if (!provider || !modelId) return null;
      for (const group of groupsOf(state)) {
        if (!group || group.id !== provider) continue;
        for (const model of group.models || []) {
          if (model.id === modelId) return model;
        }
      }
      return null;
    }

    function effortsOf(model) {
      return (model && model.reasoning && Array.isArray(model.reasoning.efforts)) ? model.reasoning.efforts : [];
    }

    function middleEffort(model) {
      const efforts = effortsOf(model);
      if (!efforts.length) return null;
      return efforts[Math.max(0, Math.min(efforts.length - 1, Math.floor((efforts.length - 1) / 2)))];
    }

    function effortName(model, effortId) {
      if (!effortId) return null;
      const found = effortsOf(model).find((item) => item.id === effortId);
      return found ? (found.name || stem(found.id)) : stem(effortId);
    }

    /* ------------------------------------------------------------------ *
     * styles — no plate, no canvas: one word with the enchant rainbow
     * ------------------------------------------------------------------ */

    const CSS = `
.tef-wrap { position: relative; display: inline-flex; align-items: center; }
@keyframes tef-hueflow { 0% { background-position: 0% 0; } 100% { background-position: 300% 0; } }
.tef-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l1, #303038); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #1e1e23); color: var(--dsw-alias-label-primary, #e6e6ee);
  font: 12px/1 var(--dsw-font-sans, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
  cursor: pointer; white-space: nowrap; max-width: 360px;
}
.tef-btn:hover { background: var(--dsw-alias-bg-layer-2, #26262d); }
.tef-btn[disabled] { opacity: .55; cursor: default; }
.tef-btn .tef-model { max-width: 210px; overflow: hidden; text-overflow: ellipsis; }
/* 小字滑动：只在这一小段里切，不再有浮在按钮上方的大字 */
.tef-eff-slot {
  position: relative; display: inline-block;
  width: 52px; height: 22px; overflow: hidden;
  line-height: 22px; vertical-align: middle;
}
.tef-eff {
  position: absolute; left: 0; right: 0; top: 0;
  text-align: center; white-space: nowrap;
  font-weight: 600; line-height: 22px;
  background-image: linear-gradient(115deg, #22d3ee 0%, #38bdf8 18%, #818cf8 38%, #c084fc 52%, #22d3ee 66%, #2dd4bf 82%, #38bdf8 100%);
  background-size: 300% 100%;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: tef-hueflow 4.6s linear infinite;
  filter:
    drop-shadow(0 0 3px rgba(56, 189, 248, .55))
    drop-shadow(0 0 8px rgba(129, 140, 248, .28));
}
.tef-eff-old[data-dir="1"] { animation: tef-eff-out-left .28s cubic-bezier(.2,.7,.3,1) forwards; }
.tef-eff-old[data-dir="-1"] { animation: tef-eff-out-right .28s cubic-bezier(.2,.7,.3,1) forwards; }
.tef-eff-new[data-dir="1"] { animation: tef-eff-in-right .28s cubic-bezier(.2,.7,.3,1); }
.tef-eff-new[data-dir="-1"] { animation: tef-eff-in-left .28s cubic-bezier(.2,.7,.3,1); }
@keyframes tef-eff-out-left { from { transform: translateX(0); opacity: 1; } to { transform: translateX(-110%); opacity: 0; } }
@keyframes tef-eff-out-right { from { transform: translateX(0); opacity: 1; } to { transform: translateX(110%); opacity: 0; } }
@keyframes tef-eff-in-right { from { transform: translateX(110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes tef-eff-in-left { from { transform: translateX(-110%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.tef-dot-sep { color: var(--dsw-alias-label-secondary, #5f5f68); }
.tef-pop {
  position: fixed; z-index: 200; width: 268px; overflow: auto; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, #303038); border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, #1b1b20); color: var(--dsw-alias-label-primary, #e6e6ee);
  box-shadow: 0 16px 36px rgba(0,0,0,.42);
  font: 12px/1.4 var(--dsw-font-sans, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
}
.tef-group { padding: 6px 8px 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a93); }
.tef-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.tef-item:hover { background: var(--dsw-alias-bg-layer-2, #26262d); }
.tef-item[data-on="1"] { color: var(--dsw-alias-brand-primary, #a9c0ff); }
.tef-item .tef-check { font-size: 11px; opacity: .8; }
.tef-sep { margin: 6px 8px; border-top: 1px solid var(--dsw-alias-border-l1, #303038); }
.tef-effort-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px 8px; }
.tef-chip {
  border: 1px solid var(--dsw-alias-border-l1, #303038); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #b9b9c2);
  font: 11px/1 var(--dsw-font-sans, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
  padding: 5px 8px; cursor: pointer;
}
.tef-chip[data-on="1"] { border-color: var(--dsw-alias-brand-primary, #7aa2ff); color: var(--dsw-alias-brand-primary, #cfe0ff); }
.tef-msg { padding: 6px 8px; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #e0b050); }
.tef-mini {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, #303038); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #1e1e23); color: var(--dsw-alias-label-secondary, #b9b9c2);
  font: 11px/1 var(--dsw-font-sans, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif); cursor: pointer;
}
.tef-mini .tef-effort {
  font-weight: 600;
  background-image: linear-gradient(115deg, #22d3ee, #38bdf8 30%, #818cf8 60%, #c084fc 80%, #2dd4bf 100%);
  background-size: 300% 100%;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: tef-hueflow 4.6s linear infinite;
}
.tef-turn {
  display: flex; align-items: center; gap: 7px;
  max-height: 0; opacity: 0; overflow: hidden;
  padding: 0 2px;
  font: 700 13px/18px var(--dsw-font-sans, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
  letter-spacing: 1.4px;
  transition: max-height .3s ease, opacity .3s ease, padding .3s ease;
}
.tef-turn[data-on="1"] {
  max-height: 38px; opacity: 1;
  padding: 4px 2px 6px;
}
.tef-turn .tef-tag {
  display: inline-block; white-space: nowrap;
  line-height: 18px; padding: 1px 0 2px;
  background-image: linear-gradient(115deg, #22d3ee 0%, #38bdf8 18%, #818cf8 38%, #c084fc 52%, #22d3ee 66%, #2dd4bf 82%, #38bdf8 100%);
  background-size: 300% 100%;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: tef-hueflow 4.6s linear infinite;
  filter:
    drop-shadow(0 0 3px rgba(56, 189, 248, .7))
    drop-shadow(0 0 8px rgba(129, 140, 248, .4))
    drop-shadow(0 0 14px rgba(34, 211, 238, .25));
}
@media (prefers-reduced-motion: reduce) {
  .tef-eff, .tef-eff-old, .tef-eff-new, .tef-mini .tef-effort, .tef-turn .tef-tag { animation: none; }
  .tef-turn { transition: none; }
}
`;

    function mountStyles(ctx) {
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-thinking-effort', '1');
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
      ctx.effect(() => () => { styleEl.remove(); });
    }

    /* ------------------------------------------------------------------ *
     * directory store
     * ------------------------------------------------------------------ */

    function useModelState(store) {
      const subscribe = React.useCallback((listener) => {
        if (!store || typeof store.subscribe !== 'function') return () => {};
        return store.subscribe(listener);
      }, [store]);
      const getSnapshot = React.useCallback(() => {
        if (!store || typeof store.getSnapshot !== 'function') return null;
        try {
          return store.getSnapshot();
        } catch {
          return null;
        }
      }, [store]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }

    /* ------------------------------------------------------------------ *
     * anchored popup
     * ------------------------------------------------------------------ */

    function Popup(props) {
      const [pos, setPos] = React.useState(null);
      const popRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const anchor = props.anchorRef && props.anchorRef.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const width = 268;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
        const top = Math.max(8, rect.top - 8 + -360);
        const maxHeight = Math.min(340, Math.max(120, rect.top - 16));
        setPos({ left, bottom: Math.max(8, window.innerHeight - rect.top + 6), maxHeight });
      }, [props.anchorRef]);

      React.useEffect(() => {
        const onDown = (event) => {
          const anchor = props.anchorRef && props.anchorRef.current;
          if (anchor && anchor.contains(event.target)) return;
          if (popRef.current && popRef.current.contains(event.target)) return;
          props.onClose();
        };
        window.addEventListener('mousedown', onDown, true);
        return () => window.removeEventListener('mousedown', onDown, true);
      }, [props]);

      if (!pos) return null;
      if (!ReactDOM || typeof ReactDOM.createPortal !== 'function') {
        return h('div', {
          className: 'tef-pop',
          style: { position: 'absolute', left: 0, bottom: 'calc(100% + 34px)', maxHeight: pos.maxHeight + 'px' },
        }, props.children);
      }
      return ReactDOM.createPortal(
        h('div', {
          ref: popRef,
          className: 'tef-pop',
          style: { left: pos.left + 'px', bottom: pos.bottom + 'px', maxHeight: pos.maxHeight + 'px' },
        }, props.children),
        document.body,
      );
    }

    /* ------------------------------------------------------------------ *
     * slot word with the reference slide transition
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * menu body
     * ------------------------------------------------------------------ */

    function MenuBody(props) {
      const state = props.state;
      const current = state && state.current ? state.current : null;
      const groups = groupsOf(state);
      const currentModel = current ? findModel(state, current.provider, current.model) : null;
      const efforts = effortsOf(currentModel);
      const failures = state && Array.isArray(state.failures) ? state.failures : [];

      return h('div', null,
        groups.length === 0 && !failures.length
          ? h('div', { className: 'tef-group' }, state && state.status === 'loading' ? '加载模型列表…' : '没有可用的模型')
          : null,
        groups.map((group) => h('div', { key: group.id },
          h('div', { className: 'tef-group' }, group.name || group.id),
          (group.models || []).map((model) => {
            const selected = current && current.provider === group.id && current.model === model.id;
            return h('div', {
              key: model.id,
              className: 'tef-item',
              'data-on': selected ? '1' : '0',
              onClick: () => props.onPickModel(group.id, model),
            },
              h('span', null, model.name || model.id),
              selected ? h('span', { className: 'tef-check' }, '✓') : null,
            );
          }),
        )),
        failures.length ? h('div', { className: 'tef-msg' }, failures.map((failure) => (failure.name || failure.id) + '：加载失败').join('；')) : null,
        efforts.length ? h('div', null,
          h('div', { className: 'tef-sep' }),
          h('div', { className: 'tef-group' }, '思考强度'),
          h('div', { className: 'tef-effort-row' },
            efforts.map((effort) => h('button', {
              key: effort.id,
              type: 'button',
              className: 'tef-chip',
              'data-on': !props.auto && current && current.reasoningEffort === effort.id ? '1' : '0',
              onClick: () => props.onPickEffort(effort),
            }, stem(effort.id))),
            h('button', {
              type: 'button',
              className: 'tef-chip',
              'data-on': props.auto ? '1' : '0',
              onClick: props.onAuto,
            }, AUTO_LABEL),
          ),
          props.auto && props.routeDown
            ? h('div', { className: 'tef-msg' }, '自动评分未连接：重启 DSH 后生效')
            : null,
        ) : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * the seat
     * ------------------------------------------------------------------ */

    /* 把滑动做进按钮里的小字：旧词横向滑出、新词滑入 */
    function SlidingEffort(props) {
      const [current, setCurrent] = React.useState(props.text);
      const [previous, setPrevious] = React.useState(null);
      const [dir, setDir] = React.useState(1);
      const timer = React.useRef(0);

      React.useEffect(() => {
        if (props.text === current) return undefined;
        setDir((props.direction || 1) >= 0 ? 1 : -1);
        setPrevious(current);
        setCurrent(props.text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setPrevious(null), 300);
        return () => clearTimeout(timer.current);
      }, [props.text]);

      React.useEffect(() => () => clearTimeout(timer.current), []);

      return h('span', { className: 'tef-eff-slot' },
        previous !== null
          ? h('span', { className: 'tef-eff tef-eff-old', 'data-dir': String(dir) }, previous)
          : null,
        h('span', {
          key: current,
          className: 'tef-eff' + (previous !== null ? ' tef-eff-new' : ''),
          'data-dir': String(dir),
        }, current),
      );
    }

    function ModelSeat(props) {
      const sessionId = props && props.sessionId;
      const state = useModelState(props && props.directory);
      const current = state && state.current ? state.current : null;
      const model = current ? findModel(state, current.provider, current.model) : null;
      const efforts = effortsOf(model);
      let effortsLabel = current ? effortName(model, current.reasoningEffort) : null;
      let modelLabel = model ? (model.name || model.id) : (current ? current.model : '模型');

      /* 切换过程中目录快照可能短暂没有 groups：沿用上一次的显示名，避免左边的模型名闪成 id */
      const labelCache = React.useRef({ key: '', label: '', effort: '' });
      if (current) {
        const key = current.provider + '/' + current.model;
        if (model) {
          labelCache.current = { key, label: modelLabel, effort: effortsLabel || '' };
        } else if (labelCache.current.key === key) {
          if (labelCache.current.label) modelLabel = labelCache.current.label;
          if (!effortsLabel && labelCache.current.effort) effortsLabel = labelCache.current.effort;
        }
      }

      const [open, setOpen] = React.useState(false);
      const busyRef = React.useRef(false);
      const [note, setNote] = React.useState(null);
      const [auto, setAuto] = React.useState(() => readAuto(sessionId));
      const [routeDown, setRouteDown] = React.useState(evalState.routeDown);
      const [direction, setDirection] = React.useState(1);
      const anchorRef = React.useRef(null);

      const load = props && props.load;
      const select = props && props.select;

      React.useEffect(() => {
        if (typeof load === 'function') {
          try { load(); } catch { /* ignore */ }
        }
      }, [props && props.directory]);

      React.useEffect(() => {
        const onChange = (event) => {
          if (!event.detail || event.detail.sessionId === sessionId) setAuto(readAuto(sessionId));
        };
        window.addEventListener('thinking-effort:auto-changed', onChange);
        return () => window.removeEventListener('thinking-effort:auto-changed', onChange);
      }, [sessionId]);

      React.useEffect(() => {
        const onDown = () => setRouteDown(true);
        window.addEventListener('thinking-effort:route-down', onDown);
        return () => window.removeEventListener('thinking-effort:route-down', onDown);
      }, []);

      /* Host 端 selectModel 之后刷新一次目录，让按钮显示评分选出的档位 */
      React.useEffect(() => {
        const onEvaluated = (event) => {
          if (!event.detail || event.detail.applied === false) return;
          if (typeof load === 'function') {
            try { load(); } catch { /* ignore */ }
          }
        };
        window.addEventListener('thinking-effort:evaluated', onEvaluated);
        return () => window.removeEventListener('thinking-effort:evaluated', onEvaluated);
      }, []);

      const submit = React.useCallback((next, autoMode) => {
        if (typeof select !== 'function') {
          setNote('目录不可用');
          return;
        }
        if (busyRef.current) return;
        busyRef.current = true;
        setNote(null);
        Promise.resolve(select(next)).then(
          (result) => {
            busyRef.current = false;
            if (result && result.ok === false) {
              setNote('切换失败：' + (result.error && result.error.message ? result.error.message : '未知错误'));
              return;
            }
            setAuto(autoMode);
            writeAuto(sessionId, autoMode);
            if (autoMode) evaluateNow(sessionId, 'select:' + Date.now());
          },
          (error) => {
            busyRef.current = false;
            setNote('切换失败：' + (error && error.message ? error.message : String(error)));
          },
        );
      }, [select, sessionId]);

      const pickEffort = React.useCallback((effort, autoMode) => {
        if (!current) return;
        submit({
          provider: current.provider,
          model: current.model,
          ...(effort && effort.id ? { reasoningEffort: effort.id } : {}),
        }, autoMode);
        setOpen(false);
      }, [current, submit]);

      const pickModel = React.useCallback((provider, nextModel) => {
        const effort = middleEffort(nextModel) || effortsOf(nextModel)[0];
        submit({
          provider,
          model: nextModel.id,
          ...(effort ? { reasoningEffort: effort.id } : {}),
        }, false);
        setOpen(false);
      }, [submit]);

      /* 档位阶梯 = 真实档位 + auto；← 减小、→ 增大，两端都不回绕。
         auto 排在最高档之上，所以 → 从最高档继续按会落到 auto，← 从 auto 回到最高档。 */
      const cycle = React.useCallback((step) => {
        if (!efforts.length || !current) return;
        const ids = efforts.map((item) => item.id);
        const ladder = ids.concat([AUTO_LABEL]);
        let index;
        if (auto) {
          index = ladder.length - 1;
        } else {
          const found = ids.indexOf(current.reasoningEffort);
          index = found >= 0 ? found : Math.floor((ids.length - 1) / 2);
        }
        const next = Math.max(0, Math.min(ladder.length - 1, index + step));
        if (next === index) return; // 到顶/到底：不循环
        setDirection(step);
        if (next === ladder.length - 1) {
          /* 进入 Auto：按规格冷启动到中间档，而不是沿用当前档（否则会一直停在 max） */
          const cold = middleEffort(model) || efforts[Math.floor((efforts.length - 1) / 2)];
          submit({
            provider: current.provider,
            model: current.model,
            ...(cold ? { reasoningEffort: cold.id } : {}),
          }, true);
        } else {
          pickEffort(efforts[next], false);
        }
      }, [efforts, current, auto, model, submit, pickEffort]);

      const onKey = React.useCallback((event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); cycle(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); cycle(1); }
      }, [cycle]);

      React.useEffect(() => {
        cycleRegistry.fn = cycle;
        return () => {
          if (cycleRegistry.fn === cycle) cycleRegistry.fn = null;
          cycleRegistry.inDialog = false;
        };
      }, [cycle]);

      /* 鼠标是否在输入对话框内：只有在这里面时才拦下 ← →，别处一律可用 */
      React.useEffect(() => {
        const start = anchorRef.current;
        if (!start) return undefined;
        let box = start;
        while (box && box !== document.body) {
          if (box.querySelector && box.querySelector('textarea')) break;
          box = box.parentElement;
        }
        const dialog = box && box !== document.body ? box : null;
        if (!dialog) return undefined;
        const onMove = (event) => {
          const rect = dialog.getBoundingClientRect();
          cycleRegistry.inDialog =
            event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom;
        };
        window.addEventListener('mousemove', onMove, true);
        return () => window.removeEventListener('mousemove', onMove, true);
      }, []);

      const word = auto ? AUTO_LABEL : (effortsLabel || 'default');

      return h('div', {
        className: 'tef-wrap',
        ref: anchorRef,
      },
        h('button', {
          type: 'button',
          className: 'tef-btn',
          disabled: props.locked || !state,
          onClick: () => {
            setOpen((value) => {
              const next = !value;
              if (next && typeof load === 'function') {
                try { load(); } catch { /* ignore */ }
              }
              return next;
            });
          },
          onKeyDown: props.locked ? undefined : onKey,
          title: '切换思考强度：← / →',
        },
          h('span', { className: 'tef-model' }, modelLabel),
          h('span', { className: 'tef-dot-sep' }, '·'),
          h(SlidingEffort, { text: word, direction }),
        ),
        note ? h('div', { className: 'tef-msg', style: { position: 'absolute', left: 0, bottom: 'calc(100% + 30px)', zIndex: 50 } }, note) : null,
        open ? h(Popup, { anchorRef, onClose: () => setOpen(false) },
          h(MenuBody, {
            state,
            auto,
            routeDown,
            onPickModel: pickModel,
            onPickEffort: (effort) => pickEffort(effort, false),
            onAuto: () => {
              const effort = middleEffort(model) || efforts[0];
              if (effort) pickEffort(effort, true);
            },
          }),
        ) : null,
      );
    }

    class SeatBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch() {
        /* the fallback keeps a visible, non-interactive seat */
      }
      render() {
        if (this.state.error) return h('span', { className: 'tef-mini' }, '模型');
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------ *
     * compact chip (escape route when replacement is disabled)
     * ------------------------------------------------------------------ */

    function EffortChip(props) {
      const sessionId = props && props.sessionId;
      const state = useModelState(props && props.directory);
      const current = state && state.current ? state.current : null;
      const model = current ? findModel(state, current.provider, current.model) : null;
      const efforts = effortsOf(model);
      const label = effortName(model, current && current.reasoningEffort) || 'default';
      const [auto, setAuto] = React.useState(() => readAuto(sessionId));
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const anchorRef = React.useRef(null);

      const load = props && props.load;
      React.useEffect(() => {
        if (typeof load === 'function') {
          try { load(); } catch { /* ignore */ }
        }
      }, [props && props.directory]);

      if (!current || !efforts.length) return null;

      const pick = (effortId, autoMode) => {
        if (typeof props.select !== 'function') return;
        setBusy(true);
        Promise.resolve(props.select({ provider: current.provider, model: current.model, reasoningEffort: effortId }))
          .then(() => { setBusy(false); setAuto(autoMode); writeAuto(sessionId, autoMode); }, () => setBusy(false));
      };

      return h('div', {
        className: 'tef-wrap',
        ref: anchorRef,
      },
        h('button', {
          type: 'button',
          className: 'tef-mini',
          disabled: busy,
          onClick: () => setOpen((value) => !value),
          title: '思考强度',
        },
          h('span', { className: 'tef-effort' }, auto ? AUTO_LABEL : label),
        ),
        open ? h(Popup, { anchorRef, onClose: () => setOpen(false) },
          h('div', { className: 'tef-effort-row', style: { padding: '8px' } },
            efforts.map((effort) => h('button', {
              key: effort.id,
              type: 'button',
              className: 'tef-chip',
              'data-on': !auto && current.reasoningEffort === effort.id ? '1' : '0',
              onClick: () => { pick(effort.id, false); setOpen(false); },
            }, stem(effort.id))),
            h('button', {
              type: 'button',
              className: 'tef-chip',
              'data-on': auto ? '1' : '0',
              onClick: () => {
                const effort = middleEffort(model) || efforts[0];
                pick(effort.id, true);
                setOpen(false);
              },
            }, AUTO_LABEL),
          ),
        ) : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * per-turn tag: sits above the turn status row ("深度求索中，用时…")
     * ------------------------------------------------------------------ */

    function TurnTag(props) {
      const sessionId = props && props.sessionId;
      const state = useModelState(props && props.directory);
      const current = state && state.current ? state.current : null;
      const model = current ? findModel(state, current.provider, current.model) : null;
      const [auto, setAuto] = React.useState(() => readAuto(sessionId));

      const load = props && props.load;
      React.useEffect(() => {
        if (typeof load === 'function') {
          try { load(); } catch { /* ignore */ }
        }
      }, [props && props.directory]);

      React.useEffect(() => {
        const onChange = (event) => {
          if (!event.detail || event.detail.sessionId === sessionId) setAuto(readAuto(sessionId));
        };
        window.addEventListener('thinking-effort:auto-changed', onChange);
        return () => window.removeEventListener('thinking-effort:auto-changed', onChange);
      }, [sessionId]);

      /* 每轮结束后（本标签挂载）触发一次 auto 评分；同一轮只算一次 */
      React.useEffect(() => {
        if (!auto || !current) return;
        const seq = props && props.seq;
        scheduleAutoEval(sessionId, seq !== undefined && seq !== null ? 'turn:' + seq : 'mount');
      }, [auto, sessionId, props && props.seq, current && current.provider, current && current.model]);

      /* 历史真实档位：订阅 turns 缓存，拿到 request/header 里记录的实际档位 */
      const [, forceTick] = React.useState(0);
      React.useEffect(() => {
        const listener = () => forceTick((value) => value + 1);
        turnsState.listeners.add(listener);
        return () => turnsState.listeners.delete(listener);
      }, []);
      React.useEffect(() => {
        if (auto) ensureTurns(sessionId, props && props.seq);
      }, [auto, sessionId, props && props.seq]);

      const record = turnRecord(sessionId, props && props.seq, props && props.turn);
      const historical = record
        ? (record.effort ? (effortName(model, record.effort) || stem(record.effort)) : 'default')
        : null;
      const labelKey = (sessionId || '') + '|' + (props && props.seq !== undefined && props.seq !== null ? props.seq : 'mount');
      const liveLabel = current ? (effortName(model, current.reasoningEffort) || 'default') : 'default';
      if (auto) {
        autoLabels.set(labelKey, liveLabel);
        if (autoLabels.size > 500) {
          const oldest = autoLabels.keys().next().value;
          autoLabels.delete(oldest);
        }
      }
      const label = historical || (auto ? liveLabel : (autoLabels.get(labelKey) || liveLabel));

      if (!current) return null;

      return h('div', {
        className: 'tef-turn',
        'data-on': auto ? '1' : '0',
        title: '本轮思考强度：' + label,
      },
        h('span', { className: 'tef-tag', 'data-text': label }, label),
      );
    }

    /* ------------------------------------------------------------------ *
     * plugin
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      mountStyles(ctx);

      /* ← → 只在这个按钮/对话框区域内（鼠标悬停）生效 */
      const onGlobalKey = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const target = event.target;
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (target && target.isContentEditable) return;
        if (target && target.closest && target.closest('.tef-pop')) return;
        if (cycleRegistry.inDialog) return;
        const fn = cycleRegistry.fn;
        if (typeof fn !== 'function') return;
        event.preventDefault();
        event.stopPropagation();
        fn(event.key === 'ArrowRight' ? 1 : -1);
      };
      window.addEventListener('keydown', onGlobalKey, true);
      ctx.effect(() => () => window.removeEventListener('keydown', onGlobalKey, true));

      let replace = true;
      try {
        replace = window.localStorage.getItem(NO_REPLACE_KEY) !== '1';
      } catch {
        replace = true;
      }

      const models = ctx.modelDirectories;
      const directories = new Map();
      const directoryOf = (sessionId) => {
        if (!directories.has(sessionId)) directories.set(sessionId, models.directoryFor(sessionId));
        return directories.get(sessionId);
      };
      const propsFor = (sessionId) => {
        if (!sessionId || !models) return { sessionId, directory: null, load: null, select: null };
        const directory = directoryOf(sessionId);
        return {
          sessionId,
          directory: directory.store,
          load: () => directory.load(),
          select: (selection) => directory.select(selection),
        };
      };

      if (replace) {
        ctx.slots.inject('conversation.input.model', () =>
          ctx.slots.register({
            name: 'conversation.input.model',
            children: {
              'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
            },
            inject: propsFor,
          }, (slotProps) => h(SeatBoundary, null, h(ModelSeat, slotProps))),
        );
      } else {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: 'thinking-effort-chip', order: 2 },
            (slotProps) => h(EffortChip, { ...slotProps, ...propsFor(slotProps && slotProps.sessionId) })),
        );
      }

      /* 对话下面的每轮挡位标签：恢复注册（淡入淡出由 data-on 控制） */
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'thinking-effort-turn', order: -1 },
          (slotProps) => h(TurnTag, { ...slotProps, ...propsFor(slotProps && slotProps.sessionId) })),
      );
    }

    return { inject: ['slots', 'modelDirectories'], apply };
  },
});
