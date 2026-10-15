import assert from 'node:assert/strict';
import test from 'node:test';
import { BABOT_CONNECTION_LOCK, ConnectionManager } from '../src/connection-manager.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const failure = (code, retryable = false) => Object.assign(new Error(`Connection ${code}`), { code, retryable });

// The callback's promise owns the lock, matching Web Locks: returning from
// request() is not the lease, and no unavailable request queues or steals it.
function sharedLocks() {
  const held = new Set(), requests = [];
  return {
    held, requests,
    async request(name, options, callback) {
      requests.push({ name, options });
      assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name, mode: 'exclusive' }); }
      finally { held.delete(name); }
    },
  };
}

function fakeClock() {
  let next = 0;
  const timers = new Map(), delays = [];
  return {
    timers, delays,
    setTimeout(callback, delay) { const id = ++next; delays.push(delay); timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance() {
      assert.equal(timers.size, 1, 'one bounded backoff timer should be pending');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id); callback(); await flush();
    },
  };
}

function setup(options = {}) {
  const calls = [], states = [], invalidations = [];
  const controller = {
    async connect() { calls.push('connect'); return true; },
    async reconnect() { calls.push('reconnect'); return true; },
    async disconnect() { calls.push('disconnect'); },
    start() { assert.fail('connection recovery must never ARM'); },
    updatePose() { assert.fail('connection recovery must never send poses'); },
    ...options.controller,
  };
  const locks = options.locks ?? sharedLocks();
  const manager = new ConnectionManager(controller, {
    locks, onState: state => states.push(state),
    onInvalidatePlayback: reason => invalidations.push(reason),
    isVisible: () => true, ...options,
  });
  return { manager, controller, calls, states, invalidations, locks };
}

test('startup and wake use remembered reconnect only; successful explicit Connect preserves its new Play token', async () => {
  const a = setup();
  assert.equal(await a.manager.start(), true);
  assert.equal(await a.manager.recover('Computer woke'), true);
  assert.deepEqual(a.calls, ['reconnect', 'reconnect']);
  assert.equal(a.invalidations.length, 2);
  assert.equal(a.manager.state.owner, true);
  assert.equal(a.manager.state.phase, 'ready');
  await a.manager.dispose();

  const b = setup();
  assert.equal(await b.manager.connect(), true);
  assert.deepEqual(b.calls, ['connect']);
  assert.deepEqual(b.invalidations, []);
  await b.manager.dispose();
});

test('two tabs never share the port and ownership lasts until actual close completes', async () => {
  const locks = sharedLocks(), closed = deferred();
  const a = setup({ locks }), b = setup({ locks });
  await a.manager.connect();
  assert.equal(await b.manager.start(), false);
  assert.equal(b.manager.state.phase, 'owned-elsewhere');
  assert.match(b.manager.state.message, /read-only/);
  assert.deepEqual(b.calls, []);
  assert.equal(await b.manager.connect(), false);
  a.controller.disconnect = () => closed.promise;
  const disconnecting = a.manager.disconnect();
  await flush();
  assert.equal(locks.held.has(BABOT_CONNECTION_LOCK), true);
  assert.equal(await b.manager.connect(), false);
  closed.resolve();
  assert.equal(await disconnecting, true);
  await flush();
  assert.equal(await b.manager.connect(), true);
  assert.deepEqual(b.calls, ['connect']);
  assert.equal(a.manager.state.owner, false);
  await b.manager.dispose();
});

test('StrictMode immediate mount, dispose and remount submits only the live ownership request', async () => {
  const locks = sharedLocks(), first = setup({ locks }), remount = setup({ locks });
  const abandoned = first.manager.start();
  const disposed = first.manager.dispose();
  const ready = remount.manager.start();
  assert.equal(await abandoned, false);
  assert.equal(await disposed, true);
  assert.equal(await ready, true);
  assert.equal(locks.requests.length, 1);
  assert.deepEqual(first.calls, ['disconnect']);
  assert.deepEqual(remount.calls, ['reconnect']);
  assert.equal(remount.manager.state.phase, 'ready');
  await remount.manager.dispose();
});

