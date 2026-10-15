/**
 * Leonardo-only installer. The UI must hold the player's exclusive USB lease and
 * require disconnected motor power before invoking either installation action.
 * Each picker method must be called directly from a separate user gesture.
 *
 * Protocol audited against Arduino's Caterina implementation (not a third-party
 * uploader):
 * https://github.com/arduino/ArduinoCore-avr/blob/1.8.6/bootloaders/caterina/Caterina.c
 * https://github.com/arduino/ArduinoCore-avr/blob/1.8.6/cores/arduino/CDC.cpp
 * https://github.com/arduino/ArduinoCore-avr/blob/1.8.6/boards.txt
 *
 * Only A, B/F and g/F/g/E access memory. No chip erase, EEPROM write, lock/fuse
 * command, or bootloader address is emitted. The reset-vector page is committed
 * last, after verifying the other pages and preserved EEPROM. Until then an
 * interrupted application has an erased reset vector and Caterina stays active.
 */

export const LEONARDO_APPLICATION_BYTES = 28672;
export const LEONARDO_PAGE_BYTES = 128;
export const LEONARDO_EEPROM_BYTES = 1024;
export const RUNTIME_FILTERS = Object.freeze([
  Object.freeze({ usbVendorId: 0x2341, usbProductId: 0x8036 }),
  Object.freeze({ usbVendorId: 0x2a03, usbProductId: 0x8036 }),
]);
export const BOOTLOADER_FILTERS = Object.freeze([
  Object.freeze({ usbVendorId: 0x2341, usbProductId: 0x0036 }),
  Object.freeze({ usbVendorId: 0x2a03, usbProductId: 0x0036 }),
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CR = 13;
const MAX_HEX_BYTES = 256000;
const DEFAULT_TIMEOUTS = Object.freeze({
  picker: 60000, open: 5000, command: 2000, runtime: 1800,
  download: 15000, cleanup: 4000, operation: 120000,
});

export class FirmwareInstallerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'FirmwareInstallerError';
    this.code = code;
  }
}
const error = (code, message) => new FirmwareInstallerError(code, message);
const bytesEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hexByte = (value) => value.toString(16).padStart(2, '0');

/** Strict Intel HEX parser. All addresses are BYTE addresses; gaps become FF. */
export function parseIntelHex(source) {
  if (typeof source !== 'string' || !source.length || source.length > MAX_HEX_BYTES || /[^\x09\x0a\x0d\x20-\x7e]/.test(source)) {
    throw error('invalid-hex', 'Firmware must be a bounded ASCII Intel HEX file.');
  }
  const data = new Uint8Array(LEONARDO_APPLICATION_BYTES).fill(0xff);
  const occupied = new Uint8Array(LEONARDO_APPLICATION_BYTES);
  let base = 0, ended = false, byteLength = 0, endAddress = 0;
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const fail = (message) => { throw error('invalid-hex', `HEX line ${index + 1}: ${message}`); };
    if (ended) fail('content follows the end-of-file record.');
    if (!/^:[0-9a-fA-F]+$/.test(raw) || raw.length < 11 || raw.length % 2 !== 1) fail('invalid record format.');
    const record = Uint8Array.from(raw.slice(1).match(/../g), (value) => Number.parseInt(value, 16));
    const count = record[0], address = record[1] * 256 + record[2], type = record[3];
    if (record.length !== count + 5) fail('record length does not match its byte count.');
    if (record.reduce((sum, value) => sum + value, 0) % 256 !== 0) fail('checksum does not match.');
    if (type === 0) {
      if (!count) fail('empty data record.');
      const start = base + address;
      if (start < 0 || start + count > LEONARDO_APPLICATION_BYTES) fail('data enters the bootloader or exceeds Leonardo application memory.');
      for (let offset = 0; offset < count; offset++) {
        if (occupied[start + offset]) fail('overlapping data records.');
        occupied[start + offset] = 1;
        data[start + offset] = record[4 + offset];
      }
      byteLength += count;
      endAddress = Math.max(endAddress, start + count);
    } else if (type === 1) {
      if (count !== 0 || address !== 0) fail('invalid end-of-file record.');
      ended = true;
    } else if (type === 2 || type === 4) {
      if (count !== 2 || address !== 0) fail('invalid extended-address record.');
      base = (record[4] * 256 + record[5]) * (type === 2 ? 16 : 65536);
    } else {
      fail(`unsupported record type ${type}; use the application HEX from the published release.`);
    }
  }
  if (!ended || !byteLength) throw error('invalid-hex', 'Firmware is empty or has no end-of-file record.');
  if (!occupied[0] || !occupied[1] || (data[0] === 0xff && data[1] === 0xff)) {
    throw error('invalid-hex', 'Firmware has no valid application reset vector.');
  }
  return { data, byteLength, startAddress: 0, endAddress };
}

