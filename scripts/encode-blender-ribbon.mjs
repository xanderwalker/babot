#!/usr/bin/env node
/** Encode and verify the exact Blender sequence before publishing readiness. */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'media/singapore-2026-corkscrew-full');
const frames = path.join(source, 'frames');
const output = path.join(root, 'public/media');
const manifest = JSON.parse(await readFile(path.join(source, 'render-manifest.json'), 'utf8'));
const count = manifest.frameCount;
if (count !== 4569 || manifest.fps !== 50 || manifest.datasetId !== 'openf1-singapore-2026-verstappen-pole') throw new Error('Unexpected source render identity');
const names = new Set(await readdir(frames));
for (let frame = 1; frame <= count; frame++) {
  const name = `frame-${String(frame).padStart(4, '0')}.png`;
  if (!names.has(name) || (await stat(path.join(frames, name))).size < 100) throw new Error(`Missing or empty Blender frame: ${name}`);
}
await mkdir(output, { recursive: true });
const partial = path.join(output, 'singapore-2026-ribbon.encoding.mp4');
const final = path.join(output, 'singapore-2026-ribbon.mp4');
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  return r.stdout;
}
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '50', '-start_number', '1', '-i', path.join(frames, 'frame-%04d.png'), '-frames:v', String(count), '-c:v', 'libx264', '-preset', 'medium', '-crf', '24', '-maxrate', '1800k', '-bufsize', '3600k', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', '-an', '-y', partial]);
const info = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames,duration', '-of', 'json', partial]));
const video = info.streams[0];
if (video.codec_name !== 'h264' || video.width !== 810 || video.height !== 720 || video.r_frame_rate !== '50/1' || Number(video.nb_read_frames) !== count || Math.abs(Number(video.duration) - 91.38) > 0.001) throw new Error(`Encoded contract mismatch: ${JSON.stringify(video)}`);
run('ffmpeg', ['-v', 'error', '-xerror', '-i', partial, '-f', 'null', '-']);
const bytes = (await stat(partial)).size;
if (bytes >= 24 * 1024 * 1024) throw new Error(`Web rendition exceeds 24MiB: ${bytes}`);
await rename(partial, final);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '40', '-i', final, '-frames:v', '1', '-q:v', '2', '-y', path.join(output, 'singapore-2026-ribbon-poster.jpg')]);
const metadata = { src: '/media/singapore-2026-ribbon.mp4', poster: '/media/singapore-2026-ribbon-poster.jpg', fps: 50, startTimeSeconds: 0, duration: 91.38, title: 'Singapore 2026 · Verstappen pole · Blender Twin Ribbon', source: 'Approved continuous corkscrew Blender workflow with matching OpenF1 session11384, driver3, lap11.', verification: { width: 810, height: 720, frameCount: count, bytes, fullDecode: true, endpointPolicy: manifest.endpointPolicy } };
await writeFile(path.join(output, 'ribbon.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(path.join(output, 'ribbon-progress.json'), JSON.stringify({ completed: count, total: count, message: 'Blender ribbon ready', ready: true }) + '\n');
await writeFile(path.join(source, 'encoded-verification.json'), JSON.stringify({ ...metadata, probe: info }, null, 2) + '\n');
console.log(JSON.stringify(metadata, null, 2));
