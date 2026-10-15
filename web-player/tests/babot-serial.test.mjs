import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { PlaybackSession } from "../src/playback-session.mjs";
import { ConnectionManager } from "../src/connection-manager.mjs";
import { buildSingaporeBabotMotionSeries, createSingaporePlaybackMotionSampler } from "../src/motion.mjs";
import { commandedPoseDegrees, carPoseToFirmwarePose } from "../src/protocol.mjs";

const source = await readFile(new URL("../src/babot-serial.ts", import.meta.url), "utf8");
const helper = new URL("../src/protocol.mjs", import.meta.url).href;
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("./protocol.mjs", helper);
const { BabotSerial, BabotConnectionError, classifyBabotConnectionError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fresh = (roll = 1, pitch = 0) => ({ roll, pitch, sampledAt: performance.now() });
async function until(predicate, timeout = 1500) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error("Condition did not become true");
    await sleep(2);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup({ armDelay = 0, wrongArmAck = false, losePose = false, offDelay = 15, missingOff = false, openDelay = 0, identity = "BABOT_MOTION 1", poseNack = false, hostname = "localhost", protocol = "http:", isSecureContext = true, isTopLevel = true, granted = false, getPortsDelay = 0, portInfo = { usbVendorId: 0x2341, usbProductId: 0x8036 }, otherPortInfo = [], silencePing = () => false, pingDelay = 0, onStatus = () => {} } = {}) {
  const sent = [];
  const statuses = [];
  const calls = { chooser: 0, getPorts: 0, open: 0, otherOpen: 0, close: 0, maxPending: 0 };
  let incoming;
  let armed = false;
  let returning = false;
  let pending = 0;
  const timers = new Set();
  const later = (callback, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
  };
  const emit = (line) => {
    try { incoming.enqueue(new TextEncoder().encode(line + "\n")); } catch {}
  };
  const createReadable = () => new ReadableStream({ start(controller) { incoming = controller; } });
  const createWritable = () => new WritableStream({ write(bytes) {
    const wire = new TextDecoder().decode(bytes).trim();
    sent.push(wire);
    const [verb, sequence, roll, pitch] = wire.split(" ");
    pending++;
    calls.maxPending = Math.max(calls.maxPending, pending);
    let answer = `ACK ${sequence} ${verb}`;
    if (verb === "PING") {
      if (silencePing({ sequence: Number(sequence), open: calls.open })) { pending--; return; }
      answer += ` ${identity}`;
    }
    if (verb === "ARM") {
      if (armed || returning) answer = `NACK ${sequence} BUSY`;
      else { armed = true; if (wrongArmAck) answer = `ACK ${sequence} POSE`; }
    }
    if (verb === "POSE") {
      if (!armed) answer = `NACK ${sequence} NOT_ARMED`;
      else if (poseNack) answer = `NACK ${sequence} IK`;
      else if (Math.hypot(Number(roll), Number(pitch)) > 20) answer = `NACK ${sequence} LIMIT`;
      if (losePose) { pending--; return; }
    }
    if (verb === "STOP") {
      if (!armed) answer = `NACK ${sequence} NOT_ARMED`;
      else {
        armed = false;
        returning = true;
        if (!missingOff) later(() => { returning = false; emit("EVENT OFF"); }, offDelay + 2);
      }
    }
    later(() => { pending--; emit(answer); }, verb === "ARM" ? armDelay : verb === "PING" ? pingDelay : 0);
  } });
  const port = {
    readable: null, writable: null,
    getInfo() { return portInfo; },
    async open() { calls.open++; await sleep(openDelay); this.readable = createReadable(); this.writable = createWritable(); },
    async close() { calls.close++; for (const timer of timers) clearTimeout(timer); timers.clear(); this.readable = null; this.writable = null; },
  };
  const otherPorts = otherPortInfo.map((info) => ({
    getInfo() { return info; },
    async open() { calls.otherOpen++; throw new Error("An unrelated or ambiguous port was selected"); },
  }));
  const serial = {
    async getPorts() { calls.getPorts++; await sleep(getPortsDelay); return [...(granted ? [port] : []), ...otherPorts]; },
    async requestPort() { calls.chooser++; granted = true; return port; },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serial } });
  const win = { isSecureContext };
  win.top = isTopLevel ? win : {};
  win.self = win;
  globalThis.window = win;
  globalThis.location = { hostname, protocol };
  const controller = new BabotSerial((...status) => { statuses.push(status); onStatus(...status); });
  return {
    controller, sent, statuses, calls, port, serial,
    event: emit,
    fault(line) { armed = false; returning = true; emit(line); later(() => { returning = false; emit("EVENT OFF"); }, 20); },
    usbGone() { incoming.close(); },
  };
}