function trustedUrl(value, baseUrl) {
  let base, result;
  try { base = new URL(baseUrl); result = new URL(value, base); }
  catch { throw error('invalid-manifest', 'The firmware URL is invalid.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:'))
    || result.origin !== base.origin || result.username || result.password || result.hash) {
    throw error('invalid-manifest', 'Firmware must come from this HTTPS website or its localhost development server.');
  }
  return result;
}

/** The trust root is the application's same-origin release manifest, never USB. */
export function validateFirmwareManifest(value, manifestUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.id !== 'babot-motion-leonardo'
    || value.board !== 'arduino:avr:leonardo' || value.protocol !== 1
    || value.maximumApplicationSize !== LEONARDO_APPLICATION_BYTES
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) || value.version.length > 64
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)
    || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_HEX_BYTES) {
    throw error('invalid-manifest', 'The firmware manifest is not a supported BaBot Leonardo release.');
  }
  const file = (name, suffix) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !name.endsWith(suffix)) {
      throw error('invalid-manifest', `The release ${suffix} filename is invalid.`);
    }
    return trustedUrl(name, manifestUrl).href;
  };
  return Object.freeze({ ...value, sha256: value.sha256.toLowerCase(),
    hexUrl: file(value.hex, '.hex'), sourceZipUrl: file(value.sourceZip, '.zip') });
}

function normalizeFailure(cause) {
  if (cause instanceof FirmwareInstallerError) return cause;
  if (cause?.name === 'AbortError' || cause?.name === 'NotFoundError') {
    return error('cancelled', 'Device selection or installation was cancelled.');
  }
  if (cause?.name === 'SecurityError' || cause?.name === 'NotAllowedError') {
    return error('permission-denied', 'USB permission was not granted. Select the device from a direct browser click.');
  }
  return new FirmwareInstallerError('transport', cause instanceof Error ? cause.message : 'USB installation failed.', { cause });
}

function bounded(promise, milliseconds, signal, label) {
  const pending = Promise.resolve(promise);
  if (signal?.aborted) {
    void pending.catch(() => {});
    return Promise.reject(error('cancelled', 'Installation cancelled.'));
  }
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => done(reject, error('cancelled', 'Installation cancelled.'));
    timer = setTimeout(() => done(reject, error('timeout', `${label} timed out. Disconnect USB and use the recovery instructions before retrying.`)), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    pending.then((value) => done(resolve, value), (cause) => done(reject, cause));
  });
}

function context(controller, timeouts) {
  const deadline = performance.now() + timeouts.operation;
  return {
    controller, signal: controller.signal, session: null,
    check() {
      if (controller.signal.aborted) throw error('cancelled', 'Installation cancelled.');
      if (performance.now() >= deadline) throw error('timeout', 'The installation operation exceeded its deadline.');
    },
    wait(promise, timeout, label) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        void Promise.resolve(promise).catch(() => {});
        return Promise.reject(error('timeout', 'The installation operation exceeded its deadline.'));
      }
      return bounded(promise, Math.min(timeout, remaining), controller.signal, label);
    },
  };
}

