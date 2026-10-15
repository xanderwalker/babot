import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  BOOTLOADER_FILTERS, RUNTIME_FILTERS, LEONARDO_APPLICATION_BYTES,
  createFirmwareInstaller, parseIntelHex, validateFirmwareManifest,
} from '../src/firmware-installer.mjs';

const origin = 'https://babot.example/setup';
const manifestUrl = 'https://babot.example/firmware/manifest.json';
const ascii = (text) => new TextEncoder().encode(text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function record(address, type, bytes = []) {
  const values = [bytes.length, address >> 8, address & 255, type, ...bytes];
  values.push((-values.reduce((sum, value) => sum + value, 0)) & 255);
  return ':' + values.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}
const eof = record(0, 1);
const firmware = [record(0, 0, [0x0c, 0x94, 0x40, 0x00, 0x23, 0x45]), record(256, 0, [1, 2, 3, 4]), eof, ''].join('\n');
function manifestFor(source = firmware, extra = {}) {
  const parsed = parseIntelHex(source);
  return { schemaVersion: 1, id: 'babot-motion-leonardo', version: '1.0.0', board: 'arduino:avr:leonardo', protocol: 1,
    hex: 'babot-motion-1.0.0.hex', sourceZip: 'babot-motion-1.0.0-source.zip',
    sha256: createHash('sha256').update(source).digest('hex'), sizeBytes: Buffer.byteLength(source),
    maximumApplicationSize: 28672, firmwareByteLength: parsed.byteLength, applicationStart: 0, applicationEndExclusive: parsed.endAddress, ...extra };
}
const quickTimeouts = { picker: 250, open: 150, command: 100, runtime: 40, download: 100, cleanup: 200, operation: 5000 };

/** Independent, memory-oriented model of the audited Caterina command semantics. */
class MockPort {
  constructor(options = {}) {
    this.options = options;
    this.runtime = Boolean(options.runtime);
    this.info = options.info ?? { usbVendorId: 0x2341, usbProductId: this.runtime ? 0x8036 : 0x0036 };
    this.flash = new Uint8Array(32768).fill(0x55);
    this.eeprom = Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + Math.floor(i / 128)) & 255);
    this.initialEeprom = this.eeprom.slice();
    this.commands = []; this.flashWrites = []; this.signals = []; this.opens = []; this.closes = 0;
    this.readable = null; this.writable = null; this.address = 0; this.exited = false;
  }
  getInfo() { return this.info; }
  async open(options) {
    this.opens.push(options.baudRate);
    if (this.options.pendingOpen) await this.options.pendingOpen.promise;
    if (this.options.openError) throw this.options.openError;
    this.readable = new ReadableStream({ start: (controller) => { this.incoming = controller; } });
    this.writable = new WritableStream({ write: (bytes) => this.write(bytes) });
  }
  async close() {
    this.closes++;
    assert.equal(this.readable?.locked, false, 'read lock released before port.close');
    assert.equal(this.writable?.locked, false, 'write lock released before port.close');
    if (this.options.closeError) throw this.options.closeError;
    this.readable = null; this.writable = null;
  }
  async setSignals(signals) { this.signals.push(signals); }
  emit(bytes) {
    const value = typeof bytes === 'string' ? ascii(bytes) : Uint8Array.from(bytes);
    if (this.options.fragmented && value.length > 1) {
      this.incoming.enqueue(value.slice(0, 1));
      this.incoming.enqueue(value.slice(1, Math.min(5, value.length)));
      if (value.length > 5) this.incoming.enqueue(value.slice(5));
    } else this.incoming.enqueue(value);
  }
  async write(bytes) {
    const request = Array.from(bytes);
    this.commands.push(request);
    if (this.options.onCommand) await this.options.onCommand(request, this);
    if (this.options.unplugOn === String.fromCharCode(request[0])) { this.incoming.close(); return; }
    if (this.options.silentOn === String.fromCharCode(request[0])) return;
    if (this.runtime) {
      const text = new TextDecoder().decode(bytes);
      if (text === 'PING 1\n') {
        if (this.options.stock) return;
        if (this.options.readyBanner) this.emit('READY BABOT_MOTION 1\r\n');
        this.emit(`ACK 1 PING ${this.options.identity ?? 'BABOT_MOTION 1'}\n`);
      } else if (text === 'INFO 2\n') {
        if (this.options.missingInfo) return;
        this.emit(this.options.infoReply ?? `ACK 2 INFO BABOT_MOTION 1 VERSION ${this.options.version ?? '1.0.0'} BOARD ATMEGA32U4 OFFSETS 75 76 77\n`);
      } else assert.fail(`Unexpected runtime command: ${text}`);
      return;
    }
    const command = String.fromCharCode(request[0]);
    switch (command) {
      case 'S': this.emit(this.options.identifier ?? 'CATERIN'); break;
      case 's': this.emit(this.options.signature ?? [0x87, 0x95, 0x1e]); break;
      case 'b': this.emit(this.options.block ?? [89, 0, 128]); break;
      case 'P': this.emit([13]); break;
      case 'A': this.address = request[1] * 256 + request[2]; this.emit([13]); break;
      case 'B': {
        const length = request[1] * 256 + request[2];
        assert.equal(request[3], 70, 'EEPROM writes are forbidden');
        assert.equal(length, 128); assert.equal(request.length, 132);
        const byteAddress = this.address * 2;
        assert.ok(byteAddress < 28672 && byteAddress % 128 === 0, 'writes stay in application pages');
        const data = Uint8Array.from(request.slice(4));
        this.flash.fill(0xff, byteAddress, byteAddress + length);
        this.flash.set(data, byteAddress);
        this.flashWrites.push({ address: byteAddress, data });
        if (this.options.corruptEepromAfterWrite === this.flashWrites.length) this.eeprom[777] ^= 1;
        this.address += length / 2;
        this.emit([13]); break;
      }
      case 'g': {
        const length = request[1] * 256 + request[2];
        let data;
        if (request[3] === 70) {
          const byteAddress = this.address * 2;
          data = this.flash.slice(byteAddress, byteAddress + length);
          if (this.options.badReadback === byteAddress && this.flashWrites.some((write) => write.address === byteAddress && write.data[0] !== 0xff)) data[0] ^= 1;
          this.address += length / 2;
        } else {
          assert.equal(request[3], 69);
          data = this.eeprom.slice(this.address, this.address + length);
          this.address += length;
        }
        this.emit(data); break;
      }
      case 'E': this.exited = true; this.emit([13]); break;
      default: assert.fail(`Forbidden or unknown AVR109 command: ${command}`);
    }
  }
}