test("connection only identifies firmware; stopping idle does not send invalid STOP", async () => {
  const { controller, sent, calls } = setup();
  await controller.connect();
  assert.deepEqual(sent, ["PING 1"]);
  assert.deepEqual(await controller.stop(), { acknowledged: false, offConfirmed: false });
  await controller.disconnect();
  assert.deepEqual(sent, ["PING 1"]);
  assert.equal(calls.close, 1);
});

for (const usbVendorId of [0x2341, 0x2a03]) test(`remembered Leonardo ${usbVendorId.toString(16)} reconnects with PING only and no picker`, async () => {
  const { controller, sent, calls, statuses } = setup({
    granted: true,
    portInfo: { usbVendorId, usbProductId: 0x8036 },
    otherPortInfo: [{ usbVendorId: 0x2341, usbProductId: 0x0043 }, {}],
  });
  assert.equal(await controller.reconnect(), true);
  assert.deepEqual(sent, ["PING 1"]);
  assert.equal(calls.chooser, 0);
  assert.equal(calls.open, 1);
  assert.equal(calls.otherOpen, 0);
  assert.equal(statuses.at(-1)[1], true);
  assert.equal(statuses.at(-1)[2], false, "permission reuse does not start motion");
  assert.equal(await controller.connect(), true);
  assert.deepEqual(sent, ["PING 1", "PING 2"], "idle Connect verifies the existing session without reopening it");
  assert.equal(calls.open, 1);
  await controller.disconnect();
});

test("no remembered controller never prompts during reconnect; manual connection grants permission once", async () => {
  const { controller, sent, calls } = setup({ otherPortInfo: [{ usbVendorId: 0x2341, usbProductId: 0x0036 }] });
  assert.equal(await controller.reconnect(), false);
  assert.equal(calls.chooser, 0);
  assert.equal(calls.open, 0);
  assert.equal(calls.otherOpen, 0);
  assert.deepEqual(sent, []);
  assert.equal(await controller.connect(), true);
  assert.equal(calls.chooser, 1);
  assert.deepEqual(sent, ["PING 1"]);
  await controller.disconnect();
  assert.equal(await controller.connect(), true);
  assert.equal(calls.chooser, 1, "a later manual Connect reuses the existing browser grant");
  assert.equal(calls.open, 2);
  assert.deepEqual(sent, ["PING 1", "PING 1"]);
  await controller.disconnect();
});

test("multiple remembered Leonardos require manual choice and never select an arbitrary port", async () => {
  const { controller, sent, calls } = setup({ granted: true, otherPortInfo: [{ usbVendorId: 0x2a03, usbProductId: 0x8036 }] });
  assert.equal(await controller.reconnect(), false);
  assert.equal(calls.chooser, 0);
  assert.equal(calls.open, 0);
  assert.equal(calls.otherOpen, 0);
  assert.deepEqual(sent, []);
  assert.equal(await controller.connect(), true);
  assert.equal(calls.chooser, 1);
  assert.equal(calls.otherOpen, 0);
  assert.deepEqual(sent, ["PING 1"]);
  await controller.disconnect();
});

test("remembered permission still rejects incompatible firmware without prompting or arming", async () => {
  const { controller, sent, calls, statuses } = setup({ granted: true, identity: "BABOT_MOTION 2" });
  await assert.rejects(controller.reconnect(), /not identified/);
  assert.equal(calls.chooser, 0);
  assert.equal(calls.close, 1);
  assert.deepEqual(sent, ["PING 1"]);
  assert.equal(statuses.some((state) => state[1] || state[2]), false);
  await assert.rejects(controller.start(() => fresh()), /Connect and verify/);
});

for (const method of ["reconnect", "connect"]) test(`disconnect cancels ${method} during remembered-port lookup`, async () => {
  // Cover both a remembered port and the manual picker fallback.
  for (const granted of [true, false]) {
    const { controller, sent, calls, statuses } = setup({ granted, getPortsDelay: 40 });
    const opening = controller[method]();
    await until(() => calls.getPorts === 1);
    await controller.disconnect();
    assert.equal(await opening, false);
    assert.equal(calls.chooser, 0);
    assert.equal(calls.open, 0);
    assert.deepEqual(sent, []);
    assert.equal(statuses.some((state) => state[1] || state[2]), false);
    assert.equal(statuses.at(-1)[3].phase, "disconnected");
  }
});