async function responseBytes(response, maximum, ctx, timeout) {
  if (!response.ok) throw error('download', `Firmware download returned HTTP ${response.status}.`);
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > maximum) throw error('download', 'Firmware download exceeds its permitted size.');
  if (!response.body?.getReader) {
    const value = new Uint8Array(await ctx.wait(response.arrayBuffer(), timeout, 'Firmware download'));
    if (value.length > maximum) throw error('download', 'Firmware download exceeds its permitted size.');
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await ctx.wait(reader.read(), timeout, 'Firmware download');
      if (done) break;
      size += value.length;
      if (size > maximum) throw error('download', 'Firmware download exceeds its permitted size.');
      chunks.push(value);
    }
  } finally {
    // Fetch receives the operation signal, too. Cancel without blocking on a
    // hostile response stream, then release the lock to reject any pending read.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function openPort(port, baudRate, ctx, timeouts, streams = true) {
  ctx.check();
  const session = { port, reader: null, writer: null, opened: false, openPromise: null, cleanupPromise: null, buffer: new Uint8Array() };
  ctx.session = session;
  session.openPromise = Promise.resolve().then(() => { ctx.check(); return port.open({ baudRate }); }).then(() => { session.opened = true; });
  await ctx.wait(session.openPromise, timeouts.open, 'Opening USB');
  if (streams) {
    if (!port.readable || !port.writable) throw error('transport', 'The selected device did not provide USB data streams.');
    session.reader = port.readable.getReader();
    session.writer = port.writable.getWriter();
  }
  return session;
}

async function closeSession(session, timeouts) {
  if (!session) return;
  if (session.cleanupPromise) return session.cleanupPromise;
  // Do not let a late open after cancellation leak an owned port. The caller
  // waits a bounded time and reports cleanup-failed if this remains pending.
  session.cleanupPromise = (async () => {
    try { await session.openPromise; } catch { return; }
    const settled = [];
    if (session.reader) {
      try { settled.push(bounded(session.reader.cancel(), timeouts.cleanup / 2, null, 'Cancelling USB reads').catch(() => {})); } catch {}
    }
    if (session.writer) {
      try { settled.push(bounded(session.writer.abort(), timeouts.cleanup / 2, null, 'Cancelling USB writes').catch(() => {})); } catch {}
    }
    await Promise.all(settled);
    try { session.reader?.releaseLock(); } catch {}
    try { session.writer?.releaseLock(); } catch {}
    session.reader = null; session.writer = null;
    await session.port.close();
    session.opened = false;
  })();
  return session.cleanupPromise;
}

async function readExactly(session, count, ctx, timeout) {
  while (session.buffer.length < count) {
    ctx.check();
    const { value, done } = await ctx.wait(session.reader.read(), timeout, 'USB response');
    if (done) throw error('disconnected', 'BaBot disconnected before verification completed.');
    if (!(value instanceof Uint8Array) || !value.length || session.buffer.length + value.length > 8192) {
      throw error('transport', 'The device returned an invalid USB response.');
    }
    const next = new Uint8Array(session.buffer.length + value.length);
    next.set(session.buffer); next.set(value, session.buffer.length); session.buffer = next;
  }
  const result = session.buffer.slice(0, count);
  session.buffer = session.buffer.slice(count);
  return result;
}

async function exchange(session, request, count, ctx, timeout) {
  ctx.check();
  await ctx.wait(session.writer.write(Uint8Array.from(request)), timeout, 'USB write');
  return readExactly(session, count, ctx, timeout);
}

async function acknowledged(session, request, ctx, timeout) {
  const reply = await exchange(session, request, 1, ctx, timeout);
  if (reply[0] !== CR) throw error('bootloader-mismatch', 'The bootloader rejected the programming command.');
}

async function address(session, value, ctx, timeout) {
  if (!Number.isInteger(value) || value < 0 || value >= LEONARDO_APPLICATION_BYTES / 2) throw error('address', 'Programming address is outside the application region.');
  await acknowledged(session, [65, value >> 8, value & 255], ctx, timeout);
}

async function readEeprom(session, ctx, timeouts) {
  const result = new Uint8Array(LEONARDO_EEPROM_BYTES);
  for (let offset = 0; offset < result.length; offset += LEONARDO_PAGE_BYTES) {
    // Caterina A doubles CurrAddress; g/E divides it again: EEPROM addresses
    // sent to A are BYTE offsets, unlike flash WORD offsets.
    await address(session, offset, ctx, timeouts.command);
    result.set(await exchange(session, [103, 0, LEONARDO_PAGE_BYTES, 69], LEONARDO_PAGE_BYTES, ctx, timeouts.command), offset);
  }
  return result;
}