function setup({ port = new MockPort(), manifest = manifestFor(), source = firmware, fetch, choose, onStage, timeouts = {}, ...options } = {}) {
  const events = [], selections = [], downloads = [];
  const serial = { requestPort: (request) => { selections.push(request); return choose ? choose(request) : Promise.resolve(port); } };
  const installer = createFirmwareInstaller({ serial, baseUrl: origin, crypto: webcrypto,
    fetch: fetch ?? (async (url, request) => { downloads.push({ url, request }); return new Response(url === manifestUrl ? JSON.stringify(manifest) : source); }),
    onStage: (state) => { events.push(state); onStage?.(state); }, timeouts: { ...quickTimeouts, ...timeouts }, ...options });
  return { installer, port, events, selections, downloads, prepare: () => installer.prepare(manifestUrl) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (cause) => cause.code === code, `expected ${code}`);

test('HEX parser fills sparse application gaps and checks all addresses, checksums and EOF', () => {
  const parsed = parseIntelHex(firmware);
  assert.equal(parsed.data.length, 28672); assert.equal(parsed.byteLength, 10); assert.equal(parsed.endAddress, 260);
  assert.deepEqual(Array.from(parsed.data.slice(0, 6)), [12, 148, 64, 0, 35, 69]);
  assert.equal(parsed.data[6], 255); assert.equal(parsed.data.at(-1), 255);
  for (const invalid of [
    firmware.replace('0C94', '0D94'), firmware.replace(eof, ''), `${firmware}${record(0, 0, [1])}`,
    [record(0, 0, [12, 148]), record(1, 0, [1]), eof].join('\n'),
    [record(0, 0, [12, 148]), record(28672, 0, [1]), eof].join('\n'),
    [record(0, 0, [12, 148]), record(0, 4, [0, 1]), record(0, 0, [1]), eof].join('\n'),
    [record(0, 0, [12, 148]), record(0, 2, [7, 0]), record(0, 0, [1]), eof].join('\n'),
    [record(0, 0, [12, 148]), record(0, 5, [0, 0, 0, 0]), eof].join('\n'),
    [record(0, 0, [255, 255]), eof].join('\n'), [record(2, 0, [1, 2]), eof].join('\n'), eof,
  ]) assert.throws(() => parseIntelHex(invalid), (cause) => cause.code === 'invalid-hex');
  assert.doesNotThrow(() => parseIntelHex([record(0, 4, [0, 0]), record(0, 0, [12, 148]), record(28671, 0, [42]), eof].join('\n')));
});

test('manifest confines files, board, protocol and memory size to trusted release contract', () => {
  assert.equal(validateFirmwareManifest(manifestFor(), manifestUrl).hexUrl, 'https://babot.example/firmware/babot-motion-1.0.0.hex');
  for (const patch of [{ board: 'arduino:avr:uno' }, { protocol: 2 }, { maximumApplicationSize: 32768 },
    { hex: '../evil.hex' }, { hex: 'https://evil.example/a.hex' }, { sourceZip: 'foo%2fbar.zip' }, { sha256: 'bad' }, { sizeBytes: 999999 }]) {
    assert.throws(() => validateFirmwareManifest(manifestFor(firmware, patch), manifestUrl), (cause) => cause.code === 'invalid-manifest');
  }
});

test('prepare validates download size, SHA-256 and manifest address metadata before any USB picker', async () => {
  const good = setup();
  const result = await good.prepare();
  assert.equal(result.version, '1.0.0'); assert.equal(good.installer.prepared, result); assert.equal(good.selections.length, 0);
  assert.ok(good.downloads.every(({ request }) => request.redirect === 'error' && request.cache === 'no-store'));
  const cases = [
    { source: firmware.replace('0C94', '0D94') },
    { manifest: manifestFor(firmware, { sizeBytes: Buffer.byteLength(firmware) + 1 }) },
    { manifest: manifestFor(firmware, { applicationEndExclusive: 261 }) },
  ];
  for (const options of cases) {
    const bad = setup(options); await rejectsCode(bad.prepare(), 'integrity');
    assert.equal(bad.installer.prepared, null); assert.equal(bad.selections.length, 0);
  }
  const badHex = firmware.replace('0C94', '0D94');
  const digest = createHash('sha256').update(badHex).digest('hex');
  await rejectsCode(setup({ source: badHex, manifest: manifestFor(firmware, { sha256: digest }) }).prepare(), 'invalid-hex');
});

test('prepare rejects remote origins, redirects and oversized streams', async () => {
  const foreign = setup();
  await rejectsCode(foreign.installer.prepare('https://evil.example/manifest.json'), 'invalid-manifest');
  assert.equal(foreign.downloads.length, 0);
  await rejectsCode(setup({ fetch: async () => ({ ok: true, url: 'https://evil.example/manifest.json' }) }).prepare(), 'download');
  await rejectsCode(setup({ fetch: async () => new Response('x'.repeat(17000)) }).prepare(), 'download');
});

test('1200-baud reset uses only runtime picker and explicit DTR drop, then closes fully', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true }) });
  await fixture.prepare();
  const reset = fixture.installer.resetRuntime();
  assert.equal(fixture.selections.length, 1, 'picker opens in the click stack');
  assert.deepEqual(fixture.selections[0].filters, RUNTIME_FILTERS);
  assert.deepEqual(await reset, { reset: true });
  assert.deepEqual(fixture.port.opens, [1200]);
  assert.deepEqual(fixture.port.signals, [{ dataTerminalReady: true }, { dataTerminalReady: false }]);
  assert.equal(fixture.port.commands.length, 0); assert.equal(fixture.port.closes, 1);
  assert.equal(fixture.installer.busy, false);
});