test("insecure and embedded pages cannot choose, open or arm USB", async () => {
  for (const context of [
    { hostname: "visualizerf1.xanderwalker.com", protocol: "http:", isSecureContext: false },
    { hostname: "visualizerf1.xanderwalker.com", protocol: "https:", isTopLevel: false },
    { hostname: "localhost", isTopLevel: false },
  ]) {
    const { controller, calls, sent } = setup(context);
    await assert.rejects(controller.connect());
    await assert.rejects(controller.reconnect());
    await assert.rejects(controller.start(() => fresh()));
    assert.equal(calls.chooser, 0);
    assert.equal(calls.getPorts, 0);
    assert.equal(calls.open, 0);
    assert.deepEqual(sent, []);
  }
});

test("incompatible firmware never enables ARM", async () => {
  const { controller, sent, statuses } = setup({ identity: "BABOT_MOTION 2" });
  await assert.rejects(controller.connect(), /not identified/);
  assert.equal(sent.some((wire) => wire.startsWith("ARM")), false);
  assert.equal(statuses.some((state) => state[1]), false);
});

for (const origin of [
  { label: "localhost", hostname: "localhost", protocol: "http:" },
  { label: "hosted HTTPS", hostname: "visualizerf1.xanderwalker.com", protocol: "https:" },
]) test(`${origin.label} playback is identified, armed, bounded and stopped with one command outstanding`, async () => {
  const { controller, sent, calls, statuses } = setup(origin);
  await controller.connect();
  assert.deepEqual(sent, ["PING 1"], "connecting alone never arms or moves the platform");
  const run = controller.start(() => fresh(50, -50));
  await until(() => sent.filter((wire) => wire.startsWith("POSE")).length >= 4);
  const result = await controller.stop();
  await run;
  assert.deepEqual(result, { acknowledged: true, offConfirmed: true });
  assert.deepEqual(sent.slice(0, 3).map((wire) => wire.split(" ")[0]), ["PING", "PING", "ARM"]);
  assert.match(sent.at(-1), /^STOP /);
  assert.equal(statuses.at(-1)[3].offConfirmed, true);
  assert.equal(statuses.at(-1)[2], false);
  assert.equal(calls.chooser, 1);
  assert.equal(calls.open, 1);
  assert.equal(calls.maxPending, 1);
  for (let i = 1; i < sent.length; i++) assert.ok(Number(sent[i].split(" ")[1]) > Number(sent[i - 1].split(" ")[1]));
  for (const wire of sent.filter((wire) => wire.startsWith("POSE"))) {
    const [, , roll, pitch] = wire.split(" ");
    assert.ok(Math.hypot(Number(roll), Number(pitch)) <= 20);
  }
  await controller.disconnect();
  assert.equal(calls.close, 1);
});

test("STOP acknowledgement alone is not reported as a completed level return", async () => {
  const { controller, sent, statuses } = setup({ offDelay: 70 });
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  const stop = controller.stop();
  await until(() => statuses.some((state) => state[0].startsWith("STOP acknowledged")));
  assert.equal(statuses.at(-1)[3].offConfirmed, false);
  assert.deepEqual(await stop, { acknowledged: true, offConfirmed: true });
  await run;
  await controller.disconnect();
  assert.equal(sent.filter((wire) => wire.startsWith("STOP")).length, 1, "STOP ACK already disarmed the firmware");
});

test("missing OFF after STOP is explicitly unconfirmed and requires reconnection", async () => {
  const { controller, sent, statuses } = setup({ missingOff: true });
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  assert.deepEqual(await controller.stop(), { acknowledged: true, offConfirmed: false });
  assert.match(statuses.at(-1)[0], /OFF not confirmed/);
  await assert.rejects(controller.start(() => fresh()), /Connect and verify/);
  await run;
  await controller.disconnect();
  assert.equal(sent.filter((wire) => wire.startsWith("STOP")).length, 1, "Already acknowledged STOP must not be resent while OFF is missing");
});

test("stop during ARM waits for its response, then stops without a POSE", async () => {
  const { controller, sent, statuses } = setup({ armDelay: 60 });
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("ARM")));
  assert.deepEqual(await controller.stop(), { acknowledged: true, offConfirmed: true });
  await run;
  assert.equal(sent.some((wire) => wire.startsWith("POSE")), false);
  assert.equal(statuses.some((state) => state[2]), false);
  await controller.disconnect();
});

