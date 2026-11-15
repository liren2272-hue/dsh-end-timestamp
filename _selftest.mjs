// Comprehensive offline selftest for @local/dsh-end-timestamp v1.3.
//
// Verifies:
//  A. foldTurns() against the bundled session fixture (3 turns: error /
//     interrupted / completed, each with the correct model and startTime).
//  B. foldTurns() synthetic negative controls (gap attribution, no fabrication,
//     excluded event types, dedup). These assertions TURN RED on a buggy fold.
//  C. modelsFromEvent() recognizes exactly the 4 trusted event types.
//  D. host apply() registers BOTH routers (webServer + connection.fetch) via a
//     faithful Cordis ctx Proxy that throws on bare ctx.<service> reads, and
//     both handlers return the correct fold. Also proves the proxy trap is real
//     (a buggy bare read WOULD throw) while our apply() never throws.
//  E. client v1.1.0 regressions (timestamp/model stamping, dedup, malformed
//     store, no tail, turnTail slot only -- NEVER conversation.chat.flow).
//  F. client fold fallback: endpoint unavailable -> v1.1.0 behavior; available
//     -> model appears; endTime mismatch / wrong turn -> model NOT applied.
//  G. v1.3 elapsed duration: stopped (aborted/interrupted) and error turns
//     render "用时 <时长>" (formatting mirrors DSH's formatRunDuration);
//     completed turns do NOT add it (DSH already shows it); missing start or
//     the fold's startTime fallback behave correctly.
//
// Usage:
//   node src/_selftest.mjs                       # staged (src/plugin-*.js)
//   node _selftest.mjs                          # installed (index.js/client.js)
//   node src/_selftest.mjs <pluginDir>          # explicit installed dir
// Every check prints PASS/FAIL; exits 1 if any failure.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// Self-contained fixture bundled inside the plugin (no dependency on a
// folder outside the plugin, which could be deleted).
const REAL_JSONL = join(HERE, 'testdata', 'session-fixture.jsonl');

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log('PASS:', label);
  } else {
    console.error('FAIL:', label, extra !== undefined ? '=> ' + JSON.stringify(extra) : '');
    failures++;
  }
}

// Resolve host + client source paths for staged or installed layout.
function resolveSources() {
  const explicit = process.argv[2];
  if (explicit) {
    return { host: join(explicit, 'index.js'), client: join(explicit, 'client.js') };
  }
  const stagedHost = join(HERE, 'plugin-index.js');
  if (existsSync(stagedHost)) {
    return { host: stagedHost, client: join(HERE, 'plugin-client.js') };
  }
  return { host: join(HERE, 'index.js'), client: join(HERE, 'client.js') };
}

// Load the host module as ESM regardless of the source file's directory type:
// copy to a .mjs in tmp/, then dynamic-import that.
async function loadHost(hostPath) {
  const tmpMjs = join(tmpdir(), 'dsh-end-timestamp-_selftest-host.mjs');
  writeFileSync(tmpMjs, readFileSync(hostPath, 'utf8'));
  return import(pathToFileURL(tmpMjs).href + '?t=' + Date.now());
}

const flush = () => new Promise((r) => setImmediate(r));