test('Caterina flash supports fragmented reads, verifies all application bytes and preserves all EEPROM', async () => {
  const fixture = setup({ port: new MockPort({ fragmented: true }) });
  const beforeBootloader = fixture.port.flash.slice(28672);
  await fixture.prepare();
  const flashing = fixture.installer.flashBootloader();
  assert.equal(fixture.selections.length, 1, 'bootloader picker opens before an await');
  assert.deepEqual(fixture.selections[0].filters, BOOTLOADER_FILTERS);
  const result = await flashing;
  assert.deepEqual(result, { verified: true, version: '1.0.0', signature: '1e9587', eepromPreserved: true, bytesWritten: 28672 });
  assert.deepEqual(fixture.port.flash.slice(0, 28672), parseIntelHex(firmware).data);
  assert.deepEqual(fixture.port.flash.slice(28672), beforeBootloader);
  assert.deepEqual(fixture.port.eeprom, fixture.port.initialEeprom);
  assert.equal(fixture.port.flashWrites.length, 225, '224 application pages plus initial blank reset page');
  assert.equal(fixture.port.flashWrites[0].address, 0); assert.ok(fixture.port.flashWrites[0].data.every((value) => value === 255));
  assert.equal(fixture.port.flashWrites.at(-1).address, 0);
  assert.equal(fixture.port.exited, true); assert.equal(fixture.port.closes, 1);
  assert.equal(fixture.installer.busy, false);
  assert.ok(fixture.port.commands.every((request) => !['e', 'D', 'l', 'F', 'N', 'Q', 'c', 'C', 'm'].includes(String.fromCharCode(request[0]))));
  assert.equal(fixture.events.at(-1).stage, 'awaiting-verification');
});

