// Host half of @local/dsh-end-timestamp.
//
// WHY: the client UI half reads a finished turn's model from
// turn.data['turn-tail'].tokenUsage.routes, but the host only derives that
// structure for turns that finish normally. Interrupted ("已停止") and failed
// ("处理失败") turns carry no tokenUsage, so their reply line shows the end
// time but no model, and some error turns have no turn-process button at all.
// The raw session event stream, however, records the serving model on every
// turn (request/header.config, request/context, model/selection,
// assistant/message.source) regardless of how the turn ended.
//
// This host half exposes a tiny read-only POST endpoint that folds the raw
// events of one session into a per-turn summary
//   { turn, endTime, kind, models: ["provider/model", ...] }.
// The client half fetches it and uses it ONLY as a fallback when the
// turn-tail model is missing (or when an error turn has no button).
//
// ROUTING (verified live on this very server, 2026-11-09):
//  * @local sibling plugins (dsh-continue-on-truncate, dsh-browser-links)
//    register with ctx.inject(['webServer']) + webServer.register({kind,
//    path, handler:(req,res)}) -- Node IncomingMessage/ServerResponse.
//    GET /dsh-continue-on-truncate/host-active returns 200 right now.
//  * the bundled dsh-context plugin instead registers with
//    connection.fetch.register({path:'/api/...', methods:['POST'],
//    requestBody:'buffered', fetch}) -- Fetch Request/Response.
//    POST /api/dsh-context/detail returns 200 right now.
// Both services are available to @local plugins (dsh-browser-links itself
// calls ctx.get('connection')). We register the SAME handler on BOTH routers,
// each best-effort and independent, so the endpoint is reachable no matter
// which one our context resolves. The client tries both paths in order.
//
// Nothing here depends on any file outside this plugin: events come from DSH's
// own sessionQuery service via ctx.get / ctx.inject -- never a bare
// ctx.<service> property read -- so Cordis' ReflectService proxy trap is not
// tripped. Every failure degrades to an empty result; the client keeps
// behaving exactly as v1.1.0 (timestamps only).

export const PATH = '/dsh-end-timestamp/turns';
export const API_PATH = '/api/dsh-end-timestamp/turns';

function label(provider, model) {
  if (typeof model !== 'string' || !model) return null;
  if (typeof provider === 'string' && provider) return provider + '/' + model;
  return model;
}

function pushLabel(out, l) {
  if (l) out.push(l);
}

// Labels of the model that served one raw event. Deliberately EXCLUDES
// session/title-llm-request and plugin:translator/* -- those can use a
// different model than the conversation turn and would mislabel it.
export function modelsFromEvent(type, data) {
  const out = [];
  try {
    if (!data || typeof data !== 'object') return out;
    if (type === 'request/header') {
      const cfg = data.header && data.header.config;
      if (cfg) pushLabel(out, label(cfg.provider, cfg.model));
    } else if (type === 'request/context') {
      pushLabel(out, label(data.provider, data.model));
    } else if (type === 'model/selection') {
      pushLabel(out, label(data.provider, data.model));
    } else if (type === 'assistant/message') {
      const src = data.message && data.message.source;
      if (src) pushLabel(out, label(src.provider, src.model));
    }
  } catch (e) {}
  return out;
}

// Pure fold: raw events -> per-turn summary. Exported for offline selftests.
// Model-bearing events without an explicit data.turn are attributed by the
// turn/start..turn/end seq window they fall in; ones in a gap are held and
// attributed to the NEXT turn/start. Leftovers with no next turn are dropped
// rather than guessed onto a turn (never fabricate a model).
//
// v1.3: also records startTime (the turn/start event's time) alongside
// endTime, so the client can render the elapsed duration ("用时") for turns
// DSH itself suppresses the duration on (aborted / interrupted / error).
export function foldTurns(events) {
  const turns = new Map();
  const pending = [];
  let current = null;

  function ensure(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    let t = turns.get(n);
    if (!t) {
      t = { turn: n, startTime: null, endTime: null, kind: null, models: new Set() };
      turns.set(n, t);
    }
    return t;
  }

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const type = ev.type;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};

    if (type === 'turn/start') {
      current = typeof data.turn === 'number' ? data.turn : null;
      const t = ensure(current);
      if (t) {
        if (typeof ev.time === 'number' && Number.isFinite(ev.time)) t.startTime = ev.time;
        for (const l of pending) t.models.add(l);
      }
      pending.length = 0;
      continue;
    }
    if (type === 'turn/end') {
      const t = ensure(data.turn);
      if (t) {
        if (typeof ev.time === 'number' && Number.isFinite(ev.time)) t.endTime = ev.time;
        const kind = data.reason && data.reason.kind;
        if (typeof kind === 'string') t.kind = kind;
      }
      current = null;
      continue;
    }

    const labels = modelsFromEvent(type, data);
    if (!labels.length) continue;
    let target = null;
    if (typeof data.turn === 'number' && Number.isFinite(data.turn)) {
      target = ensure(data.turn);
    } else if (current !== null) {
      target = ensure(current);
    }
    if (target) for (const l of labels) target.models.add(l);
    else for (const l of labels) pending.push(l);
  }

  const result = [];
  for (const t of turns.values()) {
    result.push({
      turn: t.turn,
      startTime: t.startTime,
      endTime: t.endTime,
      kind: t.kind,
      models: Array.from(t.models),
    });
  }
  result.sort((a, b) => a.turn - b.turn);
  return result;
}

