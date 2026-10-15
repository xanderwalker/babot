#!/usr/bin/env node
/** Resumable, disk-bounded production renders using the approved Blender scene.
 * Plan: node scripts/render-season-ribbons.mjs
 * Render: node scripts/render-season-ribbons.mjs --render [--event australia]
 * Stop between chunks: create media/2026/STOP (remove it to resume).
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat, rename, readdir, rm, copyFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SETTINGS = { fps: 50, width: 810, height: 720, samples: 16, chunkFrames: 500 };
const RENDERER = path.join(ROOT, 'scripts/blender/render_lap_ribbon.py');
const CODE = ['render_lap_ribbon.py', 'twin_ribbon_hyper.py', 'twin_ribbon_animation.py', 'twin_ribbon_cinematic.py', 'twin_ribbon_dynamics.py', 'rpm_twist.py'];
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = async p => stat(p).then(() => true, () => false);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

export function fixtureContract(fixture) {
  const m = fixture.meta;
  if (!m || m.season !== 2026 || m.poleVerified !== true || !m.datasetId || !m.sessionKey || !m.driverNumber || !m.lapNumber || !Number.isFinite(m.lapDurationSeconds) || m.lapDurationSeconds <= 0) throw new Error('Expected a verified 2026 pole-lap fixture');
  const rows = fixture.carSamples;
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('Expected measured car samples');
  if (rows.some((row, i) => row.length < 6 || row.slice(0, 6).some(n => !Number.isFinite(n)) || row[0] < 0 || row[0] > m.lapDurationSeconds * 1000 + 0.001 || (i && row[0] <= rows[i - 1][0]))) throw new Error('Invalid or unordered measured car samples');
  const frameCount = Math.ceil(m.lapDurationSeconds * SETTINGS.fps);
  return { ...SETTINGS, frameCount, duration: frameCount / SETTINGS.fps, lapDurationSeconds: m.lapDurationSeconds,
    datasetId: m.datasetId, sessionKey: m.sessionKey, driverNumber: m.driverNumber, lapNumber: m.lapNumber };
}

export function frameChunks(count, chunkSize = SETTINGS.chunkFrames) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid frame counts');
  const chunks = [];
  for (let start = 1; start <= count; start += chunkSize) chunks.push({ start, end: Math.min(count, start + chunkSize - 1) });
  return chunks;
}

export function validateProbe(info, expected) {
  const v = info.streams?.find(s => s.codec_type === 'video') || info.streams?.[0];
  if (!v || v.codec_name !== 'h264' || v.width !== expected.width || v.height !== expected.height || v.r_frame_rate !== `${expected.fps}/1` || Number(v.nb_read_frames) !== expected.frameCount || Math.abs(Number(v.duration) - expected.frameCount / expected.fps) > 0.001) throw new Error(`Encoded contract mismatch: ${JSON.stringify(v)}`);
  return v;
}

export function run(command, args, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = []; let stderr = ''; const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    child.stdout.on('data', data => { if (log) log.write(data); else output.push(data); });
    child.stderr.on('data', data => { if (log) log.write(data); stderr = (stderr + data.toString()).slice(-6000); });
    child.on('error', error => { log?.end(); reject(error); });
    child.on('close', code => { log?.end(); if (code) reject(new Error(`${path.basename(command)} exited ${code}: ${stderr || `see ${logFile}`}`)); else resolve(Buffer.concat(output).toString()); });
  });
}

async function verifyVideo(file, contract, fullDecode = true) {
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', file]));
  validateProbe(probe, contract);
  if (fullDecode) await run('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  return { probe, bytes: (await stat(file)).size, sha256: hash(await readFile(file)) };
}

async function fingerprint(source) {
  const codeSha256 = {};
  for (const name of CODE) codeSha256[name] = hash(await readFile(path.join(path.dirname(RENDERER), name)));
  codeSha256['render-season-ribbons.mjs'] = hash(await readFile(fileURLToPath(import.meta.url)));
  return { source_sha256: hash(await readFile(source)), codeSha256, settings: SETTINGS };
}

async function publish(eventId, fixture, contract, work, target, verification, render) {
  const final = path.join(target, 'ribbon.mp4');
  const poster = path.join(target, 'poster.jpg');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(40, contract.duration / 2)), '-i', final, '-frames:v', '1', '-q:v', '2', '-y', poster]);
  const meta = { src: `/media/2026/${eventId}/ribbon.mp4`, poster: `/media/2026/${eventId}/poster.jpg`,
    fps: contract.fps, startTimeSeconds: 0, duration: contract.duration, datasetId: contract.datasetId,
    sessionKey: contract.sessionKey, driverNumber: contract.driverNumber, lapNumber: contract.lapNumber,
    title: `${fixture.meta.meetingName} 2026 · ${fixture.meta.driverName} pole · Blender Twin Ribbon`,
    source: 'Approved continuous corkscrew Blender workflow with this exact measured OpenF1 pole lap.',
    verification: { width: contract.width, height: contract.height, frameCount: contract.frameCount, bytes: verification.bytes,
      sha256: verification.sha256, fullDecode: true, sourceSha256: hash(await readFile(work.source)), endpointPolicy: render.endpointPolicy } };
  // Readiness is atomic and is the last publication action.
  await atomicJSON(path.join(target, 'ribbon.json'), meta);
  await atomicJSON(path.join(target, 'ribbon-progress.json'), { completed: contract.frameCount, total: contract.frameCount, ready: true, datasetId: contract.datasetId, message: 'Blender ribbon ready' });
  await atomicJSON(path.join(work.dir, 'encoded-verification.json'), { ...meta, probe: verification.probe });
  return meta;
}

async function adoptSingapore(eventId, fixture, contract, work, target) {
  if (contract.datasetId !== 'openf1-singapore-2026-verstappen-pole') return false;
  const old = await json(path.join(ROOT, 'data/openf1-singapore-2026-verstappen-pole.json'));
  if (old.meta.sessionKey !== contract.sessionKey || old.meta.driverNumber !== contract.driverNumber || old.meta.lapNumber !== contract.lapNumber || old.meta.lapDurationSeconds !== contract.lapDurationSeconds || JSON.stringify(old.carSamples) !== JSON.stringify(fixture.carSamples)) return false;
  const video = path.join(ROOT, 'public/media/singapore-2026-ribbon.mp4');
  if (!await exists(video)) return false;
  const verification = await verifyVideo(video, contract);
  await copyFile(video, path.join(target, 'ribbon.mp4'));
  const render = await json(path.join(ROOT, 'media/singapore-2026-corkscrew-full/render-manifest.json'));
  await publish(eventId, fixture, contract, work, target, verification, render);
  return true;
}

export async function renderEvent(source, options = {}) {
  const eventId = path.basename(source, '.json');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(eventId)) throw new Error(`Unsafe event id: ${eventId}`);
  const fixture = await json(source); const contract = fixtureContract(fixture);
  const dir = path.join(ROOT, 'media/2026', eventId); const target = path.join(ROOT, 'public/media/2026', eventId);
  const work = { source, dir };
  await mkdir(dir, { recursive: true }); await mkdir(target, { recursive: true });
  const identity = await fingerprint(source); const identityFile = path.join(dir, 'pipeline-identity.json');
  if (await exists(identityFile) && JSON.stringify(await json(identityFile)) !== JSON.stringify(identity)) throw new Error(`${eventId}: source or renderer changed; preserve existing output and use a fresh render directory`);
  const ready = path.join(target, 'ribbon.json');
  if (await exists(ready)) {
    const existing = await json(ready);
    if (existing.datasetId !== contract.datasetId || existing.sessionKey !== contract.sessionKey || existing.driverNumber !== contract.driverNumber || existing.lapNumber !== contract.lapNumber || existing.verification?.sourceSha256 !== identity.source_sha256) throw new Error(`${eventId}: published identity no longer matches telemetry`);
    const verified = await verifyVideo(path.join(target, 'ribbon.mp4'), contract);
    if (verified.sha256 !== existing.verification.sha256) throw new Error(`${eventId}: published media hash mismatch`);
    console.log(`${eventId}: verified ready (${contract.frameCount} frames)`); return { eventId, ready: true, skipped: true };
  }
  if (options.verifyOnly) throw new Error(`${eventId}: no complete ribbon published`);
  await atomicJSON(identityFile, identity);
  if (await adoptSingapore(eventId, fixture, contract, work, target)) { console.log(`${eventId}: reused verified Singapore film`); return { eventId, ready: true, reused: true }; }
  const parts = []; let newlyRenderedChunks = 0;
  const stop = path.join(ROOT, 'media/2026/STOP');
  for (const { start, end } of frameChunks(contract.frameCount, options.chunkFrames || SETTINGS.chunkFrames)) {
    const stem = `part-${String(start).padStart(5, '0')}-${String(end).padStart(5, '0')}`;
    const part = path.join(dir, `${stem}.mp4`); const receipt = path.join(dir, `${stem}.json`);
    const partContract = { ...contract, frameCount: end - start + 1 };
    if (await exists(receipt) && await exists(part)) {
      const saved = await json(receipt); const currentHash = hash(await readFile(part));
      if (saved.sha256 === currentHash && saved.frameCount === partContract.frameCount && saved.source_sha256 === identity.source_sha256 && saved.fullDecode === true) { parts.push(part); continue; }
      throw new Error(`${eventId}: segment verification mismatch (${stem})`);
    }
    if (await exists(stop) || (options.maxChunks && newlyRenderedChunks >= options.maxChunks)) {
      await atomicJSON(path.join(target, 'ribbon-progress.json'), { completed: start - 1, total: contract.frameCount, ready: false, datasetId: contract.datasetId, message: 'Blender render paused; resume the season pipeline to continue.' });
      console.log(`${eventId}: paused after ${start - 1}/${contract.frameCount} verified frames`); return { eventId, ready: false, paused: true };
    }
    const disk = await statfs(dir); if (disk.bavail * disk.bsize < 3 * 1024 ** 3) throw new Error('Less than 3 GiB free; rendering paused before creating more frames');
    const begun = Date.now();
    console.log(`${eventId}: rendering ${start}–${end}/${contract.frameCount}`);
    await run(options.blender || process.env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/Blender', ['--background', '--python', RENDERER, '--', '--data', source, '--output', dir, '--start-frame', String(start), '--end-frame', String(end), '--samples', String(SETTINGS.samples), '--progress', path.join(target, 'ribbon-progress.json')], path.join(dir, 'render.log'));
    for (let n = start; n <= end; n++) if ((await stat(path.join(dir, 'frames', `frame-${String(n).padStart(4, '0')}.png`))).size < 100) throw new Error(`Missing Blender frame ${n}`);
    const partial = path.join(dir, `${stem}.encoding.mp4`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', String(contract.fps), '-start_number', String(start), '-i', path.join(dir, 'frames/frame-%04d.png'), '-frames:v', String(partContract.frameCount), '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-maxrate', '1800k', '-bufsize', '3600k', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', '-an', '-y', partial]);
    const verified = await verifyVideo(partial, partContract);
    await rename(partial, part);
    await atomicJSON(receipt, { ...verified, fullDecode: true, start, end, frameCount: partContract.frameCount, source_sha256: identity.source_sha256, seconds: (Date.now() - begun) / 1000 });
    // Only frames generated by this bounded chunk are deleted, after full decode.
    for (let n = start; n <= end; n++) await rm(path.join(dir, 'frames', `frame-${String(n).padStart(4, '0')}.png`));
    parts.push(part); newlyRenderedChunks++;
    console.log(`${eventId}: verified ${end}/${contract.frameCount} frames; chunk ${((Date.now() - begun) / 1000).toFixed(1)}s`);
  }
  const list = path.join(dir, 'concat.txt');
  // Parts have controlled filenames; paths are relative to the list's directory.
  await writeFile(list, `${parts.map(p => `file '${path.basename(p)}'`).join('\n')}\n`);
  const partial = path.join(target, 'ribbon.encoding.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', partial]);
  const verified = await verifyVideo(partial, contract);
  if (verified.bytes >= Math.max(24, contract.duration * 0.25) * 1024 ** 2) throw new Error(`${eventId}: film exceeds web size budget`);
  await rename(partial, path.join(target, 'ribbon.mp4'));
  await publish(eventId, fixture, contract, work, target, verified, await json(path.join(dir, 'render-manifest.json')));
  console.log(`${eventId}: ready (${contract.frameCount} verified frames, ${(verified.bytes / 1024 ** 2).toFixed(1)} MiB)`);
  return { eventId, ready: true };
}

async function main() {
  const argv = process.argv.slice(2); const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const dataDir = path.join(ROOT, 'public/data/2026');
  const files = (await readdir(dataDir)).filter(f => f.endsWith('.json')).sort();
  const requested = value('--event'); const selected = requested ? files.filter(f => f === `${requested}.json`) : files;
  if (!selected.length) throw new Error(`No pole fixtures found${requested ? ` for ${requested}` : ''}`);
  const sources = [];
  for (const name of selected) {
    const source = path.join(dataDir, name); const data = await json(source);
    if (!data.carSamples) continue;
    const contract = fixtureContract(data); sources.push({ source, contract });
  }
  if (!argv.includes('--render') && !argv.includes('--verify-only')) {
    console.log(JSON.stringify({ mode: 'plan', events: sources.map(({ source, contract }) => ({ eventId: path.basename(source, '.json'), ...contract })), estimatedRenderHours: sources.reduce((n, s) => n + s.contract.frameCount * 0.528 / 3600, 0), temporaryDiskGiB: 2, command: 'node scripts/render-season-ribbons.mjs --render' }, null, 2)); return;
  }
  const lock = path.join(ROOT, 'media/2026/.render-lock'); await mkdir(path.dirname(lock), { recursive: true });
  try { await mkdir(lock); } catch { throw new Error('A ribbon batch holds media/2026/.render-lock. If it crashed, verify no Blender batch is running before removing the lock.'); }
  await atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
  try {
    let done = 0;
    for (const { source } of sources) {
      const result = await renderEvent(source, { verifyOnly: argv.includes('--verify-only'), maxChunks: Number(value('--max-chunks')) || undefined, chunkFrames: Number(value('--chunk-frames')) || undefined, blender: value('--blender') });
      if (result.paused || (++done >= (Number(value('--max-events')) || Infinity))) break;
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