test('delayed board readiness gets bounded backoff while retaining ownership and never choosing or arming', async () => {
  const clock = fakeClock(), locks = sharedLocks();
  const a = setup({ ...clock, locks, retryDelaysMs: [40, 120] }), b = setup({ locks });
  let attempts = 0;
  a.controller.reconnect = async () => { a.calls.push('reconnect'); if (++attempts < 3) throw failure('timeout', true); return true; };
  const ready = a.manager.start();
  await flush();
  assert.equal(a.manager.state.phase, 'retrying');
  assert.equal(a.manager.state.attempt, 1);
  assert.equal(await b.manager.connect(), false);
  await clock.advance();
  assert.equal(a.manager.state.attempt, 2);
  await clock.advance();
  assert.equal(await ready, true);
  assert.deepEqual(clock.delays, [40, 120]);
  assert.deepEqual(a.calls, ['reconnect', 'reconnect', 'reconnect']);
  assert.equal(clock.timers.size, 0);
  await a.manager.dispose();
});

test('retry exhaustion closes and releases once without leaving an endless timer', async () => {
  const clock = fakeClock(), a = setup({ ...clock, retryDelaysMs: [10, 20] });
  a.controller.reconnect = async () => { a.calls.push('reconnect'); throw failure('device-missing', true); };
  const ready = a.manager.start();
  await flush(); await clock.advance(); await clock.advance();
  assert.equal(await ready, false);
  assert.deepEqual(a.calls, ['reconnect', 'reconnect', 'reconnect', 'disconnect']);
  assert.equal(a.manager.state.phase, 'fault');
  assert.equal(a.manager.state.owner, false);
  assert.equal(clock.timers.size, 0);
  assert.equal(a.locks.held.size, 0);
});

test('explicit disconnect cancels backoff and disables plug, wake and fault recovery', async () => {
  const clock = fakeClock(), a = setup({ ...clock });
  a.controller.reconnect = async () => { a.calls.push('reconnect'); throw failure('timeout', true); };
  const attempt = a.manager.start();
  await flush();
  assert.equal(clock.timers.size, 1);
  await a.manager.disconnect();
  assert.equal(await attempt, false);
  assert.equal(clock.timers.size, 0);
  assert.equal(await a.manager.recover('USB plugged in'), false);
  assert.equal(await a.manager.recover('Visible after wake'), false);
  a.manager.handleStatus('fault', false);
  await flush();
  assert.deepEqual(a.calls, ['reconnect', 'disconnect']);
  a.controller.connect = async () => { a.calls.push('connect'); return true; };
  assert.equal(await a.manager.connect(), true);
  assert.equal(a.manager.enabled, true);
  await a.manager.dispose();
});

test('transport faults during an explicit attempt invalidate pending Play even when retry succeeds', async () => {
  const clock = fakeClock(), a = setup({ ...clock, retryDelaysMs: [1] });
  a.controller.connect = async () => {
    a.calls.push('connect');
    a.manager.handleStatus('fault', false);
    throw failure('timeout', true);
  };
  const attempt = a.manager.connect();
  await flush(); await clock.advance();
  assert.equal(await attempt, true);
  assert.deepEqual(a.calls, ['connect', 'disconnect', 'reconnect']);
  assert.ok(a.invalidations.length >= 1);
  assert.equal(a.manager.state.phase, 'ready');
  await a.manager.dispose();
});

test('idle transport faults coalesce into a PING-only recovery and invalidate old intent', async () => {
  const a = setup(), probe = deferred();
  await a.manager.connect();
  a.controller.reconnect = () => { a.calls.push('reconnect'); return probe.promise; };
  a.manager.handleStatus('fault', false);
  a.manager.handleStatus('disconnected', false);
  await flush();
  assert.deepEqual(a.calls, ['connect', 'disconnect', 'reconnect']);
  assert.ok(a.invalidations.length >= 1);
  probe.resolve(true); await flush();
  assert.equal(a.manager.state.phase, 'ready');
  await a.manager.dispose();
});