async function main() {
  const { host: hostPath, client: clientPath } = resolveSources();
  console.log('HOST  :', hostPath);
  console.log('CLIENT:', clientPath);

  const H = await loadHost(hostPath);
  const clientSrc = readFileSync(clientPath, 'utf8');

  // =====================================================================
  // A. foldTurns on REAL data
  // =====================================================================
  const realEvents = readFileSync(REAL_JSONL, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const folded = H.foldTurns(realEvents);
  check('A1 real fold returns exactly 3 turns', folded.length === 3, folded.map((t) => t.turn));
  const byTurn = new Map(folded.map((t) => [t.turn, t]));
  const t1 = byTurn.get(1);
  const t2 = byTurn.get(2);
  const t3 = byTurn.get(3);
  check('A2 turn1 kind=error', t1 && t1.kind === 'error', t1);
  check('A3 turn1 model = raccoon/.../sn-sensenova-6-8-flash',
    t1 && t1.models.join(' ').includes('sn-sensenova'), t1 && t1.models);
  check('A4 turn2 kind=interrupted', t2 && t2.kind === 'interrupted', t2);
  check('A5 turn2 model = workbuddy/hy4free',
    t2 && t2.models.join(' ').includes('hy4free'), t2 && t2.models);
  check('A6 turn3 kind=completed', t3 && t3.kind === 'completed', t3);
  check('A7 turn3 model = workbuddy/hy4free',
    t3 && t3.models.join(' ').includes('hy4free'), t3 && t3.models);
  check('A8 turn1 endTime is a real timestamp', t1 && typeof t1.endTime === 'number' && t1.endTime > 1e12, t1 && t1.endTime);
  check('A9 turn2 endTime is a real timestamp', t2 && typeof t2.endTime === 'number' && t2.endTime > 1e12, t2 && t2.endTime);
  check('A10 turn1 startTime recorded', t1 && typeof t1.startTime === 'number' && t1.startTime > 1e12, t1 && t1.startTime);
  check('A11 startTime < endTime on every turn',
    !!(t1 && t2 && t3 && t1.startTime < t1.endTime && t2.startTime < t2.endTime && t3.startTime < t3.endTime),
    { t1: [t1 && t1.startTime, t1 && t1.endTime], t2: [t2 && t2.startTime, t2 && t2.endTime], t3: [t3 && t3.startTime, t3 && t3.endTime] });

  // =====================================================================
  // B. foldTurns synthetic negative controls (would go RED on a buggy fold)
  // =====================================================================
  const ev = (seq, type, data, time) => Object.assign({ seq, type, data: data || {} }, time ? { time } : {});
  // Gap event between turn1 end and turn2 start must be attributed to NEXT turn.
  const gap = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'request/header', { header: { config: { provider: 'p1', model: 'm1' } } }),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1000),
    ev(4, 'model/selection', { provider: 'p2', model: 'm2' }), // gap -> turn2
    ev(5, 'turn/start', { turn: 2 }),
    ev(6, 'assistant/message', { turn: 2, message: { source: { provider: 'p2', model: 'm2' } } }),
    ev(7, 'turn/end', { turn: 2, reason: { kind: 'interrupted' } }, 2000),
  ];
  const g = H.foldTurns(gap);
  const g1 = g.find((x) => x.turn === 1);
  const g2 = g.find((x) => x.turn === 2);
  check('B1 gap model attributed to NEXT turn only',
    g2 && g2.models.includes('p2/m2') && g1 && !g1.models.includes('p2/m2'),
    { g1: g1 && g1.models, g2: g2 && g2.models });
  check('B2 turn1 keeps its own model', g1 && g1.models.includes('p1/m1'), g1 && g1.models);

  // Leftover pending with NO next turn must be DROPPED (never fabricated).
  const leftover = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1000),
    ev(3, 'model/selection', { provider: 'ghost', model: 'orphan' }),
  ];
  const lf = H.foldTurns(leftover);
  check('B3 leftover pending model is dropped',
    lf.length === 1 && !lf[0].models.some((m) => m.includes('ghost')), lf);

  // session/title-llm-request and plugin:translator/request must be EXCLUDED.
  const excluded = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'session/title-llm-request', { route: { provider: 'titlep', model: 'titlem' } }),
    ev(3, 'plugin:translator/request', { provider: 'transp', model: 'transm' }),
    ev(4, 'request/header', { header: { config: { provider: 'realp', model: 'realm' } } }),
    ev(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1000),
  ];
  const ex = H.foldTurns(excluded);
  const exm = ex[0] && ex[0].models.join(' ');
  check('B4 excluded event types do NOT contaminate',
    exm && exm.includes('realp/realm') && !exm.includes('titlep') && !exm.includes('transp'), exm);

  // Duplicate labels deduped.
  const dup = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'request/header', { header: { config: { provider: 'a', model: 'm' } } }),
    ev(3, 'request/context', { provider: 'a', model: 'm' }),
    ev(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1000),
  ];
  const dm = H.foldTurns(dup)[0].models;
  check('B5 duplicate labels deduped', dm.length === 1 && dm[0] === 'a/m', dm);

  // Empty events -> no turns (no fabrication).
  check('B6 empty events -> []', H.foldTurns([]).length === 0);

  // Strip all model events from real data -> kinds/endTimes survive, models empty.
  const stripped = realEvents.filter((e) => !H.modelsFromEvent(e.type, e.data).length);
  const st = H.foldTurns(stripped);
  check('B7 no model events -> still 3 turns with kinds, models empty',
    st.length === 3 && st.every((t) => t.models.length === 0) && st[1].kind === 'interrupted', st);

  // =====================================================================
  // C. modelsFromEvent
  // =====================================================================
  check('C1 request/header', H.modelsFromEvent('request/header', { header: { config: { provider: 'p', model: 'm' } } })[0] === 'p/m');
  check('C2 request/context', H.modelsFromEvent('request/context', { provider: 'p', model: 'm' })[0] === 'p/m');
  check('C3 model/selection', H.modelsFromEvent('model/selection', { provider: 'p', model: 'm' })[0] === 'p/m');
  check('C4 assistant/message', H.modelsFromEvent('assistant/message', { message: { source: { provider: 'p', model: 'm' } } })[0] === 'p/m');
  check('C5 session/title-llm-request excluded', H.modelsFromEvent('session/title-llm-request', { route: { provider: 'p', model: 'm' } }).length === 0);
  check('C6 plugin:translator/request excluded', H.modelsFromEvent('plugin:translator/request', { provider: 'p', model: 'm' }).length === 0);
  check('C7 unknown type excluded', H.modelsFromEvent('tool/call', { provider: 'p', model: 'm' }).length === 0);
  check('C8 no provider -> bare model', H.modelsFromEvent('model/selection', { model: 'solo' })[0] === 'solo');
  check('C9 empty data -> []', H.modelsFromEvent('model/selection', null).length === 0);

  // =====================================================================
  // D. host apply() + both handlers + faithful Cordis proxy-trap ctx
  // =====================================================================
  let observeCalls = 0;
  let disposed = 0;
  const fakeObserved = () => {
    const o = { events: realEvents };
    o[Symbol.dispose] = () => { disposed++; };
    return o;
  };
  const services = {
    sessionQuery: {
      observeSession: async (sessionId, opts) => {
        observeCalls++;
        fakeObserved.lastOpts = opts;
        fakeObserved.lastId = sessionId;
        return fakeObserved();
      },
    },
  };
  const registered = { node: [], fetch: [] };
  services.webServer = { register: (spec) => { registered.node.push(spec); } };
  services.connection = { fetch: { register: (spec) => { registered.fetch.push(spec); } } };

  const injectedDeps = [];
  function makeScoped(deps) {
    const injected = new Set(deps);
    const methods = {
      get: (name) => services[name],
      effect: (fn) => { fn(); return () => {}; },
    };
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (methods[prop]) return methods[prop];
        if (injected.has(prop)) return services[prop];
        if (services[prop] !== undefined) {
          throw new Error('cannot get property "' + prop + '" without inject');
        }
        return undefined;
      },
    });
  }
  const ctxMethods = {
    inject: (deps, cb) => { injectedDeps.push(deps); return cb(makeScoped(deps)); },
    effect: (fn) => { fn(); return () => {}; },
    get: (name) => services[name],
  };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (ctxMethods[prop]) return ctxMethods[prop];
      if (services[prop] !== undefined) {
        throw new Error('cannot get property "' + prop + '" without inject');
      }
      return undefined;
    },
  });

  // Negative control: a buggy bare read WOULD throw on this ctx.
  let bareReadThrew = false;
  try { void ctx.sessionQuery; } catch (e) { bareReadThrew = true; }
  check('D0 proxy trap is real (bare ctx.sessionQuery throws)', bareReadThrew);

  let applyThrew = false;
  try { H.apply(ctx); } catch (e) { applyThrew = true; console.error('  apply threw:', e && e.message); }
  check('D1 apply() does NOT throw with proxy-trap ctx (no bare reads)', !applyThrew);

  // Broken ctx (no inject) must still not throw (best-effort).
  let brokenThrew = false;
  try { H.apply({}); } catch (e) { brokenThrew = true; }
  check('D2 apply() best-effort with broken ctx (no inject)', !brokenThrew);

  check('D3 registers webServer route exactly once', registered.node.length === 1, registered.node.map((s) => s.path));
  check('D4 registers connection.fetch route exactly once', registered.fetch.length === 1, registered.fetch.map((s) => s.path));
  const nodeSpec = registered.node[0];
  const fetchSpec = registered.fetch[0];
  check('D5 node spec kind=exact path=PATH', nodeSpec && nodeSpec.kind === 'exact' && nodeSpec.path === H.PATH, nodeSpec);
  check('D6 fetch spec path=API_PATH, POST, buffered',
    fetchSpec && fetchSpec.path === H.API_PATH && Array.isArray(fetchSpec.methods) && fetchSpec.methods.includes('POST') && fetchSpec.requestBody === 'buffered', fetchSpec);

  // Invoke the webServer (Node req/res) handler.
  function invokeNode(spec, sessionId) {
    const cbs = {};
    const req = {
      on(e, cb) { (cbs[e] || (cbs[e] = [])).push(cb); return this; },
      emit(e, a) { for (const cb of cbs[e] || []) cb(a); },
    };
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const res = {
      status: 0, headers: null, body: null,
      writeHead(s, h) { this.status = s; this.headers = h; },
      end(b) { this.body = b; resolveDone(); },
    };
    spec.handler(req, res);
    req.emit('data', JSON.stringify({ sessionId }));
    req.emit('end');
    return done.then(() => ({ status: res.status, body: JSON.parse(res.body) }));
  }
  const nodeOut = await invokeNode(nodeSpec, 'session-36811dd8-df3a-4b6c-b1e8-c836f462c6a8');
  check('D7 node handler -> ok + 3 turns', nodeOut.body.ok === true && nodeOut.body.turns.length === 3, nodeOut.body);
  check('D8 node handler turn2 = interrupted/workbuddy/hy4free',
    nodeOut.body.turns[1].kind === 'interrupted' && nodeOut.body.turns[1].models.join(' ').includes('hy4free'), nodeOut.body.turns[1]);
  check('D9 node handler observed with projectionMode:none',
    fakeObserved.lastOpts && fakeObserved.lastOpts.projectionMode === 'none', fakeObserved.lastOpts);

  // Missing sessionId -> 400.
  const bad = await invokeNode(nodeSpec, '');
  check('D10 node handler missing sessionId -> 400', bad.status === 400 && bad.body.ok === false, bad);

  // Invoke the Fetch-style handler.
  const fetchOut = await fetchSpec.fetch({ json: async () => ({ sessionId: 'session-36811dd8-df3a-4b6c-b1e8-c836f462c6a8' }) });
  const fetchBody = await fetchOut.json();
  check('D11 fetch handler -> ok + 3 turns', fetchBody.ok === true && fetchBody.turns.length === 3, fetchBody);
  check('D12 fetch handler turn1 = error/raccoon',
    fetchBody.turns[0].kind === 'error' && fetchBody.turns[0].models.join(' ').includes('sn-sensenova'), fetchBody.turns[0]);
  // Two handler invocations reach observeSession (node + fetch); the 400
  // missing-sessionId case returns early. The real invariant: every snapshot
  // that was opened is disposed (no leak), and both handlers were exercised.
  check('D13 every observed snapshot was disposed (no leak)', disposed === observeCalls, { disposed, observeCalls });
  check('D14 observeSession reached by both handlers', observeCalls === 2, observeCalls);
  check('D14b dispose count matches handler invocations', disposed === 2, disposed);

  // =====================================================================
  // E/F. client: fresh instance per test (isolated foldCache / mounted)
  // =====================================================================
  function loadClient(fetchImpl) {
    const captured = [];
    const fakeWindow = { __ModuleLoader__: { load(spec) { captured.push(spec); } } };
    let stampNode = null;
    let durationNode = null;

    function textOf(node) {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent || '';
      let out = '';
      const kids = node.children || [];
      for (const c of kids) out += textOf(c);
      return out;
    }
    function fakeEl(tag) {
      const el = {
        tagName: tag,
        nodeType: 1,
        children: [],
        attrs: {},
        style: { cssText: '' },
        setAttribute(k, v) { el.attrs[k] = v; },
        getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
        appendChild(child) {
          child.parentNode = el;
          el.children.push(child);
          if (child.attrs && child.attrs['data-end-timestamp-inline']) stampNode = child;
          if (child.attrs && child.attrs['data-end-timestamp-duration']) durationNode = child;
          return child;
        },
        insertBefore(child, ref) {
          child.parentNode = el;
          const i = el.children.indexOf(ref);
          if (i < 0) el.children.push(child);
          else el.children.splice(i, 0, child);
          if (child.attrs && child.attrs['data-end-timestamp-inline']) stampNode = child;
          if (child.attrs && child.attrs['data-end-timestamp-duration']) durationNode = child;
          return child;
        },
        removeChild(child) {
          const i = el.children.indexOf(child);
          if (i >= 0) el.children.splice(i, 1);
          child.parentNode = null;
          if (child.attrs && child.attrs['data-end-timestamp-duration']) durationNode = null;
          if (child.attrs && child.attrs['data-end-timestamp-inline']) stampNode = null;
          return child;
        },
        contains(node) { return el.children.indexOf(node) >= 0; },
        querySelector(sel) {
          const m = /data-end-timestamp-(inline|duration)/.exec(sel);
          if (!m) return null;
          return m[1] === 'inline' ? stampNode : durationNode;
        },
        querySelectorAll() { return []; },
      };
      Object.defineProperty(el, 'textContent', {
        configurable: true,
        get() { return textOf(el); },
        set(v) {
          el.children = [];
          if (v !== '') {
            const t = { nodeType: 3, textContent: String(v), parentNode: el };
            el.children.push(t);
          }
        },
      });
      return el;
    }

    const mockLabel = fakeEl('span');
    const mockBtn = {
      nodeType: 1,
      children: [],
      querySelector: (sel) => (sel === ':scope > span' ? mockLabel : null),
    };
    globalThis.document = {
      querySelector: (sel) => (sel && sel.indexOf('data-turn-process') >= 0 ? mockBtn : null),
      querySelectorAll: () => [],
      createElement: (tag) => fakeEl(tag),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    };
    globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} };
    if (fetchImpl === undefined) delete globalThis.fetch;
    else globalThis.fetch = fetchImpl;
    const require = (id) => {
      if (id === 'react') return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useEffect: (cb) => { cb(); return undefined; },
      };
      throw new Error('unexpected require ' + id);
    };
    new Function('window', 'require', clientSrc)(fakeWindow, require);
    const spec = captured[0];
    const plugin = spec.factory(require);
    let component = null;
    let registeredSlot = null;
    plugin.apply({ slots: {
      inject(slot, fn) { registeredSlot = slot; component = fn(); },
      register(_o, comp) { return comp; },
    } });
    return {
      component,
      registeredSlot,
      spec,
      getStamp() { return stampNode && stampNode.textContent; },
      getDuration() { return durationNode && durationNode.textContent; },
      getLabelOrder() {
        return mockLabel.children.map((c) =>
          (c.attrs && c.attrs['data-end-timestamp-inline']) ? 'inline'
            : (c.attrs && c.attrs['data-end-timestamp-duration']) ? 'duration' : 'text');
      },
      getDurationNode() { return durationNode; },
      resetStamp() { stampNode = null; durationNode = null; mockLabel.children = []; },
    };
  }

  function makeTurn(over, routes) {
    const tail = routes === undefined ? null : { tokenUsage: { routes } };
    const store = {
      get: (k) => (k === 'turn-tail' ? tail : undefined),
      source: () => ({ subscribe: () => () => {} }),
    };
    return Object.assign({ status: 'closed', data: store }, over);
  }
  const T = new Date('2026-01-01T14:23:45').getTime();

  // -- E. v1.1.0 regressions with NO endpoint (fetch undefined) -----------
  {
    const c = loadClient(undefined);
    check('E1 registers conversation.chat.turnTail', c.registeredSlot === 'conversation.chat.turnTail', c.registeredSlot);
    check('E2 NEVER registers conversation.chat.flow', c.registeredSlot !== 'conversation.chat.flow', c.registeredSlot);
    check('E3 component is a function', typeof c.component === 'function');
    check('E4 no tail rendered (returns null)', c.component({ turn: makeTurn({ end: { time: T } }) }) === null);
    check('E5 null when not closed', c.component({ turn: makeTurn({ status: 'running' }) }) === null);
    check('E6 null when turn missing', c.component({ turn: undefined }) === null);

    c.resetStamp();
    c.component({ turn: makeTurn({ turn: 42, end: { time: T } }, [{ provider: 'codearts', model: 'deepseek-v4.1' }]) });
    let text = c.getStamp();
    check('E7 stamp has end time', !!text && text.includes('结束于 2026-01-01 14:23:45'), text);
    check('E8 stamp has provider/model', !!text && text.includes('codearts/deepseek-v4.1'), text);

    c.resetStamp();
    c.component({ turn: makeTurn({ turn: 43, end: { time: T } }, [
      { provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' },
    ]) });
    check('E9 two models joined', !!c.getStamp() && c.getStamp().includes('a/m1') && c.getStamp().includes('b/m2'), c.getStamp());

    c.resetStamp();
    c.component({ turn: makeTurn({ turn: 44, end: { time: T } }, [
      { provider: 'a', model: 'm1' }, { provider: 'a', model: 'm1' },
    ]) });
    check('E10 duplicate routes deduped', !!c.getStamp() && c.getStamp().indexOf('a/m1') === c.getStamp().lastIndexOf('a/m1'), c.getStamp());

    c.resetStamp();
    c.component({ turn: makeTurn({ turn: 45, end: { time: T } }, []) });
    check('E11 no routes -> timestamp only (no ｜)', !!c.getStamp() && c.getStamp().includes('结束于') && !c.getStamp().includes('｜'), c.getStamp());

    let threw = false;
    c.resetStamp();
    try {
      c.component({ turn: {
        status: 'closed', turn: 47, end: { time: T },
        data: { get: () => { throw new Error('boom'); } },
      } });
    } catch (e) { threw = true; }
    check('E12 malformed store does not throw & still stamps', !threw && !!c.getStamp() && c.getStamp().includes('结束于'), c.getStamp());
  }

  // -- F. fold fallback behavior -------------------------------------------
  // F1: endpoint unavailable (500 on both paths) -> v1.1.0 (timestamp only).
  {
    const failingFetch = () => Promise.resolve({ ok: false, status: 500 });
    const c = loadClient(failingFetch);
    c.component({ turn: makeTurn({ turn: 2, end: { time: T } }, []), sessionId: 'session-test' });
    await flush(); await flush();
    const text = c.getStamp();
    check('F1 endpoint down -> timestamp only (no crash)', !!text && text.includes('结束于') && !text.includes('｜'), text);
  }

  // F2: endpoint returns fold -> model appears on a no-tokenUsage turn.
  {
    const okFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, turns: [
        { turn: 2, endTime: T, kind: 'interrupted', models: ['workbuddy/hy4free'] },
      ] }),
    });
    const c = loadClient(okFetch);
    c.component({ turn: makeTurn({ turn: 2, end: { time: T } }, []), sessionId: 'session-test' });
    // First synchronous patch stamps timestamp only; fold arrives async -> repatch.
    const before = c.getStamp();
    await flush(); await flush(); await flush();
    const after = c.getStamp();
    check('F2 before fold -> timestamp only', !!before && !before.includes('｜'), before);
    check('F2 after fold -> model appended', !!after && after.includes('workbuddy/hy4free'), after);
  }

  // F3: endTime mismatch (>5min) -> fold model NOT applied (anti-mislabel).
  {
    const okFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, turns: [
        { turn: 2, endTime: T + 400000, kind: 'interrupted', models: ['workbuddy/hy4free'] },
      ] }),
    });
    const c = loadClient(okFetch);
    c.component({ turn: makeTurn({ turn: 2, end: { time: T } }, []), sessionId: 'session-test' });
    await flush(); await flush(); await flush();
    const text = c.getStamp();
    check('F3 endTime mismatch -> model suppressed', !!text && text.includes('结束于') && !text.includes('hy4free'), text);
  }

  // F4: fold for a DIFFERENT turn -> not applied to this turn.
  {
    const okFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, turns: [
        { turn: 9, endTime: T, kind: 'completed', models: ['other/model'] },
      ] }),
    });
    const c = loadClient(okFetch);
    c.component({ turn: makeTurn({ turn: 2, end: { time: T } }, []), sessionId: 'session-test' });
    await flush(); await flush(); await flush();
    const text = c.getStamp();
    check('F4 wrong turn -> model suppressed', !!text && !text.includes('other/model'), text);
  }

  // F5: turn WITH tokenUsage.routes -> prefers that model, fold not consulted.
  {
    const okFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, turns: [
        { turn: 2, endTime: T, kind: 'completed', models: ['fold/model'] },
      ] }),
    });
    const c = loadClient(okFetch);
    c.component({
      turn: makeTurn({ turn: 2, end: { time: T } }, [{ provider: 'tail', model: 'primary' }]),
      sessionId: 'session-test',
    });
    await flush(); await flush(); await flush();
    const text = c.getStamp();
    check('F5 prefers turn-tail model over fold', !!text && text.includes('tail/primary') && !text.includes('fold/model'), text);
  }

  // F6: second FOLD_PATH reached when first returns unusable payload.
  {
    const paths = [];
    const twoPathFetch = (path) => {
      paths.push(path);
      if (path === H.PATH) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: false }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, turns: [
        { turn: 2, endTime: T, kind: 'interrupted', models: ['second/hy4free'] },
      ] }) });
    };
    const c = loadClient(twoPathFetch);
    c.component({ turn: makeTurn({ turn: 2, end: { time: T } }, []), sessionId: 'session-test' });
    await flush(); await flush(); await flush();
    check('F6 tries both fold paths', paths.length === 2 && paths[0] === H.PATH && paths[1] === H.API_PATH, paths);
    check('F6 fallback path supplies model', !!c.getStamp() && c.getStamp().includes('second/hy4free'), c.getStamp());
  }

  // -- G. v1.3 elapsed duration on stopped/errored turns ------------------
  // The duration is rendered in its OWN node inside the label, immediately
  // before the timestamp/model stamp -- the same slot DSH reserves for the
  // duration of a "已完成，用时 X秒" reply. The model stamp is never displaced.
  {
    const c = loadClient(undefined);
    const end = T;

    // error turn: duration node carries the text, formatted like DSH (1分5秒).
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 60, start: { time: end - 65000 },
      end: { time: end, data: { reason: { kind: 'error' } } },
    }) });
    let dur = c.getDuration();
    let text = c.getStamp();
    check('G1 error turn duration node = ，用时 1分5秒', !!dur && dur.includes('用时') && dur.includes('1分5秒'), dur);
    check('G1b error turn stamp keeps timestamp (no 用时)', !!text && text.includes('结束于') && !text.includes('用时'), text);
    check('G1c duration node sits BEFORE the stamp', c.getLabelOrder().join(',') === 'duration,inline', c.getLabelOrder());
    // v1.3.2 typography: the duration node must NOT override font-size (DSH's
    // .hE4tRW_label is font-size: inherit); numeric segments carry DSH's
    // durationNumber font (--ds-font-family-code + tabular-nums); units keep
    // the reply label font.
    const dn = c.getDurationNode();
    const nums = ((dn && dn.children) || []).filter((x) => x.nodeType === 1);
    check('G1d duration node has NO font-size override', !!dn && dn.style.cssText.indexOf('font-size') < 0, dn && dn.style.cssText);
    check('G1e numeric segments use DSH durationNumber font', nums.length === 2 && nums.every((x) => x.style.cssText.indexOf('--ds-font-family-code') >= 0 && x.style.cssText.indexOf('tabular-nums') >= 0), nums.map((x) => x.style.cssText));
    check('G1f duration node matches DSH color (no opacity)', !!dn && dn.style.cssText.indexOf('opacity') < 0 && dn.style.cssText.indexOf('--dsw-alias-label-tertiary') >= 0, dn && dn.style.cssText);

    // interrupted turn (< 60s) -> seconds only.
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 61, start: { time: end - 3000 },
      end: { time: end, data: { reason: { kind: 'interrupted' } } },
    }) });
    dur = c.getDuration();
    text = c.getStamp();
    check('G2 interrupted turn duration = ，用时 3秒', !!dur && dur.includes('用时') && dur.includes('3秒'), dur);
    check('G2b interrupted turn stamp has no 用时', !!text && !text.includes('用时'), text);

    // aborted turn >= 1h -> hours + minutes + seconds.
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 62, start: { time: end - 3661000 },
      end: { time: end, data: { reason: { kind: 'aborted' } } },
    }) });
    dur = c.getDuration();
    check('G3 aborted turn duration = ，用时 1小时1分1秒', !!dur && dur.includes('用时') && dur.includes('1小时1分1秒'), dur);

    // completed turn: DSH already shows the duration, so we must NOT add it.
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 63, start: { time: end - 65000 },
      end: { time: end, data: { reason: { kind: 'completed' } } },
    }) });
    dur = c.getDuration();
    text = c.getStamp();
    check('G4 completed turn has NO duration node', dur === null, dur);
    check('G4b completed turn stamp intact', !!text && text.includes('结束于') && !text.includes('用时'), text);

    // no start time -> no duration node, but stamp is intact (no crash).
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 64, end: { time: end, data: { reason: { kind: 'error' } } },
    }) });
    dur = c.getDuration();
    text = c.getStamp();
    check('G5 missing start -> no duration node, stamp intact', dur === null && !!text && text.includes('结束于'), { dur, text });

    // zero span -> clamped to DSH's 1s minimum.
    c.resetStamp();
    c.component({ turn: makeTurn({
      turn: 65, start: { time: end }, end: { time: end, data: { reason: { kind: 'error' } } },
    }) });
    dur = c.getDuration();
    check('G6 zero span clamped to ，用时 1秒', !!dur && dur.includes('用时') && dur.includes('1秒'), dur);

    // fold startTime fallback when the turn object has no start.
    const okFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, turns: [
        { turn: 70, startTime: T - 65000, endTime: T, kind: 'error', models: [] },
      ] }),
    });
    const c2 = loadClient(okFetch);
    c2.component({
      turn: makeTurn({ turn: 70, end: { time: T, data: { reason: { kind: 'error' } } } }),
      sessionId: 'session-test',
    });
    await flush(); await flush(); await flush();
    dur = c2.getDuration();
    text = c2.getStamp();
    check('G7 fold startTime fallback duration = ，用时 1分5秒', !!dur && dur.includes('用时') && dur.includes('1分5秒'), dur);
    check('G7b fold fallback stamp keeps model', !!text && text.includes('结束于'), text);
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('SELFTEST CRASHED:', e && e.stack ? e.stack : e);
  process.exit(2);
});