test('wrong bootloader signature, identifier, or page size cannot write flash or EEPROM', async () => {
  for (const options of [{ signature: [0x0f, 0x95, 0x1e] }, { identifier: 'AVRBOOT' }, { block: [89, 1, 0] }]) {
    const fixture = setup({ port: new MockPort(options) }); await fixture.prepare();
    await assert.rejects(fixture.installer.flashBootloader(), (cause) => ['wrong-device', 'bootloader-mismatch'].includes(cause.code));
    assert.equal(fixture.port.flashWrites.length, 0); assert.equal(fixture.port.exited, false); assert.equal(fixture.port.closes, 1);
    assert.deepEqual(fixture.port.eeprom, fixture.port.initialEeprom);
  }
});

test('runtime PID selected for bootloader or bootloader for runtime is rejected before opening', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true }) }); await fixture.prepare();
  await rejectsCode(fixture.installer.flashBootloader(), 'wrong-device'); assert.equal(fixture.port.opens.length, 0);
  const boot = setup(); await rejectsCode(boot.installer.verifyRuntime(), 'wrong-device'); assert.equal(boot.port.opens.length, 0);
});

test('failed page readback leaves reset blank, never exits bootloader, and releases USB', async () => {
  const fixture = setup({ port: new MockPort({ badReadback: 256 }) }); await fixture.prepare();
  await rejectsCode(fixture.installer.flashBootloader(), 'readback-mismatch');
  assert.equal(fixture.port.flash[0], 255); assert.equal(fixture.port.flash[1], 255);
  assert.equal(fixture.port.exited, false); assert.equal(fixture.port.closes, 1);
});

test('EEPROM drift aborts before reset commit, without trying to repair EEPROM', async () => {
  const fixture = setup({ port: new MockPort({ corruptEepromAfterWrite: 2 }) }); await fixture.prepare();
  await rejectsCode(fixture.installer.flashBootloader(), 'eeprom-changed');
  assert.equal(fixture.port.flash[0], 255); assert.equal(fixture.port.flash[1], 255);
  assert.equal(fixture.port.exited, false);
  assert.equal(fixture.port.commands.filter((request) => request[0] === 66 && request[3] === 69).length, 0);
});