test('runtime fault waits for delayed OFF and actual closure before automatic reconnect', async () => {
  const a = setup(), offAndClosed = deferred();
  await a.manager.connect();
  let returning = true;
  a.controller.disconnect = async () => { a.calls.push('disconnect'); await offAndClosed.promise; returning = false; };
  a.controller.reconnect = async () => { a.calls.push('reconnect'); return !returning; };
  a.manager.handleStatus('fault', false);
  await flush();
  assert.deepEqual(a.calls, ['connect', 'disconnect']);
  assert.equal(a.manager.state.owner, true, 'port lease lasts through level return and actual close');
  offAndClosed.resolve(); await flush();
  assert.deepEqual(a.calls, ['connect', 'disconnect', 'reconnect']);
  assert.equal(a.manager.state.phase, 'ready');
  assert.equal(a.states.some(state => state.phase === 'permission-required'), false);
  await a.manager.dispose();
});

test('wake during motion waits for the returning session to close before fresh PING', async () => {
  const a = setup(), closed = deferred();
  await a.manager.connect();
  a.manager.handleStatus('following', true);
  a.controller.disconnect = async () => { a.calls.push('disconnect'); await closed.promise; };
  const wake = a.manager.recover('Computer woke');
  await flush();
  assert.deepEqual(a.calls, ['connect', 'disconnect']);
  a.manager.handleStatus('stopping', true);
  closed.resolve();
  assert.equal(await wake, true);
  assert.deepEqual(a.calls, ['connect', 'disconnect', 'reconnect']);
  await a.manager.dispose();
});

test('fault arriving inside a pending probe cannot be reported as permission loss or Ready', async () => {
  const clock = fakeClock(), a = setup({ ...clock, retryDelaysMs: [1] });
  await a.manager.connect();
  const probing = deferred(); let probes = 0;
  a.controller.reconnect = () => { a.calls.push('reconnect'); return ++probes === 1 ? probing.promise : Promise.resolve(true); };
  const recovering = a.manager.recover('USB changed'); await flush();
  a.manager.handleStatus('fault', false);
  probing.resolve(false); await flush();
  assert.equal(a.manager.state.phase, 'retrying');
  assert.equal(a.states.some(state => state.phase === 'permission-required'), false);
  await clock.advance();
  assert.equal(await recovering, true);
  assert.deepEqual(a.calls, ['connect', 'reconnect', 'disconnect', 'reconnect']);
  await a.manager.dispose();
});

for (const [code, phase] of [['cancelled', 'disconnected'], ['permission-denied', 'permission-required'], ['port-busy', 'port-busy'], ['firmware-mismatch', 'fault'], ['unsupported', 'unsupported']]) {
  test(`${code} is not retried and clears intent before releasing ownership`, async () => {
    const clock = fakeClock(), a = setup({ ...clock });
    a.controller.connect = async () => { a.calls.push('connect'); throw failure(code); };
    assert.equal(await a.manager.connect(), false);
    assert.deepEqual(a.calls, ['connect', 'disconnect']);
    assert.equal(a.manager.state.phase, phase);
    assert.equal(a.manager.state.owner, false);
    assert.equal(clock.timers.size, 0);
    assert.equal(a.invalidations.length, 1);
    if (code === 'port-busy') assert.match(a.manager.state.message, /another tab, browser, or application/);
  });
}

test('cancelling an in-flight open never publishes stale Ready and holds ownership through closure', async () => {
  const opening = deferred(), closing = deferred(), locks = sharedLocks();
  const a = setup({ locks }), b = setup({ locks });
  a.controller.connect = () => opening.promise;
  a.controller.disconnect = () => closing.promise;
  const attempt = a.manager.connect(); await flush();
  const stopped = a.manager.disconnect(); await flush();
  assert.equal(await attempt, false);
  assert.equal(await b.manager.connect(), false);
  opening.resolve(true); await flush();
  assert.equal(a.states.some(state => state.phase === 'ready'), false);
  closing.resolve(); await stopped; await flush();
  assert.equal(await b.manager.connect(), true);
  await b.manager.dispose();
});