test("null source stops and never automatically resumes when poses reappear", async () => {
  const { controller, sent } = setup();
  await controller.connect();
  let present = true;
  const run = controller.start(() => present ? fresh() : null);
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  present = false;
  await run;
  const count = sent.length;
  present = true;
  await sleep(80);
  assert.equal(sent.length, count);
  assert.equal(sent.filter((wire) => wire.startsWith("ARM")).length, 1);
  assert.match(sent.at(-1), /^STOP /);
  await controller.disconnect();
});

test("stale, missing and non-finite samples cannot arm", async () => {
  const { controller, sent } = setup();
  await controller.connect();
  for (const pose of [null, { ...fresh(), sampledAt: performance.now() - 300 }, { ...fresh(), roll: NaN }, { roll: 1, pitch: 0 }]) {
    await assert.rejects(controller.start(() => pose), /fresh synchronized/);
  }
  assert.equal(sent.some((wire) => wire.startsWith("ARM")), false);
  await controller.disconnect();
});

test("a video clock that stops advancing disarms before the firmware watchdog window", async () => {
  const { controller, sent } = setup();
  await controller.connect();
  const pose = fresh();
  await controller.start(() => pose);
  assert.match(sent.at(-1), /^STOP /);
  assert.equal(sent.filter((wire) => wire.startsWith("ARM")).length, 1);
  await controller.disconnect();
});

test("wrong ARM response cannot authorize a pose", async () => {
  const { controller, sent, statuses } = setup({ wrongArmAck: true });
  await controller.connect();
  await controller.start(() => fresh());
  await controller.stop();
  assert.equal(sent.some((wire) => wire.startsWith("POSE")), false);
  assert.equal(statuses.some((state) => state[2]), false);
  await controller.disconnect();
});

test("missing POSE ACK cannot accumulate pending poses", async () => {
  const { controller, sent } = setup({ losePose: true });
  await controller.connect();
  await controller.start(() => fresh());
  await controller.stop();
  assert.equal(sent.filter((wire) => wire.startsWith("POSE")).length, 1);
  assert.match(sent.at(-1), /^STOP /);
  await controller.disconnect();
});

test("firmware NACK revokes motion and requires deliberate verification", async () => {
  const { controller, sent } = setup({ poseNack: true });
  await controller.connect();
  await controller.start(() => fresh());
  await controller.stop();
  assert.equal(sent.filter((wire) => wire.startsWith("POSE")).length, 1);
  await assert.rejects(controller.start(() => fresh()), /Connect and verify/);
  await controller.disconnect();
});

test("hardware button exit cancels following and waits for actual OFF", async () => {
  const { controller, sent, fault, statuses } = setup();
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  fault("EVENT BUTTON_EXIT");
  await run;
  const stopped = await controller.stop();
  assert.deepEqual(stopped, { acknowledged: false, offConfirmed: true });
  await until(() => statuses.at(-1)[3].offConfirmed);
  assert.equal(sent.filter((wire) => wire.startsWith("ARM")).length, 1);
  await assert.rejects(controller.start(() => fresh()), /Connect and verify/);
  await controller.disconnect();
});

test("an unexpected NACK also revokes an idle verified connection", async () => {
  const { controller, sent, event, statuses } = setup();
  await controller.connect();
  event("NACK 999 STALE_SEQUENCE");
  await until(() => !statuses.at(-1)[1]);
  await assert.rejects(controller.start(() => fresh()), /Connect and verify/);
  assert.equal(sent.some((wire) => wire.startsWith("ARM")), false);
  await controller.disconnect();
});

test("USB loss stops the pump and does not claim a confirmed level return", async () => {
  const { controller, sent, usbGone, statuses } = setup();
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  usbGone();
  await run;
  const result = await controller.stop();
  assert.equal(result.offConfirmed, false);
  assert.equal(statuses.at(-1)[1], false);
  assert.equal(statuses.at(-1)[2], false);
  await controller.disconnect();
});

test("disconnect during open cannot leave a verified port or arm", async () => {
  const { controller, sent, calls, statuses } = setup({ openDelay: 40 });
  const connection = controller.connect();
  await sleep(5);
  await controller.disconnect();
  assert.equal(await connection, false);
  assert.ok(calls.close > 0);
  assert.equal(sent.some((wire) => wire.startsWith("ARM")), false);
  assert.equal(statuses.some((state) => state[1]), false);
});

