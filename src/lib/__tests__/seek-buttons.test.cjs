const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSourceLoader } = require('./storage-test-loader.cjs');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.style = {};
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.events = new EventEmitter();
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => {
        this.className = [
          ...new Set([
            ...this.className.split(/\s+/).filter(Boolean),
            ...names,
          ]),
        ].join(' ');
      },
      remove: (...names) => {
        this.className = this.className
          .split(/\s+/)
          .filter((name) => !names.includes(name))
          .join(' ');
      },
    };
    this.dataset = new Proxy(
      {},
      {
        get: (_, name) =>
          this.getAttribute(
            `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
          ) ?? undefined,
        set: (_, name, value) => {
          this.setAttribute(
            `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
            value,
          );
          return true;
        },
        deleteProperty: (_, name) => {
          this.removeAttribute(
            `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
          );
          return true;
        },
      },
    );
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'hidden' || name === 'disabled') this[name] = true;
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden' || name === 'disabled') this[name] = false;
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((part) => part.trim());
    const matches = (element) =>
      selectors.some((part) => {
        if (part.startsWith('.'))
          return element.classList.contains(part.slice(1));
        if (part.startsWith('#')) return element.id === part.slice(1);
        return part === '*' || element.tagName === part.toUpperCase();
      });
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(name, handler) {
    this.events.on(name, handler);
  }

  removeEventListener(name, handler) {
    this.events.off(name, handler);
  }

  click() {
    // Native buttons do not dispatch click events when disabled.
    if (this.disabled) return;
    const event = {
      type: 'click',
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    };
    this.onclick?.(event);
    this.events.emit('click', event);
  }
}

function installBrowser(t, width = 1280) {
  const previous = ['document', 'window'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  const document = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      return (
        this.head.querySelector(`#${id}`) ?? this.body.querySelector(`#${id}`)
      );
    },
  };
  const window = { innerWidth: width };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: window,
  });
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { document, window };
}

function createPlayer(options = {}) {
  const player = document.createElement('div');
  const controlBar = document.createElement('div');
  const controlOptions = [];
  player.className = 'art-video-player';
  player.appendChild(controlBar);
  document.body.appendChild(player);

  const art = new EventEmitter();
  art.currentTime = 60;
  art.duration = 120;
  art.isLock = false;
  art.isDestroy = false;
  art.notice = {};
  art.template = { $player: player };
  art.controls = {
    show: true,
    add(option) {
      controlOptions.push(option);
      assert.equal(
        this[option.name],
        undefined,
        `duplicate control: ${option.name}`,
      );
      const element = document.createElement('div');
      element.className = `art-control art-control-${option.name}`;
      element.innerHTML = option.html;
      if (option.tooltip) element.setAttribute('aria-label', option.tooltip);
      element.addEventListener('click', (event) =>
        option.click?.call(art, event),
      );
      this[option.name] = element;
      controlBar.appendChild(element);
      option.mounted?.call(art, element);
    },
  };
  Object.defineProperty(art, 'seek', {
    get: () => art.currentTime,
    set: (value) => {
      art.currentTime = value;
    },
  });

  const plugin = createSourceLoader()(
    'artplayer-plugin-seek-buttons.js',
  ).default(options)(art);
  art.isReady = true;
  art.emit('ready');
  return { art, plugin, player, controlOptions };
}

function floatingButtons(player) {
  const buttons = player.querySelectorAll(
    '.art-seek-floating-left, .art-seek-floating-right',
  );
  assert.equal(
    buttons.length,
    2,
    'both seek directions stay available without duplicate buttons',
  );
  assert.ok(
    buttons.every((button) => button.tagName === 'BUTTON'),
    'each direction is a native button',
  );
  const backward = player.querySelector('.art-seek-floating-left');
  const forward = player.querySelector('.art-seek-floating-right');
  assert.ok(backward);
  assert.ok(forward);
  assert.notEqual(backward, forward);
  return { backward, forward };
}

function allButtons({ art, player }) {
  const floating = floatingButtons(player);
  const buttons = [
    { button: art.controls['seek-backward'], direction: -1, label: '后退' },
    { button: art.controls['seek-forward'], direction: 1, label: '前进' },
    { button: floating.backward, direction: -1, label: '后退' },
    { button: floating.forward, direction: 1, label: '前进' },
  ];
  assert.ok(
    buttons.every(({ button }) => button),
    'desktop and floating controls are both mounted',
  );
  return buttons;
}

function assertVisible(player, visible) {
  for (const button of Object.values(floatingButtons(player))) {
    assert.equal(button.hidden, !visible);
    assert.equal(button.disabled, !visible);
  }
}

