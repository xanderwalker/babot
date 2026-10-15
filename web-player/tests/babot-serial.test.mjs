import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { PlaybackSession } from "../src/playback-session.mjs";
import { buildSingaporeBabotMotionSeries, createSingaporePlaybackMotionSampler } from "../src/motion.mjs";
import { commandedPoseDegrees, carPoseToFirmwarePose } from "../src/protocol.mjs";

const source = await readFile(new URL("../src/babot-serial.ts", import.meta.url), "utf8");
const helper = new URL("../src/protocol.mjs", import.meta.url).href;
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("./protocol.mjs", helper);
const { BabotSerial } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fresh = (roll = 1, pitch = 0) => ({ roll, pitch, sampledAt: performance.now() });
async function until(predicate, timeout = 1500) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error("Condition did not become true");
    await sleep(2);
  }
}

function setup({ armDelay = 0, wrongArmAck = false, losePose = false, offDelay = 15, missingOff = false, openDelay = 0, identity = "BABOT_MOTION 1", poseNack = false, hostname = "localhost", protocol = "http:", isSecureContext = true, isTopLevel = true, granted = false, getPortsDelay = 0, portInfo = { usbVendorId: 0x2341, usbProductId: 0x8036 }, otherPortInfo = [], onStatus = () => {} } = {}) {
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
    if (verb === "PING") answer += ` ${identity}`;
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
    later(() => { pending--; emit(answer); }, verb === "ARM" ? armDelay : 0);
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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serial: {
    async getPorts() { calls.getPorts++; await sleep(getPortsDelay); return [...(granted ? [port] : []), ...otherPorts]; },
    async requestPort() { calls.chooser++; granted = true; return port; },
  } } });
  const win = { isSecureContext };
  win.top = isTopLevel ? win : {};
  win.self = win;
  globalThis.window = win;
  globalThis.location = { hostname, protocol };
  const controller = new BabotSerial((...status) => { statuses.push(status); onStatus(...status); });
  return {
    controller, sent, statuses, calls,
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
  assert.deepEqual(sent, ["PING 1"], "repeated Connect while verified does not restart the session");
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