test("a new Stop cancels a Start waiting for the previous return to OFF", async () => {
  const { controller, sent } = setup({ offDelay: 70 });
  await controller.connect();
  const run = controller.start(() => fresh());
  await until(() => sent.some((wire) => wire.startsWith("POSE")));
  const firstStop = controller.stop();
  const pendingStart = controller.start(() => fresh());
  await sleep(10);
  const secondStop = controller.stop();
  await Promise.all([run, firstStop, pendingStart, secondStop]);
  assert.equal(sent.filter((wire) => wire.startsWith("ARM")).length, 1);
  await controller.disconnect();
});

test("a deliberate restart verifies firmware again after confirmed OFF", async () => {
  const { controller, sent } = setup();
  await controller.connect();
  for (let pass = 1; pass <= 2; pass++) {
    const run = controller.start(() => fresh());
    await until(() => sent.filter((wire) => wire.startsWith("ARM")).length === pass && sent.at(-1).startsWith("POSE"));
    assert.equal((await controller.stop()).offConfirmed, true);
    await run;
  }
  assert.equal(sent.filter((wire) => wire.startsWith("PING")).length, 3);
  assert.equal(sent.filter((wire) => wire.startsWith("ARM")).length, 2);
  await controller.disconnect();
});

test('Play can pair while the automatic permission lookup is still pending', async () => {
  const { controller, calls } = setup({ getPortsDelay: 30 });
  const restoring = controller.reconnect();
  const connecting = controller.connect();
  assert.equal(await restoring, false);
  assert.equal(await connecting, true);
  assert.equal(calls.chooser, 1);
  assert.equal(calls.open, 1);
  await controller.disconnect();
});

test('Disconnect cancels a queued Play pairing without opening the picker', async () => {
  const { controller, calls } = setup({ getPortsDelay: 30 });
  const restoring = controller.reconnect();
  const connecting = controller.connect();
  await controller.disconnect();
  assert.equal(await restoring, false);
  assert.equal(await connecting, false);
  assert.equal(calls.chooser, 0);
  assert.equal(calls.open, 0);
});

test('connection errors expose stable recovery categories', () => {
  for (const [name, message, stage, code, retryable] of [
    ['NotFoundError', 'No port selected by the user.', 'chooser', 'cancelled', false],
    ['AbortError', 'The chooser was closed', 'chooser', 'cancelled', false],
    ['SecurityError', 'Access is blocked', 'permission', 'permission-denied', false],
    ['NotAllowedError', 'Denied', 'chooser', 'permission-denied', false],
    ['InvalidStateError', 'Already open', 'open', 'port-busy', false],
    ['NetworkError', 'Failed to open serial port.', 'open', 'port-busy', false],
    ['NotFoundError', 'Device is gone', 'open', 'device-missing', true],
    ['Error', 'PING acknowledgement timed out', 'identity', 'timeout', true],
    ['NotSupportedError', 'Unavailable', 'context', 'unsupported', false],
    ['NetworkError', 'USB read failed', 'transport', 'transport-error', true],
  ]) {
    const failure = classifyBabotConnectionError(new DOMException(message, name), stage);
    assert.ok(failure instanceof BabotConnectionError);
    assert.equal(failure.code, code, `${stage}: ${name}`);
    assert.equal(failure.retryable, retryable);
  }
  const wrongFirmware = new BabotConnectionError('firmware-mismatch', 'wrong firmware', false);
  assert.equal(classifyBabotConnectionError(wrongFirmware), wrongFirmware);
});

for (const failureStage of ['chooser', 'permission', 'open', 'unsupported']) test(`${failureStage} failure revokes queued Play; later connection alone never arms`, async () => {
  let session;
  const { controller, serial, port, sent, statuses } = setup({ onStatus: (_message, connected, _active, detail) => {
    session?.updateStatus(detail.phase, connected, detail.offConfirmed);
  } });
  const original = { getPorts: serial.getPorts, requestPort: serial.requestPort, open: port.open };
  const codes = { chooser: 'cancelled', permission: 'permission-denied', open: 'port-busy', unsupported: 'unsupported' };
  if (failureStage === 'chooser') serial.requestPort = async () => { throw new DOMException('No port selected', 'NotFoundError'); };
  if (failureStage === 'permission') serial.getPorts = async () => { throw new DOMException('Permission denied', 'SecurityError'); };
  if (failureStage === 'open') port.open = async () => { throw new DOMException('Failed to open serial port.', 'NetworkError'); };
  if (failureStage === 'unsupported') delete navigator.serial;
  session = new PlaybackSession(controller, fresh);
  session.play();
  await assert.rejects(controller.connect(), error => error.code === codes[failureStage] && error.retryable === false);
  assert.equal(statuses.at(-1)[3].phase, 'fault');
  assert.equal(statuses.at(-1)[3].errorCode, codes[failureStage]);
  assert.equal(session.wantsMotion, false);
  Object.assign(serial, { getPorts: original.getPorts, requestPort: original.requestPort });
  port.open = original.open;
  navigator.serial = serial;
  await controller.connect();
  session.tick();
  await sleep(10);
  assert.equal(sent.some(wire => wire.startsWith('ARM ')), false);
  await session.dispose();
  await controller.disconnect();
});