async function writePage(session, offset, page, ctx, timeouts) {
  if (offset % LEONARDO_PAGE_BYTES || offset < 0 || offset + page.length > LEONARDO_APPLICATION_BYTES || page.length !== LEONARDO_PAGE_BYTES) {
    throw error('address', 'Only complete application flash pages may be programmed.');
  }
  await address(session, offset / 2, ctx, timeouts.command);
  await acknowledged(session, [66, 0, LEONARDO_PAGE_BYTES, 70, ...page], ctx, timeouts.command);
}

async function verifyPage(session, offset, page, ctx, timeouts) {
  await address(session, offset / 2, ctx, timeouts.command);
  const actual = await exchange(session, [103, 0, LEONARDO_PAGE_BYTES, 70], LEONARDO_PAGE_BYTES, ctx, timeouts.command);
  if (!bytesEqual(actual, page)) throw error('readback-mismatch', `Flash verification failed at application page 0x${offset.toString(16)}. Keep motor power disconnected and recover the firmware.`);
}

async function readRuntimeReply(session, verb, sequence, ctx, timeout) {
  const until = performance.now() + timeout;
  let total = 0;
  while (total < 4096) {
    const bytes = [];
    while (bytes.length < 256) {
      const remaining = until - performance.now();
      if (remaining <= 0) throw error('timeout', 'Firmware identification timed out.');
      const value = (await readExactly(session, 1, ctx, remaining))[0];
      total++;
      if (value === 10) break;
      bytes.push(value);
    }
    if (bytes.length >= 256) throw error('firmware-mismatch', 'Firmware identification response is too long.');
    const line = decoder.decode(Uint8Array.from(bytes)).trim();
    // Earlier protocol-1 releases reject unknown INFO before reading its seq.
    if (verb === 'INFO' && line === 'NACK 0 BAD_COMMAND') return line;
    if (line.startsWith(`ACK ${sequence} ${verb} `) || line.startsWith(`NACK ${sequence} `)) return line;
    if (line && !/^READY [A-Z0-9_ .-]+$/.test(line)) throw error('firmware-mismatch', 'The controller did not answer with the BaBot Motion protocol.');
  }
  throw error('firmware-mismatch', 'The controller returned too much identification data.');
}

/**
 * @param {{serial?:any, fetch?:typeof globalThis.fetch, crypto?:Crypto,
 *   onStage?:(state:{stage:string,message:string,progress?:number})=>void,
 *   signal?:AbortSignal, baseUrl?:string, timeouts?:Partial<typeof DEFAULT_TIMEOUTS>}} options
 */
