# Thinking effort picker for DSH

A DSH bundle that replaces the composer model selector with a compact picker:
model list, thinking-effort chips, and an `Auto` entry. It also shows the
current effort at the end of a turn while `Auto` is on.

Status: **0.1.0 — UI, manual switching and the auto-scoring bridge.** The Host
half is implemented and unit-tested with stubbed services; it goes live after
one DSH restart (see [Activation](#activation)).

## What it does

- **Model + effort picker** — replaces the shipped `conversation.input.model`
  slot. The menu lists models grouped by provider, plus the effort chips of the
  current model (`off` / `low` / `high` / `max` / whatever the provider
  exposes) and an `Auto` entry.
- **Arrow cycling** — `←` decreases and `→` increases. The ladder is
  `[real levels…, Auto]`: `→` from the highest real level lands on `Auto`,
  `←` from `Auto` returns to the highest level. There is no wrap-around; the
  ends stay put.
- **Mouse-aware** — the arrow shortcut is ignored while the pointer is inside
  the composer card, so typing/caret movement is never hijacked. Anywhere else
  on the page it works.
- **Slide animation** — the effort word in the button slides horizontally
  (old word out, new word in) inside a fixed 52px slot, with the cool-tone
  rainbow gradient and a light glow.
- **Per-turn tag** — while `Auto` is on, each completed turn gets a small
  effort word above the turn status row. It expands from zero height and fades
  in/out, so it never reserves blank space when hidden.
- **Fallback** — if the replacement selector misbehaves, keep the bundle but
  set `localStorage['thinking-effort:no-replace'] = '1'` and reload: a compact
  chip in `conversation.input.left` takes over.

## Install (local bundle)

The bundle lives in this directory. Link it into a profile and add the patch
row the same way any other DSH bundle is installed, then restart DSH (the Host
half only loads at startup).

## Configuration

The bundle patch row accepts weights for the (not yet wired) auto scoring:

```yaml
- insert:
    - id: thinking-effort
      name: '@local/thinking-effort'
      config:
        weights:
          importance: 1
          failure: 1
```

Only the ratio matters: `total = wI*importance + wA*failure`, and the level
index is `floor(total / ((wI*10 + wA*5) / N))` over the model's real levels.

## Auto scoring

`index.js` registers `POST /thinking-effort/evaluate` and computes:

- **failure (0–5)** from the latest turn's Session events: repeated failed tool
  calls (same name + argument digest) and a `turn/end` error;
- **importance (0–10)** with one small judge call against the anchor (the
  active goal objective, else the first user message), where farther from the
  anchor scores lower;
- the mapped target level, and — with `apply: true` — the selection applied
  through `sessionController.selectModel`.

The Client half calls it:

- when `Auto` is switched on (immediately, so the first cold start lands on the
  middle level before the next turn);
- after every completed turn, from the per-turn tag (`conversation.chat.turnTail`),
  at most once per turn, 600 ms after the turn settles.

If the route answers 404/405 the Client marks it unavailable and stops calling,
so a profile without the Host half keeps working.

### Per-turn history

`POST /thinking-effort/turns` returns the effort each turn **actually sent**:

```json
{"ok":true,"turns":[{"turn":1,"effort":"low","seq":18,"endSeq":100,"provider":"p","model":"m","at":1000}]}
```

The Host reads `request/header` events between `turn/start` and `turn/end`, so
the number comes from the request the model really received, not from the
current picker state. The Client caches the answer per session, matches it to
each `conversation.chat.turnTail` entry by the turn's closing `seq` (falling
back to the turn number), and shows that recorded effort. When the route is
unavailable it falls back to the live selection.

## Activation

The Host half only loads at startup. Requirements:

1. `@local/thinking-effort` linked into the profile's `node_modules`;
2. a loader row for it — the bundle patch inside `package.json` inserts it, so
   the profile's own `cordis.patch.yml` needs no extra entry;
3. the module must declare `export const inject = ['webServer']`.

Point 3 is the one that bit this plugin: without a declared dependency, `apply`
can run before the HTTP carrier exists, `ctx.get('webServer')` returns undefined,
the early return silently skips route registration, and the plugin still reports
`fiberPhase: active` while every request falls through to the SPA fallback
(405 with `allow: GET, HEAD`).

After a restart, verify with:

```powershell
curl.exe -s -X POST "http://127.0.0.1:<port>/thinking-effort/evaluate" `
  -H "content-type: application/json" -H "sec-fetch-site: same-origin" `
  -d '{"sessionId":"probe"}'
```

A structured JSON answer (for example `{"ok":false,"error":"session-not-live"}`)
means the route is live; a 405 means it is not.

## Known limitations

- The per-turn tag shows the recorded `request/header` effort when
  `/thinking-effort/turns` answers; otherwise it falls back to the current
  selection. A turn with no recorded header (e.g. cancelled) shows the fallback.
- `conversation.input.model.label` contributions from other plugins are not
  forwarded (the child slot is declared but never rendered).
- The menu has no search box and no roving keyboard focus.
- `selectModel` may be refused while an agent is running; the response then
  carries `applied: false` with `applyError`, and the UI keeps the manual choice.

## License

MIT. See [LICENSE](./LICENSE).
