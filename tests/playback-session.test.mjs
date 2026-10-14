import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackSession } from '../src/playback-session.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fresh = () => ({ roll: 1, pitch: .5, sampledAt: performance.now() });

function setup() {
  const runs = [], stops = [], errors = [];
  let pose = fresh;
  const controller = {
    start(getPose) { const run = deferred(); runs.push({ ...run, getPose }); session.updateStatus('arming', true); return run.promise; },
    stop(reason) { const stop = deferred(); stops.push({ ...stop, reason }); session.updateStatus('stopping', true); return stop.promise; },
  };
  const session = new PlaybackSession(controller, () => pose(), error => errors.push(error.message));
  session.updateStatus('ready', true);
  return {
    session, runs, stops, errors,
    setPose(value) { pose = value; },
    async start() { session.play(); session.tick(); await flush(); session.updateStatus('following', true); },
    async finishStop(confirmed = true) {
      session.updateStatus(confirmed ? 'stopped' : 'fault', confirmed, confirmed);
      stops.at(-1).resolve({ acknowledged: true, offConfirmed: confirmed });
      await flush();
    },
  };
}

test('connection and fresh frames alone never create Play intent', async () => {
  const { session, runs } = setup();
  for (let i = 0; i < 5; i++) session.tick();
  await flush();
  assert.equal(runs.length, 0);
  assert.equal(session.wantsMotion, false);
});

test('one run lock spans verification, arming and the whole playback session', async () => {
  const { session, runs } = setup();
  session.play();
  for (let i = 0; i < 5; i++) session.tick();
  await flush();
  assert.equal(runs.length, 1);
  for (const phase of ['arming', 'following', 'following']) {
    session.updateStatus(phase, true); session.tick(); await flush();
  }
  assert.equal(runs.length, 1);
});

test('Play waits for connection and a fresh pose without repeated start attempts', async () => {
  const { session, runs, setPose } = setup();
  session.updateStatus('disconnected', false);
  session.play(); session.tick(); await flush();
  assert.equal(runs.length, 0);
  session.updateStatus('ready', true); setPose(() => null);
  session.tick(); await flush(); assert.equal(runs.length, 0);
  setPose(fresh); session.tick(); await flush(); assert.equal(runs.length, 1);
});

test('buffering stops once and resumes only after both OFF and the old run settle', async () => {
  const h = setup(); await h.start(); h.setPose(() => null);
  h.session.suspend('buffering'); h.session.suspend('buffering'); h.session.tick(); await flush();
  assert.equal(h.stops.length, 1);
  assert.equal(h.session.wantsMotion, true);
  h.setPose(fresh); h.session.tick(); await flush(); assert.equal(h.runs.length, 1);
  await h.finishStop();
  h.session.tick(); await flush(); assert.equal(h.runs.length, 1, 'run lifetime remains locked after OFF');
  h.runs[0].resolve(); await flush(); h.session.tick(); await flush();
  assert.equal(h.runs.length, 2);
});

test('an old run settling first cannot rearm while STOP return is pending', async () => {
  const h = setup(); await h.start(); h.session.suspend(); await flush();
  h.runs[0].resolve(); await flush(); h.session.tick(); await flush();
  assert.equal(h.runs.length, 1);
  await h.finishStop(); h.session.tick(); await flush(); assert.equal(h.runs.length, 2);
});

test('Pause during a buffering stop revokes resumption without a second STOP', async () => {
  const h = setup(); await h.start(); h.session.suspend(); await flush();
  h.session.pause('explicit Stop'); h.session.pause('explicit Stop');
  await h.finishStop(); h.runs[0].resolve(); await flush(); h.session.tick(); await flush();
  assert.equal(h.stops.length, 1);
  assert.equal(h.runs.length, 1);
  assert.equal(h.session.wantsMotion, false);
});

test('fault or USB loss revokes intent even after firmware reconnects and the run resolves', async () => {
  for (const phase of ['fault', 'disconnected']) {
    const h = setup(); await h.start();
    h.session.updateStatus(phase, false);
    h.runs[0].resolve(); await flush();
    h.session.updateStatus('ready', true, true); h.session.tick(); await flush();
    assert.equal(h.session.wantsMotion, false, phase);
    assert.equal(h.runs.length, 1, phase);
  }
});