export function createFirmwareInstaller(options = {}) {
  const serial = options.serial ?? globalThis.navigator?.serial;
  const fetcher = options.fetch ?? globalThis.fetch;
  const crypto = options.crypto ?? globalThis.crypto;
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  if (Object.values(timeouts).some((value) => !Number.isFinite(value) || value <= 0)) throw new TypeError('Installer deadlines must be positive finite milliseconds.');
  let release = null, image = null, active = null, cleanupPending = null;
  const stage = (name, message, progress) => {
    try { options.onStage?.({ stage: name, message, ...(progress === undefined ? {} : { progress }) }); } catch { /* Observers cannot interrupt a flash transaction. */ }
  };
  const requirePrepared = () => { if (!release || !image) throw error('not-prepared', 'Load and verify the firmware release before installing.'); };
  const requireSerial = () => {
    if (!serial?.requestPort) throw error('unsupported', 'Firmware installation requires a direct HTTPS tab in desktop Chrome or Edge with Web Serial.');
    if (typeof window !== 'undefined' && (!window.isSecureContext || window.top !== window.self)) throw error('unsupported', 'Open setup directly in a secure browser tab.');
  };
  const choose = (filters, ctx) => {
    ctx.check();
    requireSerial();
    // Intentionally no await before requestPort: retain the caller's activation.
    const selection = serial.requestPort({ filters: filters.map((entry) => ({ ...entry })) });
    return ctx.wait(selection, timeouts.picker, 'USB selection').then((port) => {
      const info = port.getInfo();
      if (!filters.some((entry) => entry.usbVendorId === info.usbVendorId && entry.usbProductId === info.usbProductId)) {
        throw error('wrong-device', 'Select the Arduino Leonardo device for this installation step.');
      }
      return port;
    });
  };
  const run = (work, success) => {
    if (active) return Promise.reject(error('busy', 'Another firmware operation is still running.'));
    if (cleanupPending) return Promise.reject(error('cleanup-failed', 'USB cleanup could not be confirmed. Unplug BaBot and reload setup before retrying.'));
    const controller = new AbortController();
    const ctx = context(controller, timeouts);
    const externalAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    const operation = { ctx, promise: null };
    active = operation;
    operation.promise = (async () => {
      let result, failure;
      try {
        if (ctx.signal.aborted) throw error('cancelled', 'Installation cancelled.');
        result = await work(ctx);
      } catch (cause) { failure = normalizeFailure(cause); }
      finally {
        controller.abort();
        options.signal?.removeEventListener('abort', externalAbort);
        if (ctx.session) {
          const cleanup = closeSession(ctx.session, timeouts);
          try { await bounded(cleanup, timeouts.cleanup, null, 'Closing USB'); }
          catch (cause) {
            cleanupPending = cleanup;
            void cleanup.then(() => { if (cleanupPending === cleanup) cleanupPending = null; }, () => {});
            failure = new FirmwareInstallerError('cleanup-failed', 'USB closure could not be confirmed. Unplug BaBot and reload setup before reconnecting or replaying.', { cause });
          }
        }
        if (active === operation) active = null;
      }
      if (failure) {
        stage(failure.code === 'cancelled' ? 'cancelled' : 'error', failure.message);
        throw failure;
      }
      success?.(result);
      return result;
    })();
    return operation.promise;
  };

  return {
    get busy() { return Boolean(active || cleanupPending); },
    get prepared() { return release; },
    prepare(manifestUrl) {
      return run(async (ctx) => {
        release = null; image = null;
        stage('preparing', 'Downloading and checking the published firmware.');
        if (!fetcher || !crypto?.subtle) throw error('unsupported', 'This browser cannot verify firmware downloads.');
        const url = trustedUrl(manifestUrl, baseUrl);
        const get = async (address, maximum) => {
          ctx.check();
          const response = await ctx.wait(fetcher(address, { signal: ctx.signal, cache: 'no-store', redirect: 'error', credentials: 'same-origin' }), timeouts.download, 'Firmware download');
          if (response.url && new URL(response.url).href !== address) throw error('download', 'Firmware downloads must not redirect.');
          return responseBytes(response, maximum, ctx, timeouts.download);
        };
        let manifest;
        try { manifest = JSON.parse(decoder.decode(await get(url.href, 16384))); }
        catch (cause) {
          if (cause instanceof FirmwareInstallerError || ctx.signal.aborted) throw cause;
          throw error('invalid-manifest', 'The firmware manifest could not be read.');
        }
        const validated = validateFirmwareManifest(manifest, url.href);
        const downloaded = await get(validated.hexUrl, validated.sizeBytes);
        if (downloaded.length !== validated.sizeBytes) throw error('integrity', 'The firmware download size does not match its release.');
        const digest = new Uint8Array(await ctx.wait(crypto.subtle.digest('SHA-256', downloaded), timeouts.download, 'Firmware checksum'));
        if (Array.from(digest, hexByte).join('') !== validated.sha256) throw error('integrity', 'The firmware SHA-256 checksum does not match its release.');
        const parsed = parseIntelHex(decoder.decode(downloaded));
        if ((validated.firmwareByteLength !== undefined && validated.firmwareByteLength !== parsed.byteLength)
          || (validated.applicationStart !== undefined && validated.applicationStart !== parsed.startAddress)
          || (validated.applicationEndExclusive !== undefined && validated.applicationEndExclusive !== parsed.endAddress)) {
          throw error('integrity', 'The firmware address range does not match its release.');
        }
        image = parsed.data; release = validated;
        return release;
      }, () => stage('ready', 'Firmware download and checksum verified.'));
    },

    resetRuntime() {
      return run(async (ctx) => {
        requirePrepared();
        stage('select-runtime', 'Select BaBot / Arduino Leonardo to enter its bootloader.');
        const port = await choose(RUNTIME_FILTERS, ctx);
        stage('resetting', 'Restarting Leonardo into its upload bootloader.');
        await openPort(port, 1200, ctx, timeouts, false);
        if (typeof port.setSignals !== 'function') throw error('unsupported', 'This device cannot perform the Leonardo USB reset. Use the physical reset button.');
        ctx.check();
        await ctx.wait(port.setSignals({ dataTerminalReady: true }), timeouts.command, 'USB reset signal');
        ctx.check();
        await ctx.wait(port.setSignals({ dataTerminalReady: false }), timeouts.command, 'USB reset signal');
        return { reset: true };
      }, () => stage('select-bootloader', 'Choose the Leonardo bootloader promptly, or press its reset button and try again.'));
    },

    flashBootloader() {
      return run(async (ctx) => {
        requirePrepared();
        stage('select-bootloader', 'Select the Arduino Leonardo bootloader to install the verified release.');
        const port = await choose(BOOTLOADER_FILTERS, ctx);
        const session = await openPort(port, 57600, ctx, timeouts);
        stage('identifying', 'Checking Caterina and the ATmega32U4 signature.');
        if (decoder.decode(await exchange(session, [83], 7, ctx, timeouts.command)) !== 'CATERIN') {
          // SOFTWARE_IDENTIFIER is CATERINA, but Caterina transmits 7 bytes.
          throw error('bootloader-mismatch', 'This is not the supported Arduino Caterina bootloader.');
        }
        const signature = await exchange(session, [115], 3, ctx, timeouts.command);
        if (!bytesEqual(signature, Uint8Array.of(0x87, 0x95, 0x1e))) throw error('wrong-device', 'The bootloader signature is not ATmega32U4 (1e9587). Nothing was written.');
        const block = await exchange(session, [98], 3, ctx, timeouts.command);
        if (!bytesEqual(block, Uint8Array.of(89, 0, LEONARDO_PAGE_BYTES))) throw error('bootloader-mismatch', 'The bootloader does not support Leonardo 128-byte flash pages.');
        await acknowledged(session, [80], ctx, timeouts.command);
        stage('reading-eeprom', 'Reading existing servo calibration before programming.');
        const eeprom = await readEeprom(session, ctx, timeouts);
        const empty = new Uint8Array(LEONARDO_PAGE_BYTES).fill(0xff);
        stage('programming', 'Preparing the application for a recoverable installation.', 0);
        await writePage(session, 0, empty, ctx, timeouts);
        await verifyPage(session, 0, empty, ctx, timeouts);
        for (let offset = LEONARDO_PAGE_BYTES; offset < image.length; offset += LEONARDO_PAGE_BYTES) {
          const page = image.subarray(offset, offset + LEONARDO_PAGE_BYTES);
          stage('programming', 'Installing and reading back application flash.', offset / image.length);
          await writePage(session, offset, page, ctx, timeouts);
          await verifyPage(session, offset, page, ctx, timeouts);
        }
        stage('verifying-eeprom', 'Checking that existing servo calibration is unchanged.');
        if (!bytesEqual(eeprom, await readEeprom(session, ctx, timeouts))) throw error('eeprom-changed', 'EEPROM changed during installation. The application remains uncommitted; use recovery before connecting motor power.');
        stage('verifying-flash', 'Committing and checking the verified application reset page.', 1);
        await writePage(session, 0, image.subarray(0, LEONARDO_PAGE_BYTES), ctx, timeouts);
        try {
          await verifyPage(session, 0, image.subarray(0, LEONARDO_PAGE_BYTES), ctx, timeouts);
          if (!bytesEqual(eeprom, await readEeprom(session, ctx, timeouts))) throw error('eeprom-changed', 'EEPROM changed during the final verification. Keep motor power disconnected and recover the firmware.');
        } catch (cause) {
          // A completed but incorrect read leaves the command stream aligned.
          // Re-blank reset only in that case; never send commands after an I/O
          // timeout, cancellation, or disconnect with unknown protocol state.
          if (['readback-mismatch', 'eeprom-changed'].includes(cause?.code) && !ctx.signal.aborted) {
            await writePage(session, 0, empty, ctx, timeouts);
            await verifyPage(session, 0, empty, ctx, timeouts);
          }
          throw cause;
        }
        stage('restarting', 'Flash and EEPROM verified. Restarting the installed firmware.');
        await acknowledged(session, [69], ctx, timeouts.command);
        return { verified: true, version: release.version, signature: '1e9587', eepromPreserved: true, bytesWritten: image.length };
      }, () => stage('awaiting-verification', 'Installation verified. Reconnect the running Leonardo to check its firmware version.'));
    },

    verifyRuntime({ requirePreparedVersion = false } = {}) {
      return run(async (ctx) => {
        if (requirePreparedVersion) requirePrepared();
        stage('select-verification', 'Select the running BaBot / Arduino Leonardo to check its firmware.');
        const port = await choose(RUNTIME_FILTERS, ctx);
        const session = await openPort(port, 115200, ctx, timeouts);
        ctx.check();
        if (typeof port.setSignals === 'function') await ctx.wait(port.setSignals({ dataTerminalReady: true }), timeouts.command, 'USB connection signal');
        stage('verifying-runtime', 'Reading firmware identity and version without moving BaBot.');
        let ping;
        try {
          ctx.check();
          await ctx.wait(session.writer.write(encoder.encode('PING 1\n')), timeouts.runtime, 'Firmware identification');
          ping = await readRuntimeReply(session, 'PING', 1, ctx, timeouts.runtime);
        } catch (cause) {
          if (['timeout', 'firmware-mismatch'].includes(cause?.code)) {
            if (requirePreparedVersion) throw error('firmware-mismatch', 'The installed firmware could not be identified. Keep motor power disconnected and use recovery.');
            return { compatible: false, reason: 'firmware-missing', message: 'BaBot Motion firmware was not identified. Install it to enable lap replay.' };
          }
          throw cause;
        }
        if (!/^ACK 1 PING BABOT_MOTION 1$/.test(ping)) {
          if (requirePreparedVersion) throw error('firmware-mismatch', 'The installed controller did not identify as BaBot Motion protocol 1.');
          return { compatible: false, reason: 'firmware-mismatch', message: 'This controller does not report compatible BaBot Motion firmware.' };
        }
        let info = null;
        try {
          ctx.check();
          await ctx.wait(session.writer.write(encoder.encode('INFO 2\n')), timeouts.runtime, 'Firmware version');
          const line = await readRuntimeReply(session, 'INFO', 2, ctx, timeouts.runtime);
          const match = /^ACK 2 INFO BABOT_MOTION 1 VERSION (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) BOARD ATMEGA32U4 OFFSETS (-?\d+) (-?\d+) (-?\d+)$/.exec(line);
          if (match) {
            const offsets = match.slice(2).map(Number);
            if (!offsets.every((value) => Number.isSafeInteger(value) && value >= 50 && value <= 150)) throw error('firmware-mismatch', 'Firmware reported invalid servo calibration offsets.');
            info = { version: match[1], board: 'ATMEGA32U4', offsets };
          } else if (line !== 'NACK 0 BAD_COMMAND' && !/^NACK 2 /.test(line)) throw error('firmware-mismatch', 'The firmware information response is incompatible.');
        } catch (cause) {
          if (cause?.code !== 'timeout') throw cause;
        }
        const current = Boolean(release && info?.version === release.version);
        if (requirePreparedVersion && !current) throw error('version-mismatch', `The controller did not verify installed firmware ${release.version}. Keep motor power disconnected and check recovery.`);
        return { compatible: true, protocol: 1, version: info?.version ?? null, board: info?.board ?? null, offsets: info?.offsets ?? null, current };
      }, (result) => stage(result.compatible ? 'complete' : 'firmware-missing', result.compatible
        ? `BaBot Motion ${result.version ?? 'protocol 1'} verified. USB has been released; complete mounting checks before replay.` : result.message));
    },

    async cancel() {
      const operation = active;
      if (operation) {
        operation.ctx.controller.abort();
        try { await operation.promise; }
        catch (cause) { if (cause?.code === 'cleanup-failed') throw cause; }
      }
      if (cleanupPending) throw error('cleanup-failed', 'USB cleanup is still pending. Unplug BaBot and reload setup before reconnecting.');
    },
  };
}