test('final reset-page readback failure restores blank reset and never exits', async () => {
  const fixture = setup({ port: new MockPort({ badReadback: 0 }) }); await fixture.prepare();
  await rejectsCode(fixture.installer.flashBootloader(), 'readback-mismatch');
  assert.equal(fixture.port.flash[0], 255); assert.equal(fixture.port.flash[1], 255);
  assert.equal(fixture.port.exited, false); assert.equal(fixture.port.closes, 1);
});

test('unplug and a silent bootloader have bounded failures and clean USB locks', async () => {
  for (const options of [{ unplugOn: 'g' }, { silentOn: 's' }]) {
    const fixture = setup({ port: new MockPort(options), timeouts: { command: 20 } }); await fixture.prepare();
    await assert.rejects(fixture.installer.flashBootloader(), (cause) => ['disconnected', 'timeout'].includes(cause.code));
    assert.equal(fixture.port.exited, false); assert.equal(fixture.port.closes, 1); assert.equal(fixture.installer.busy, false);
  }
});

test('a stalled native write is bounded and its writer lock is released during cleanup', async () => {
  const stalled = deferred();
  const fixture = setup({
    port: new MockPort({ onCommand: (request) => request[0] === 115 ? stalled.promise : undefined }),
    timeouts: { command: 20, cleanup: 80 },
  });
  await fixture.prepare();
  await rejectsCode(fixture.installer.flashBootloader(), 'timeout');
  assert.equal(fixture.port.closes, 1); assert.equal(fixture.port.flashWrites.length, 0);
  assert.equal(fixture.installer.busy, false);
  // Resolve the mocked driver only after cleanup; the engine cannot use its
  // late completion to send any further command or mark the flash successful.
  stalled.resolve(); await sleep(1);
  assert.equal(fixture.port.exited, false); assert.equal(fixture.events.at(-1).stage, 'error');
});

test('cancellation stops before the next write, leaves bootloader recoverable, and can retry', async () => {
  let installer, cancellation;
  const fixture = setup({ onStage: ({ stage, progress }) => {
    if (stage === 'programming' && progress > 0.01 && !cancellation) cancellation = installer.cancel();
  } }); installer = fixture.installer; await fixture.prepare();
  await rejectsCode(installer.flashBootloader(), 'cancelled'); await cancellation;
  assert.equal(fixture.port.exited, false); assert.equal(fixture.port.flash[0], 255); assert.equal(fixture.port.closes, 1);
  assert.ok(fixture.port.flashWrites.length < 10);
  assert.equal(installer.busy, false);
  await fixture.prepare();
  await installer.flashBootloader();
  assert.equal(fixture.port.exited, true); assert.equal(fixture.port.closes, 2);
});

test('cancelled chooser resolving later cannot open a device and same instance remains usable', async () => {
  const picker = deferred(); const fixture = setup({ choose: () => picker.promise }); await fixture.prepare();
  const operation = fixture.installer.flashBootloader();
  const cancelled = fixture.installer.cancel();
  await rejectsCode(operation, 'cancelled'); await cancelled;
  picker.resolve(fixture.port); await sleep(1);
  assert.equal(fixture.port.opens.length, 0); assert.equal(fixture.installer.busy, false);
  await fixture.prepare();
});

test('late open on cancel stays quarantined until actual USB closure completes', async () => {
  const pendingOpen = deferred();
  const fixture = setup({ port: new MockPort({ pendingOpen }), timeouts: { cleanup: 30 } }); await fixture.prepare();
  const operation = fixture.installer.flashBootloader();
  await sleep(1);
  const cancelled = fixture.installer.cancel();
  await rejectsCode(operation, 'cleanup-failed'); await rejectsCode(cancelled, 'cleanup-failed');
  assert.equal(fixture.installer.busy, true);
  await rejectsCode(fixture.installer.flashBootloader(), 'cleanup-failed');
  pendingOpen.resolve(); await sleep(5);
  assert.equal(fixture.port.closes, 1); assert.equal(fixture.installer.busy, false);
  assert.equal(fixture.port.flashWrites.length, 0);
});