test('delayed firmware boot is a retryable failure; a later reconnect identifies without arming', async () => {
  const { controller, calls, statuses, sent } = setup({ granted: true, silencePing: ({ open }) => open === 1 });
  await assert.rejects(controller.reconnect(), error => error.code === 'timeout' && error.retryable);
  assert.equal(statuses.at(-1)[3].phase, 'fault');
  assert.equal(calls.open, 1, 'transport does not repeatedly retry a cold start');
  assert.equal(calls.close, 1);
  assert.equal(await controller.reconnect(), true);
  assert.equal(calls.open, 2);
  assert.deepEqual(sent, ['PING 1', 'PING 1']);
  await controller.disconnect();
});

test('stale idle PING revokes pending Play and reopens once without arming', async () => {
  let session;
  const { controller, calls, statuses, sent } = setup({ granted: true,
    silencePing: ({ open, sequence }) => open === 1 && sequence === 2,
    onStatus: (_message, connected, _active, detail) => session?.updateStatus(detail.phase, connected, detail.offConfirmed),
  });
  session = new PlaybackSession(controller, fresh);
  await controller.reconnect();
  session.play();
  assert.equal(await controller.reconnect(), true);
  assert.equal(calls.open, 2);
  assert.equal(calls.close, 1);
  assert.equal(statuses.some(state => state[3].errorCode === 'timeout' && state[3].phase === 'fault'), true);
  assert.equal(session.wantsMotion, false);
  session.tick();
  assert.deepEqual(sent, ['PING 1', 'PING 2', 'PING 1']);
  await controller.disconnect();
});

test('idle revalidation and Play serialize PINGs with no extra outstanding command', async () => {
  const { controller, calls, sent } = setup({ pingDelay: 25 });
  await controller.connect();
  const revalidated = controller.reconnect();
  const run = controller.start(fresh);
  assert.equal(await revalidated, true);
  await until(() => sent.some(wire => wire.startsWith('POSE ')));
  assert.deepEqual(sent.slice(0, 4), ['PING 1', 'PING 2', 'PING 3', 'ARM 4']);
  assert.equal(calls.maxPending, 1);
  await controller.stop();
  await run;
  await controller.disconnect();
});

test('reconnect during ARM, following, or return to OFF never inserts a command', async () => {
  const { controller, sent, statuses } = setup({ armDelay: 30, offDelay: 40 });
  await controller.connect();
  const run = controller.start(fresh);
  await until(() => statuses.at(-1)[3].phase === 'arming');
  await controller.reconnect();
  await until(() => sent.some(wire => wire.startsWith('POSE ')));
  await controller.reconnect();
  const stopping = controller.stop();
  await until(() => statuses.at(-1)[0].startsWith('STOP acknowledged'));
  await controller.reconnect();
  await stopping;
  await run;
  assert.equal(sent.filter(wire => wire.startsWith('PING ')).length, 2);
  assert.equal(sent.filter(wire => wire.startsWith('ARM ')).length, 1);
  assert.equal(sent.filter(wire => wire.startsWith('STOP ')).length, 1);
  await controller.disconnect();
});

test('disconnect abandons a pending picker; its late result cannot replace a newer connection', async () => {
  const { controller, serial, port, calls, statuses } = setup();
  const selection = deferred();
  serial.requestPort = async () => ++calls.chooser === 1 ? selection.promise : port;
  const obsolete = controller.connect();
  await until(() => calls.chooser === 1);
  await controller.disconnect();
  assert.equal(statuses.at(-1)[3].phase, 'disconnected');
  assert.equal(await controller.connect(), true);
  selection.resolve({ async open() { throw new Error('Obsolete selection must never open'); } });
  assert.equal(await obsolete, false);
  assert.equal(calls.open, 1);
  assert.equal(statuses.at(-1)[3].phase, 'ready');
  await controller.disconnect();
});