test('an explicit new Play after verified reconnection can recover from a previous fault', async () => {
  const h = setup(); await h.start(); h.session.updateStatus('fault', false);
  h.runs[0].resolve(); await flush(); h.session.updateStatus('ready', true);
  h.session.tick(); await flush(); assert.equal(h.runs.length, 1);
  h.session.play(); h.session.tick(); await flush(); assert.equal(h.runs.length, 2);
});

test('stale, missing and future clock samples cannot start hardware', async () => {
  for (const pose of [null, { ...fresh(), sampledAt: performance.now() - 200 }, { ...fresh(), sampledAt: performance.now() + 1000 }, { roll: 1, pitch: .5 }, { ...fresh(), roll: NaN }]) {
    const h = setup(); h.setPose(() => pose); h.session.play(); h.session.tick(); await flush();
    assert.equal(h.runs.length, 0);
  }
});

test('a frozen clock during playback suspends once, with intent preserved for fresh frames', async () => {
  const h = setup(); await h.start(); h.setPose(() => ({ ...fresh(), sampledAt: performance.now() - 200 }));
  h.session.tick(); h.session.tick(); await flush();
  assert.equal(h.stops.length, 1);
  assert.equal(h.session.wantsMotion, true);
});

test('transport-owned stale stop also requires an actual OFF before resumption', async () => {
  const h = setup(); await h.start();
  h.session.updateStatus('stopping', true); h.runs[0].resolve(); await flush();
  h.session.updateStatus('stopped', true, false); h.session.tick(); await flush();
  assert.equal(h.runs.length, 1);
  h.session.updateStatus('stopped', true, true); h.session.tick(); await flush();
  assert.equal(h.runs.length, 2);
});

test('missing OFF or a start rejection cannot create an automatic retry loop', async () => {
  const h = setup(); await h.start(); h.session.suspend(); await flush();
  await h.finishStop(false); h.runs[0].resolve(); await flush();
  h.session.updateStatus('ready', true); h.session.tick(); await flush();
  assert.equal(h.runs.length, 1); assert.equal(h.session.wantsMotion, false);
  const rejected = setup(); rejected.session.play(); rejected.session.tick(); await flush();
  rejected.runs[0].reject(new Error('ARM rejected')); await flush();
  rejected.session.updateStatus('ready', true); rejected.session.tick(); await flush();
  assert.equal(rejected.runs.length, 1); assert.equal(rejected.session.wantsMotion, false);
});

test('Pause or disposal before the scheduled start prevents ARM entirely', async () => {
  for (const action of ['pause', 'dispose']) {
    const h = setup(); h.session.play(); h.session.tick(); h.session[action](); await flush();
    h.session.updateStatus('ready', true); h.session.tick(); await flush();
    assert.equal(h.runs.length, 0); assert.equal(h.session.wantsMotion, false);
  }
});

test('Play-Pause-Play in one tick cancels the old start and permits a later fresh run', async () => {
  const h = setup(); h.session.play(); h.session.tick(); h.session.pause(); h.session.play();
  await flush(); assert.equal(h.runs.length, 0);
  h.session.tick(); await flush(); assert.equal(h.runs.length, 1);
});

test('repeated Pause after OFF while the old run settles does not send another STOP', async () => {
  const h = setup(); await h.start(); h.session.pause(); await flush(); await h.finishStop();
  h.session.pause(); await flush(); assert.equal(h.stops.length, 1);
});

test('a previous OFF flag on the next arming notification cannot bypass a new return', async () => {
  const h = setup(); h.session.play(); h.session.tick(); await flush();
  h.session.updateStatus('arming', true, true);
  h.session.suspend(); await flush();
  h.stops[0].resolve({ acknowledged: false, offConfirmed: false }); await flush();
  assert.equal(h.session.wantsMotion, false);
});

test('explicit Stop still reaches the controller when a failed session has unconfirmed OFF', async () => {
  const h = setup(); await h.start(); h.session.updateStatus('fault', false);
  h.runs[0].resolve(); await flush(); h.session.pause('Level + stop'); await flush();
  assert.equal(h.stops.length, 1);
});

test('disposal stops active playback and late callbacks cannot re-enable intent', async () => {
  const h = setup(); await h.start(); const disposing = h.session.dispose(); await flush();
  assert.equal(h.stops.length, 1);
  await h.finishStop(); h.runs[0].resolve(); await disposing; await flush();
  h.session.play(); h.session.updateStatus('ready', true); h.session.tick(); await flush();
  assert.equal(h.runs.length, 1); assert.equal(h.session.wantsMotion, false);
});