test('failed close prevents a false success and blocks further use', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true, closeError: new Error('port stuck') }) });
  await rejectsCode(fixture.installer.verifyRuntime(), 'cleanup-failed');
  assert.equal(fixture.installer.busy, true); assert.equal(fixture.events.at(-1).stage, 'error');
  await rejectsCode(fixture.installer.cancel(), 'cleanup-failed');
});

test('runtime verification reads PING/INFO only and returns exact release and offsets after close', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true, fragmented: true, readyBanner: true }) }); await fixture.prepare();
  const result = await fixture.installer.verifyRuntime({ requirePreparedVersion: true });
  assert.deepEqual(result, { compatible: true, protocol: 1, version: '1.0.0', board: 'ATMEGA32U4', offsets: [75, 76, 77], current: true });
  assert.deepEqual(fixture.port.commands.map((bytes) => new TextDecoder().decode(Uint8Array.from(bytes))), ['PING 1\n', 'INFO 2\n']);
  assert.equal(fixture.port.closes, 1); assert.equal(fixture.events.at(-1).stage, 'complete');
});

test('stock firmware absence is a bounded install-needed result with no retry or motion', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true, stock: true }) });
  const result = await fixture.installer.verifyRuntime();
  assert.equal(result.compatible, false); assert.equal(result.reason, 'firmware-missing');
  assert.equal(fixture.port.commands.length, 1); assert.equal(fixture.port.closes, 1);
  assert.equal(fixture.events.at(-1).stage, 'firmware-missing');
});

test('old protocol-compatible firmware may be detected but is not accepted as verified new release', async () => {
  const fixture = setup({ port: new MockPort({ runtime: true, missingInfo: true }) }); await fixture.prepare();
  const old = await fixture.installer.verifyRuntime();
  assert.equal(old.compatible, true); assert.equal(old.version, null); assert.equal(old.current, false);
  await rejectsCode(fixture.installer.verifyRuntime({ requirePreparedVersion: true }), 'version-mismatch');
  assert.equal(fixture.port.closes, 2);
  const wrong = setup({ port: new MockPort({ runtime: true, version: '0.9.0' }) }); await wrong.prepare();
  await rejectsCode(wrong.installer.verifyRuntime({ requirePreparedVersion: true }), 'version-mismatch');
  const legacy = setup({ port: new MockPort({ runtime: true, infoReply: 'NACK 0 BAD_COMMAND\n' }) }); await legacy.prepare();
  assert.equal((await legacy.installer.verifyRuntime()).compatible, true);
  await rejectsCode(legacy.installer.verifyRuntime({ requirePreparedVersion: true }), 'version-mismatch');
});

test('install refuses unprepared bytes and concurrent operations', async () => {
  const fixture = setup();
  await rejectsCode(fixture.installer.flashBootloader(), 'not-prepared'); assert.equal(fixture.selections.length, 0);
  const picker = deferred(); const pending = setup({ choose: () => picker.promise }); await pending.prepare();
  const operation = pending.installer.resetRuntime();
  await rejectsCode(pending.installer.flashBootloader(), 'busy');
  const cancellation = pending.installer.cancel(); await rejectsCode(operation, 'cancelled'); await cancellation;
});

test('published real firmware manifest and HEX pass the installer parser and digest check', async () => {
  const releaseDirectory = new URL('../public/firmware/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', releaseDirectory), 'utf8'));
  const source = await readFile(new URL(manifest.hex, releaseDirectory), 'utf8');
  const fixture = setup({ manifest, source });
  const prepared = await fixture.prepare();
  assert.equal(prepared.version, manifest.version);
  assert.ok(parseIntelHex(source).endAddress <= LEONARDO_APPLICATION_BYTES);
});