test('obsolete permission rejection cannot publish a fault into a newer connection', async () => {
  const { controller, serial, port, calls, statuses } = setup();
  const lookup = deferred();
  serial.getPorts = async () => ++calls.getPorts === 1 ? lookup.promise : [port];
  const obsolete = controller.reconnect();
  await controller.disconnect();
  await controller.reconnect();
  lookup.reject(new DOMException('Permission revoked', 'SecurityError'));
  assert.equal(await obsolete, false);
  assert.equal(statuses.at(-1)[3].phase, 'ready');
  assert.equal(calls.open, 1);
  await controller.disconnect();
});

test('a delayed write rejection from a cancelled connection cannot reject a new command with the same sequence', async () => {
  const { controller, port, calls, sent, statuses } = setup({ granted: true, pingDelay: 25 });
  const oldWrite = deferred();
  const openPort = port.open.bind(port);
  port.open = async () => {
    await openPort();
    if (calls.open === 1) port.writable = new WritableStream({ write() { return oldWrite.promise; } });
  };
  const obsolete = controller.reconnect();
  await until(() => calls.open === 1 && port.writable?.locked);
  await controller.disconnect();
  assert.equal(await obsolete, false);
  const newConnection = controller.reconnect();
  await until(() => sent.includes('PING 1'));
  oldWrite.reject(new Error('Late USB write failure on the previous connection'));
  assert.equal(await newConnection, true);
  assert.equal(statuses.at(-1)[3].phase, 'ready');
  await controller.disconnect();
});

test('a cancelled revalidation never resumes a queued Start after a new connection', async () => {
  const { controller, sent } = setup({ granted: true, pingDelay: 25 });
  await controller.reconnect();
  const obsolete = controller.reconnect();
  const start = controller.start(fresh);
  await controller.disconnect();
  assert.equal(await obsolete, false);
  await start;
  assert.equal(await controller.reconnect(), true);
  assert.equal(sent.some(wire => wire.startsWith('ARM ')), false);
  await controller.disconnect();
});

test('disconnect waits for pending port ownership and confirmed close before resolving', async () => {
  const { controller, port, calls, statuses } = setup({ openDelay: 30 });
  const finishClose = deferred();
  const closePort = port.close.bind(port);
  port.close = async () => { await finishClose.promise; await closePort(); };
  const opening = controller.connect();
  await until(() => calls.open === 1);
  let disconnected = false;
  const closing = controller.disconnect().then(() => { disconnected = true; });
  await sleep(45);
  assert.equal(disconnected, false);
  assert.equal(calls.close, 0);
  finishClose.resolve();
  await closing;
  assert.equal(await opening, false);
  assert.equal(calls.close, 1);
  assert.equal(statuses.at(-1)[3].phase, 'disconnected');
});

test('port.close failure rejects disconnect and retains ownership for a later cleanup retry', async () => {
  const { controller, port, calls, statuses } = setup();
  await controller.connect();
  const closePort = port.close.bind(port);
  let failClose = true;
  port.close = async () => {
    if (failClose) throw new Error('Driver refused to close the USB port');
    await closePort();
  };
  await assert.rejects(controller.disconnect(), error => error.code === 'transport-error' && error.retryable);
  assert.equal(statuses.at(-1)[3].phase, 'fault');
  assert.equal(calls.close, 0);
  failClose = false;
  await controller.disconnect();
  assert.equal(calls.close, 1);
  assert.equal(statuses.at(-1)[3].phase, 'disconnected');
});

test('idle board reboot revokes verification and requires a fresh connection without auto-arm', async () => {
  const { controller, event, statuses, sent, calls } = setup({ granted: true });
  await controller.reconnect();
  event('READY BABOT_MOTION 1');
  await until(() => statuses.at(-1)[3].phase === 'fault');
  await assert.rejects(controller.start(fresh), /Connect and verify/);
  assert.equal(await controller.reconnect(), true);
  assert.equal(calls.open, 2);
  assert.equal(calls.close, 1);
  assert.deepEqual(sent, ['PING 1', 'PING 1']);
  await controller.disconnect();
});

