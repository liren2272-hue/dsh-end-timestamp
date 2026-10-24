// Headless unit test for client.js — mocks window/__ModuleLoader__ + React
// and asserts the tail occupant no longer renders a tail (timestamp now
// lives only inline in the "已完成" line via DOM patch), while the DOM
// patch path runs without throwing.
import { readFileSync } from 'node:fs';

const src = readFileSync(
  'C:/Users/15940/Documents/deepseek-harness/default-workspace/dsh-end-timestamp/client.js',
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

// Mock DOM for the inline DOM-patch path.
const mockLabel = { querySelector: () => null, appendChild() {} };
const mockBtn = { nodeType: 1, querySelector: (sel) => (sel === ':scope > span' ? mockLabel : null) };
const fakeDocument = {
  querySelector: (sel) => (sel && sel.indexOf('data-turn-process') >= 0 ? mockBtn : null),
  createElement: (tag) => ({ setAttribute() {}, style: { cssText: '' }, textContent: '' }),
};
globalThis.document = fakeDocument;
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
};

const require = (id) => {
  if (id === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      // Run effects synchronously so the DOM-patch path executes in tests.
      useEffect: (cb, deps) => { cb(); },
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

const base = (over) => ({ turn: Object.assign({ status: 'closed' }, over) });

// Tail is no longer rendered (timestamp lives inline only).
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

// DOM-patch path must not throw when document/MutationObserver are available.
let threw = false;
try {
  component(base({ turn: 42, end: { time: new Date('2026-01-01T14:23:45').getTime() } }));
} catch (e) {
  threw = true;
  console.error('THREW:', e && e.message);
}
check('DOM-patch path does not throw', !threw);

console.log(failures === 0 ? '\\nALL PASS' : `\\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);