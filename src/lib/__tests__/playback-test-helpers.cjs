// Minimal hook host for isolated state-machine tests. No DOM, Next, network, or DB.
function createHookHost() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { cleanup: effect(), deps };
        });
      }
    },
  };
  return {
    React,
    render(callback) {
      cursor = 0;
      effects = [];
      const result = callback();
      effects.forEach((effect) => effect());
      return result;
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function installBrowser(t, flags = {}) {
  const previousWindow = global.window;
  const previousStorage = global.localStorage;
  const values = new Map();
  global.window = { location: { origin: 'https://site.test' }, RUNTIME_CONFIG: flags };
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  t.after(() => {
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    if (previousStorage === undefined) delete global.localStorage; else global.localStorage = previousStorage;
  });
  return values;
}

module.exports = { createHookHost, installBrowser };
