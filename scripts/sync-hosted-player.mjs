#!/usr/bin/env node
// Refresh the existing Site's player source while retaining its rendered media.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.join(root, '.sites/lapform-deploy');
const manifest = JSON.parse(await readFile(path.join(checkout, '.openai/hosting.json'), 'utf8'));
if (manifest.project_id !== 'appgprj_6a5793fec7848191a0e76239e6100a8b') {
  throw new Error('Open the existing Lapform Site source before syncing BaBot.');
}
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'web-player'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
let copied = 0;
for (const file of files) {
  const relative = file.slice('web-player/'.length);
  // Never transfer local identity, device observations, or generated output.
  if (/(^|\/)(?:\.git|\.openai|\.openf1-pole-cache|node_modules|dist|qa|media|evidence)(\/|$)/.test(relative)) continue;
  if (/\.(?:mp4|mov|webm|log)$/i.test(relative)) continue;
  const target = path.join(checkout, 'apps/babot', relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, file), target);
  copied++;
}
console.log(`Copied ${copied} BaBot source/release files. Existing rendered media retained.`);