test('pagehide releases USB and immediate wake waits for close before PING-only recovery', async () => {
  const a = setup(), closing = deferred();
  await a.manager.start();
  a.controller.disconnect = () => { a.calls.push('disconnect'); return closing.promise; };
  const hidden = a.manager.suspend();
  const wake = a.manager.recover('Page visible');
  await flush();
  assert.deepEqual(a.calls, ['reconnect', 'disconnect']);
  closing.resolve();
  assert.equal(await hidden, true);
  assert.equal(await wake, true);
  assert.deepEqual(a.calls, ['reconnect', 'disconnect', 'reconnect']);
  assert.equal(a.manager.state.owner, true);
  await a.manager.dispose();
});

test('wake racing a cancelled startup waits for the old generation before reconnecting', async () => {
  const a = setup(), oldOpen = deferred(), closing = deferred();
  a.controller.reconnect = () => { a.calls.push('reconnect'); return a.calls.length === 1 ? oldOpen.promise : Promise.resolve(true); };
  const startup = a.manager.start(); await flush();
  a.controller.disconnect = () => { a.calls.push('disconnect'); return closing.promise; };
  const hidden = a.manager.suspend(), wake = a.manager.recover('Page visible');
  await flush();
  assert.equal(await startup, false);
  closing.resolve(); await hidden;
  assert.equal(await wake, true);
  oldOpen.resolve(true); await flush();
  assert.equal(a.states.filter(state => state.phase === 'ready').length, 1);
  await a.manager.dispose();
});

test('dispose during a delayed ownership callback cannot later acquire or open USB', async () => {
  const claim = deferred();
  const a = setup({ locks: { async request(_name, _options, callback) { await claim.promise; return callback({ name: BABOT_CONNECTION_LOCK }); } } });
  const attempt = a.manager.start(); await flush();
  await a.manager.dispose();
  assert.equal(await attempt, false);
  claim.resolve(); await flush();
  assert.equal(await a.manager.connect(), false);
  assert.equal(await a.manager.recover(), false);
  assert.deepEqual(a.calls, ['disconnect']);
  assert.equal(a.manager.state.owner, false);
});

test('failed port closure retains exclusive ownership until a successful disconnect retry', async () => {
  const locks = sharedLocks(), a = setup({ locks }), b = setup({ locks });
  await a.manager.connect();
  a.controller.disconnect = async () => { throw new Error('Port close failed'); };
  assert.equal(await a.manager.disconnect(), false);
  assert.equal(a.manager.state.phase, 'close-failed');
  assert.equal(a.manager.state.owner, true);
  assert.equal(await b.manager.connect(), false);
  assert.equal(await a.manager.connect(), false);
  assert.deepEqual(a.calls, ['connect']);
  a.controller.disconnect = async () => {};
  assert.equal(await a.manager.disconnect(), true);
  await flush();
  assert.equal(await b.manager.connect(), true);
  await b.manager.dispose();
});

test('no remembered permission releases ownership; an explicit pending Connect can choose once', async () => {
  const a = setup();
  a.controller.reconnect = async () => { a.calls.push('reconnect'); return false; };
  assert.equal(await a.manager.start(), false);
  assert.equal(a.manager.state.phase, 'permission-required');
  assert.equal(a.manager.state.owner, false);
  const lookup = deferred();
  a.controller.reconnect = () => { a.calls.push('reconnect'); return lookup.promise; };
  const automatic = a.manager.recover(); await flush();
  const manual = a.manager.connect();
  lookup.resolve(false);
  assert.equal(await automatic, true);
  assert.equal(await manual, true);
  assert.deepEqual(a.calls, ['reconnect', 'disconnect', 'reconnect', 'connect']);
  await a.manager.dispose();
});

test('hidden recovery, unavailable locks and failed lock requests never open USB', async () => {
  const hidden = setup({ isVisible: () => false });
  assert.equal(await hidden.manager.start(), false);
  assert.deepEqual(hidden.calls, []);
  const unsupported = setup({ locks: {} });
  assert.equal(await unsupported.manager.connect(), false);
  assert.equal(unsupported.manager.state.phase, 'unsupported');
  assert.deepEqual(unsupported.calls, []);
  const denied = setup({ locks: { request() { throw new Error('Lock denied'); } } });
  assert.equal(await denied.manager.connect(), false);
  assert.equal(denied.manager.state.phase, 'fault');
  assert.equal(denied.manager.state.message, 'Lock denied');
  assert.deepEqual(denied.calls, []);
});