// ---- Shared core ----------------------------------------------------------

async function disposeObserved(observed) {
  try {
    if (!observed || typeof observed !== 'object') return;
    const sym = typeof Symbol !== 'undefined' ? Symbol.dispose : undefined;
    if (sym && typeof observed[sym] === 'function') {
      await observed[sym]();
      return;
    }
    if (typeof observed.dispose === 'function') {
      await observed.dispose();
      return;
    }
    const asyncSym = typeof Symbol !== 'undefined' ? Symbol.asyncDispose : undefined;
    if (asyncSym && typeof observed[asyncSym] === 'function') {
      await observed[asyncSym]();
    }
  } catch (e) {}
}

async function readTurns(sessionQuery, sessionId) {
  let observed = null;
  try {
    observed = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
  } catch (e) {
    return { error: 'observeSession failed' };
  }
  try {
    let events = observed && observed.events;
    if (!Array.isArray(events) && Array.isArray(observed)) events = observed;
    if (!Array.isArray(events)) return { error: 'no raw events' };
    return { turns: foldTurns(events) };
  } finally {
    await disposeObserved(observed);
  }
}

function safeSessionQuery(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const sq = ctx.get('sessionQuery');
      if (sq && typeof sq.observeSession === 'function') return sq;
    }
  } catch (e) {}
  return null;
}

function answer(out) {
  return out.error
    ? { ok: false, turns: [], error: out.error }
    : { ok: true, turns: out.turns };
}

// ---- webServer (Node req/res) adapter ------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    try {
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 65536) raw = raw.slice(0, 65536);
      });
      req.on('end', () => resolve(raw));
      req.on('error', () => resolve(raw));
    } catch (e) {
      resolve(raw);
    }
  });
}

function jsonNode(res, status, value) {
  try {
    if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(value));
      return;
    }
  } catch (e) {}
  // Some hosts give a Fetch-style Response sink even on webServer.register;
  // there is nothing useful to do there, so we just let it degrade.
}

function makeNodeHandler(ctx) {
  return function nodeHandler(req, res) {
    readBody(req)
      .then((raw) => {
        let sessionId = '';
        try {
          const body = JSON.parse(raw || '{}');
          if (body && typeof body.sessionId === 'string') sessionId = body.sessionId;
        } catch (e) {}
        if (!sessionId) {
          jsonNode(res, 400, { ok: false, turns: [], error: 'missing sessionId' });
          return;
        }
        const sq = safeSessionQuery(ctx);
        if (!sq) {
          jsonNode(res, 200, { ok: false, turns: [], error: 'sessionQuery unavailable' });
          return;
        }
        return readTurns(sq, sessionId)
          .then((out) => jsonNode(res, 200, answer(out)))
          .catch((e) =>
            jsonNode(res, 200, { ok: false, turns: [], error: String(e) })
          );
      })
      .catch((e) =>
        jsonNode(res, 200, { ok: false, turns: [], error: String(e) })
      );
  };
}

// ---- connection.fetch (Fetch Request/Response) adapter -------------------

function jsonFetch(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function makeFetchHandler(sessionQuery) {
  return async function fetchHandler(request) {
    let sessionId = '';
    try {
      const body = await request.json();
      if (body && typeof body.sessionId === 'string') sessionId = body.sessionId;
    } catch (e) {}
    if (!sessionId) {
      return jsonFetch({ ok: false, turns: [], error: 'missing sessionId' }, 400);
    }
    const out = await readTurns(sessionQuery, sessionId);
    return jsonFetch(answer(out), 200);
  };
}

// ---- apply: register both routes, each strictly best-effort ---------------

export function apply(ctx) {
  // Primary: webServer.register (proven pattern for @local sibling plugins).
  try {
    ctx.inject(['webServer'], (scoped) => {
      let server = null;
      try {
        server =
          (scoped && scoped.webServer) ||
          (scoped && typeof scoped.get === 'function' ? scoped.get('webServer') : null);
      } catch (e) {}
      if (!server || typeof server.register !== 'function') return undefined;
      const spec = { kind: 'exact', path: PATH, handler: makeNodeHandler(ctx) };
      try {
        if (scoped && typeof scoped.effect === 'function') {
          scoped.effect(() => server.register(spec));
        } else {
          server.register(spec);
        }
      } catch (e) {
        try { server.register(spec); } catch (e2) {}
      }
      return () => {};
    });
  } catch (e) {
    // best-effort only
  }

  // Secondary: connection.fetch.register (the bundled dsh-context pattern).
  try {
    ctx.inject(['connection', 'sessionQuery'], (scoped) => {
      let connection = null;
      let sessionQuery = null;
      try {
        connection = scoped && typeof scoped.get === 'function'
          ? scoped.get('connection') : null;
        sessionQuery = scoped && typeof scoped.get === 'function'
          ? scoped.get('sessionQuery') : null;
      } catch (e) {}
      const connFetch = connection && connection.fetch;
      if (
        !connFetch ||
        typeof connFetch.register !== 'function' ||
        !sessionQuery ||
        typeof sessionQuery.observeSession !== 'function'
      ) {
        return undefined;
      }
      const register = connFetch.register.bind(connFetch);
      const spec = {
        path: API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: makeFetchHandler(sessionQuery),
      };
      try {
        if (typeof ctx.effect === 'function') ctx.effect(() => register(spec));
        else register(spec);
      } catch (e) {
        try { register(spec); } catch (e2) {}
      }
      return () => {};
    });
  } catch (e) {
    // best-effort only
  }
}