test('manager runtime-fault recovery waits for actual OFF and close, then PINGs without replaying motion', async () => {
  let manager, session, held = false;
  const events = [];
  const { controller, fault, port, calls, sent } = setup({ granted: true,
    onStatus: (_message, connected, _active, detail) => {
      session?.updateStatus(detail.phase, connected, detail.offConfirmed);
      if (detail.offConfirmed) events.push('off');
      manager?.handleStatus(detail.phase, connected);
    },
  });
  const closePort = port.close.bind(port);
  port.close = async () => { events.push('close'); await closePort(); };
  const locks = { async request(_name, _options, callback) {
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: 'test-babot' }); }
    finally { held = false; }
  } };
  session = new PlaybackSession(controller, fresh);
  manager = new ConnectionManager(controller, { locks, isVisible: () => true,
    onInvalidatePlayback: reason => { void session.pause(reason); },
  });
  try {
    assert.equal(await manager.start(), true);
    session.play();session.tick();
    await until(() => sent.some(wire => wire.startsWith('POSE ')));
    const motionCommands = sent.filter(wire => /^(ARM|POSE) /.test(wire)).length;
    fault('EVENT BUTTON_EXIT');
    await until(() => session.wantsMotion === false);
    assert.equal(calls.close, 0, 'port stays owned while firmware returns to level');
    await until(() => calls.open === 2 && manager.state.phase === 'ready');
    assert.equal(calls.close, 1);
    assert.ok(events.indexOf('off') >= 0 && events.indexOf('off') < events.indexOf('close'));
    session.tick();
    assert.equal(sent.filter(wire => /^(ARM|POSE) /.test(wire)).length, motionCommands);
    assert.equal(sent.filter(wire => wire.startsWith('ARM ')).length, 1);
    assert.equal(sent.filter(wire => wire.startsWith('PING ')).length, 3);
    assert.equal(sent.at(-1), 'PING 1');
    assert.equal(manager.state.owner, true);
  } finally {
    await session.dispose();
    await manager.dispose();
  }
  assert.equal(held, false);
});

test('one Play drives the complete recorded lap through the real serial controller without intermediate STOP or ARM', async () => {
  const fixture = JSON.parse(await readFile(new URL('../data/openf1-singapore-2026-verstappen-pole.json', import.meta.url), 'utf8'));
  const durationSeconds = fixture.meta.lapDurationSeconds;
  const sampleAt = createSingaporePlaybackMotionSampler(buildSingaporeBabotMotionSeries(fixture), { durationSeconds });
  // Advance 50 recorded frames per wire tick: full-lap transport coverage in
  // about two seconds, while wall-clock freshness and real ACK timing remain.
  const times = [...Array.from({ length: Math.floor(durationSeconds) + 1 }, (_, index) => index), durationSeconds];
  const errors = [];
  let session;
  const { controller, sent, calls } = setup({ granted: true, onStatus: (_message, connected, _active, detail) => {
    session?.updateStatus(detail.phase, connected, detail.offConfirmed);
  } });
  const posesSent = () => sent.filter((wire) => wire.startsWith('POSE '));
  const wirePoseAt = time => carPoseToFirmwarePose(commandedPoseDegrees(sampleAt(time), { roll: 10, pitch: 10 }));
  session = new PlaybackSession(controller, () => {
    const time = times[Math.min(posesSent().length, times.length - 1)];
    const sample = sampleAt(time);
    return sample.valid ? { ...wirePoseAt(time), sampledAt: performance.now() } : null;
  }, error => errors.push(error.message));
  const pump = setInterval(() => session.tick(), 5);
  try {
    await controller.reconnect();
    assert.deepEqual(sent, ['PING 1']);
    assert.equal(calls.chooser, 0);
    session.play();
    await until(() => posesSent().length >= times.length, 5000);
    assert.equal(sent.filter(wire => wire.startsWith('ARM ')).length, 1);
    assert.equal(sent.some(wire => wire.startsWith('STOP ')), false);
    for (const time of [0, 27, 51, 63, durationSeconds]) {
      const [, , roll, pitch] = posesSent()[times.indexOf(time)].split(' ');
      const expected = wirePoseAt(time);
      assert.ok(Math.abs(Number(roll) - expected.roll) <= 0.00051, `roll at ${time}s`);
      assert.ok(Math.abs(Number(pitch) - expected.pitch) <= 0.00051, `pitch at ${time}s`);
    }
    assert.equal(session.wantsMotion, true);
    const stopped = await session.pause('Lap complete');
    assert.equal(stopped.offConfirmed, true);
    await until(() => session.runPromise === null);
    session.tick();
    assert.equal(sent.filter(wire => wire.startsWith('ARM ')).length, 1);
    assert.equal(sent.filter(wire => wire.startsWith('STOP ')).length, 1);
    assert.equal(calls.maxPending, 1);
    assert.deepEqual(errors, []);
    assert.equal(session.wantsMotion, false);
  } finally {
    clearInterval(pump);
    await session.dispose();
    await controller.disconnect();
  }
});
