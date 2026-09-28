const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function startup() {
  const intervals = [];
  const timeouts = [];
  const requests = [];
  const http = {
    get(url, callback) {
      const request = new EventEmitter();
      request.setTimeout = (_ms, handler) => { request.timeout = handler; };
      request.destroy = error => request.emit('error', error);
      requests.push({ url, callback, request });
      return request;
    },
  };
  const filename = path.resolve(__dirname, '../../../start.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename),
    console: { log() {}, error() {} },
    process: { env: { HOSTNAME: '127.0.0.1', PORT: '3000' } },
    require(name) {
      if (name === 'http') return http;
      if (name === 'path') return path;
      return {};
    },
    setInterval(callback, ms) {
      const timer = { callback, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.cleared = true; },
    setTimeout(callback, ms) { timeouts.push({ callback, ms }); },
  });
  return { intervals, timeouts, requests };
}

test('container readiness survives connection refusal and timeout without overlapping probes', () => {
  const fixture = startup();
  const probe = fixture.intervals[0].callback;
  probe();
  probe();
  assert.equal(fixture.requests.length, 1, 'only one readiness probe can be in flight');
  assert.doesNotThrow(() => fixture.requests[0].request.emit('error', new Error('ECONNREFUSED')));
  probe();
  assert.equal(fixture.requests.length, 2, 'a refused probe must be retryable');
  assert.doesNotThrow(() => fixture.requests[1].request.timeout());
  probe();
  assert.equal(fixture.requests.length, 3, 'a timed-out probe must be retryable');
});

test('container drains the readiness response and schedules cron only once', () => {
  const fixture = startup();
  const probe = fixture.intervals[0].callback;
  probe();
  let drained = 0;
  fixture.requests[0].callback({ statusCode: 503, resume() { drained += 1; } });
  assert.equal(fixture.timeouts.length, 0);
  probe();
  fixture.requests[1].callback({ statusCode: 200, resume() { drained += 1; } });
  probe();
  assert.equal(drained, 2);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.intervals[0].cleared, true);
  assert.equal(fixture.intervals.filter(timer => timer.ms === 3600000).length, 1);
  assert.equal(fixture.timeouts.filter(timer => timer.ms === 3000).length, 1);
});