test('void-returning controls.add initializes named controls in playback order', (t) => {
  installBrowser(t);
  const fixture = createPlayer({ seekTime: 10 });
  assert.deepEqual(
    fixture.controlOptions.map(({ name, index }) => ({ name, index })),
    [
      { name: 'seek-backward', index: 15 },
      { name: 'seek-forward', index: 16 },
    ],
  );
  allButtons(fixture);
  fixture.plugin.config({ seekTime: 15 });
  fixture.art.controls['seek-backward'].click();
  assert.equal(fixture.art.currentTime, 45);
});

test('resizing after desktop creation keeps both sets of labels, icons, and seek actions current', (t) => {
  const { window } = installBrowser(t);
  const fixture = createPlayer({ seekTime: 10 });
  assert.equal(fixture.plugin.name, 'artplayerPluginSeekButtons');
  allButtons(fixture);

  for (const [width, seekTime] of [
    [390, 30],
    [1440, 5],
  ]) {
    window.innerWidth = width;
    fixture.plugin.config({ seekTime });
    for (const { button, direction, label } of allButtons(fixture)) {
      assert.equal(
        button.getAttribute('aria-label'),
        `${label} ${seekTime} 秒`,
      );
      assert.match(
        button.innerHTML,
        new RegExp(`<text\\b[^>]*>\\s*${seekTime}\\s*</text>`),
      );
      fixture.art.currentTime = 60;
      button.click();
      assert.equal(fixture.art.currentTime, 60 + direction * seekTime);
    }
  }
});

test('desktop and floating seek actions clamp to the start and duration', (t) => {
  installBrowser(t, 390);
  const fixture = createPlayer({ seekTime: 30 });
  for (const { button, direction } of allButtons(fixture)) {
    fixture.art.currentTime = direction < 0 ? 5 : 115;
    button.click();
    assert.equal(
      fixture.art.currentTime,
      direction < 0 ? 0 : fixture.art.duration,
    );
  }
});

test('changing the mobile layout keeps two independent directions and affects only its player', (t) => {
  const { document } = installBrowser(t, 390);
  document.body.setAttribute('data-seek-layout', 'external');
  const fixture = createPlayer({ mobileLayout: 'both', seekTime: 10 });
  const other = createPlayer({ mobileLayout: 'right' });

  for (const mobileLayout of ['left', 'right', 'both', 'left', 'both']) {
    fixture.plugin.config({ mobileLayout });
    assert.equal(fixture.player.getAttribute('data-seek-layout'), mobileLayout);
    assert.equal(other.player.getAttribute('data-seek-layout'), 'right');
    assert.equal(document.body.getAttribute('data-seek-layout'), 'external');
    for (const { button, direction } of allButtons(fixture)) {
      fixture.art.currentTime = 60;
      button.click();
      assert.equal(fixture.art.currentTime, 60 + direction * 10);
    }
    floatingButtons(other.player);
  }
});

test('hidden controls and locking disable floating buttons across configuration changes', (t) => {
  installBrowser(t, 390);
  const { art, plugin, player } = createPlayer();
  assertVisible(player, true);

  art.controls.show = false;
  art.emit('control', false);
  plugin.config({ mobileLayout: 'right' });
  assertVisible(player, false);

  art.controls.show = true;
  art.emit('control', true);
  assertVisible(player, true);
  art.isLock = true;
  art.emit('lock', true);
  plugin.config({ mobileLayout: 'left', seekTime: 30 });
  assertVisible(player, false);
  for (const button of Object.values(floatingButtons(player))) {
    button.click();
    assert.equal(art.currentTime, 60, 'disabled floating buttons cannot seek');
  }

  art.controls.show = false;
  art.emit('control', false);
  art.isLock = false;
  art.emit('lock', false);
  assertVisible(player, false);
  art.controls.show = true;
  art.emit('control', true);
  assertVisible(player, true);
  floatingButtons(player).forward.click();
  assert.equal(
    art.currentTime,
    90,
    'unlocking restores the latest configured seek action',
  );
});

test('destroy removes floating buttons and layout state without changing another player', (t) => {
  const { document } = installBrowser(t);
  const fixture = createPlayer({ mobileLayout: 'left' });
  const other = createPlayer({ mobileLayout: 'right' });
  floatingButtons(fixture.player);
  fixture.art.isDestroy = true;
  fixture.art.emit('destroy');

  assert.equal(
    fixture.player.querySelectorAll(
      '.art-seek-floating-left, .art-seek-floating-right',
    ).length,
    0,
  );
  assert.equal(fixture.player.getAttribute('data-seek-layout'), null);
  assert.equal(document.body.getAttribute('data-seek-layout'), null);
  assert.equal(other.player.getAttribute('data-seek-layout'), 'right');
  floatingButtons(other.player);
});
