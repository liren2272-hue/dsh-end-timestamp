// Headless unit test for client.js — mocks window/__ModuleLoader__ + React
// and asserts the tail occupant no longer renders a tail (timestamp + model
// live only inline in the "已完成" line via DOM patch), while the DOM
// patch path runs without throwing. Also unit-tests the model formatter.
import { readFileSync } from 'node:fs';

// Canonical source is the dsh-plugins checkout (symlinked into the profile).
const src = readFileSync(
  'C:/Users/15940/Documents/dsh-plugins/dsh-end-timestamp/client.js',
  'utf8'
);

const captured = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      captured.push(spec);
    },
  },
};

// Mock DOM capturing the stamp span so we can assert its text.
let stampSpan = null;
const mockLabel = {
  querySelector: (sel) =>
    sel === ':scope > span[data-end-timestamp-inline]' ? stampSpan : null,
  appendChild(node) {
    stampSpan = node;
  },
};
const mockBtn = {
  nodeType: 1,
  querySelector: (sel) => (sel === ':scope > span' ? mockLabel : null),
};
const fakeDocument = {
  querySelector: (sel) => (sel && sel.indexOf('data-turn-process') >= 0 ? mockBtn : null),
  createElement: (tag) => ({
    setAttribute() {},
    style: { cssText: '' },
    textContent: '',
  }),
};
globalThis.document = fakeDocument;
globalThis.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
};

const require = (id) => {
  if (id === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      // Run effects synchronously so the DOM-patch path executes in tests.
      useEffect: (cb, deps) => {
        cb();
      },
    };
  }
  throw new Error('unexpected require ' + id);
};

// Run the client module in a function scope with our fakes in place.
const runner = new Function('window', 'require', src);
runner(fakeWindow, require);

const spec = captured[0];
if (!spec || spec.id !== '@local/dsh-end-timestamp') {
  console.error('FAIL: loader did not register our module. captured=', captured);
  process.exit(1);
}

const plugin = spec.factory(require);

let component = null;
let registeredSlot = null;
const realishSlots = {
  inject(slot, fn) {
    registeredSlot = slot;
    component = fn();
  },
  register(opts, comp) {
    return comp;
  },
};
plugin.apply({ slots: realishSlots });

if (registeredSlot !== 'conversation.chat.turnTail') {
  console.error('FAIL: did not inject conversation.chat.turnTail. slot=', registeredSlot);
  process.exit(1);
}
if (typeof component !== 'function') {
  console.error('FAIL: injected factory did not return the tail component.');
  process.exit(1);
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log('PASS:', label);
  } else {
    console.error('FAIL:', label);
    failures++;
  }
}

check('injects turnTail slot', true);
check('component is a function', typeof component === 'function');

// Fake turn data store holding a "turn-tail" entry with tokenUsage.routes.
function makeTurn(over, routes) {
  const tail = routes === undefined ? null : { tokenUsage: { routes } };
  const store = {
    get: (key) => (key === 'turn-tail' ? tail : undefined),
    source: () => ({ subscribe: () => () => {} }),
  };
  return Object.assign({ status: 'closed', data: store }, over);
}

const base = (over) => ({ turn: makeTurn(over) });

// Tail is no longer rendered (timestamp + model live inline only).
let r = component(base({ end: { time: new Date('2026-01-01T14:23:45').getTime() } }));
check('no tail span rendered', r === null);

r = component(base({ status: 'closed', end: undefined }));
check('null when end missing', r === null);

r = component(base({ status: 'running' }));
check('null when not closed', r === null);

r = component(base({ status: 'closed', end: { time: 'not-a-number' } }));
check('null when end.time not number', r === null);

r = component({ turn: undefined });
check('null when turn missing', r === null);

// DOM-patch path: stamp must include end time and the model when present.
function runPatch(turn) {
  stampSpan = null;
  component({ turn });
  return stampSpan && stampSpan.textContent;
}

// With a single route -> "provider/model".
let text = runPatch(
  makeTurn({ turn: 42, end: { time: new Date('2026-01-01T14:23:45').getTime() } }, [
    { provider: 'codearts', model: 'deepseek-v4.1' },
  ])
);
check('stamp includes end time', !!text && text.includes('结束于 2026-01-01 14:23:45'));
check('stamp includes provider/model', !!text && text.includes('codearts/deepseek-v4.1'));

// With two distinct routes -> both, comma-joined.
text = runPatch(
  makeTurn({ turn: 43, end: { time: new Date('2026-01-01T14:23:45').getTime() } }, [
    { provider: 'a', model: 'm1' },
    { provider: 'b', model: 'm2' },
  ])
);
check('stamp lists two models', !!text && text.includes('a/m1') && text.includes('b/m2'));

// Duplicate routes are deduped.
text = runPatch(
  makeTurn({ turn: 44, end: { time: new Date('2026-01-01T14:23:45').getTime() } }, [
    { provider: 'a', model: 'm1' },
    { provider: 'a', model: 'm1' },
  ])
);
check('duplicate routes deduped', !!text && text.indexOf('a/m1') === text.lastIndexOf('a/m1'));

// No routes / no store -> timestamp only, no trailing separator.
text = runPatch(
  makeTurn({ turn: 45, end: { time: new Date('2026-01-01T14:23:45').getTime() } }, [])
);
check(
  'no routes -> timestamp only, no model separator',
  !!text && text.includes('结束于') && !text.includes('｜')
);
text = runPatch({
  status: 'closed',
  turn: 46,
  end: { time: new Date('2026-01-01T14:23:45').getTime() },
  data: { get: () => undefined },
});
check('empty tail -> timestamp only', !!text && text.includes('结束于') && !text.includes('｜'));

// A malformed store must not throw and still yield the timestamp.
let threw = false;
try {
  text = runPatch({
    status: 'closed',
    turn: 47,
    end: { time: new Date('2026-01-01T14:23:45').getTime() },
    data: {
      get: () => {
        throw new Error('boom');
      },
    },
  });
} catch (e) {
  threw = true;
  console.error('THREW:', e && e.message);
}
check('malformed store does not throw', !threw && !!text && text.includes('结束于'));

console.log(failures === 0 ? '\\nALL PASS' : `\\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
