#!/usr/bin/env node
/** Capture public-source frames locally for human clock verification; never changes syncStatus. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { publicPolicy, publicCatalog, catalogIdentity } from './refresh-season-media.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
if (!args.event || !/^[a-z-]+$/.test(args.event)) throw new Error('Usage: node scripts/capture-season-media-evidence.mjs --event=japan [--start=2] [--directory=/tmp/babot-media-evidence]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'public/data/season-2026-media.json'), 'utf8'));
const media = manifest.events[args.event];
if (!media?.videoId) throw new Error('No official video discovered for this event');
const start = args.start != null ? Number(args.start) : media.lapStartSeconds;
if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) throw new Error('Supply a candidate --start offset for unverified media');
const fixture = JSON.parse(await readFile(path.join(root, `public/data/2026/${args.event}.json`), 'utf8'));
const catalog = await publicCatalog(media.videoId, await publicPolicy());
catalogIdentity(catalog, args.event, manifest.season);
const candidates = catalog.sources.filter(source => source.container === 'MP4' && source.src?.startsWith('https://')).sort((a, b) => (a.height || 0) - (b.height || 0));
const source = candidates.find(item => item.height >= 360) || candidates.at(-1);
if (!source) throw new Error('No freely accessible MP4 rendition; do not bypass access controls');
const directory = path.resolve(args.directory || path.join(os.tmpdir(), 'babot-media-evidence'), args.event);
await mkdir(directory, { recursive: true });
const video = path.join(directory, `${media.videoId}.mp4`);
if (!await stat(video).catch(() => null)) {
  const response = await fetch(source.src, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Public MP4 HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(video));
}
const duration = fixture.meta.lapDurationSeconds;
const frames = [
  ['start', start], ['clock-early', 10], ['clock-middle', Math.min(50, start + duration / 2)],
  ['sector-one', start + fixture.meta.sectorDurationSeconds[0] + 0.3],
  ['finish-before', start + duration - 0.3], ['finish-after', start + duration + 0.1],
  ['result-early', start + duration + 1], ['result', start + duration + 3.5], ['result-late', start + duration + 5],
];
for (const [label, seconds] of frames) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', video, '-frames:v', '1', '-vf', 'scale=960:540', '-y', path.join(directory, `${label}.jpg`)]);
}
const report = {
  eventId: args.event, videoId: media.videoId, officialPageUrl: media.officialPageUrl,
  candidateLapStartSeconds: start, fixtureLapDurationSeconds: duration,
  fixtureSectorsSeconds: fixture.meta.sectorDurationSeconds,
  frames: frames.map(([label, videoSeconds]) => ({ file: `${label}.jpg`, videoSeconds })),
  instruction: 'Inspect actual broadcast clocks, driver and timing stripe. Record observations and confirm lap identity before changing the manifest. The script does not certify synchronization.',
};
await writeFile(path.join(directory, 'inspection.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ directory, frames: frames.length, manifestChanged: false }, null, 2));
