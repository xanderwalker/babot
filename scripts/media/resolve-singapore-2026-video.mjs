#!/usr/bin/env node
/** Resolve the official freely accessible F1 player catalog; never bypass DRM or a paywall. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VIDEO_ID = '1878677458343183007';
export const ACCOUNT_ID = '6057949432001';
export const PLAYER_ID = 'FC1Xxg8gIw';
export const PAGE_URL = 'https://www.formula1.com/en/video/onboard-max-verstappens-2026-pirelli-pole-position-award-lap-at-the-singapore-grand-prix.' + VIDEO_ID;
const PLAYER_URL = `https://players.brightcove.net/${ACCOUNT_ID}/${PLAYER_ID}_default/index.min.js`;
const CATALOG_URL = `https://edge.api.brightcove.com/playback/v1/accounts/${ACCOUNT_ID}/videos/${VIDEO_ID}`;

export async function resolveSingaporeVideo() {
  const playerResponse = await fetch(PLAYER_URL);
  if (!playerResponse.ok) throw new Error(`Official player: HTTP ${playerResponse.status}`);
  const playerSource = await playerResponse.text();
  // This is the public playback policy distributed in F1's browser player, not an account credential.
  const policyKey = playerSource.match(/videoCloud:\{policyKey:"([^"]+)"/)?.[1];
  if (!policyKey) throw new Error('Public playback policy is unavailable');
  const catalogResponse = await fetch(CATALOG_URL, { headers: { Accept: `application/json;pk=${policyKey}` } });
  if (!catalogResponse.ok) throw new Error(`Official catalog: HTTP ${catalogResponse.status}`);
  const catalog = await catalogResponse.json();
  if (catalog.id !== VIDEO_ID || !catalog.name?.includes('2026') || !catalog.name?.includes('Max Verstappen')) {
    throw new Error('Official video identity mismatch');
  }
  const mp4 = catalog.sources.filter(source => source.src?.startsWith('https://') && source.container === 'MP4')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (!mp4) throw new Error('No public HTTPS MP4 rendition available');
  let expiresAtUtc = null;
  try {
    const policy = new URL(mp4.src).searchParams.get('Policy').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const expiry = JSON.parse(Buffer.from(policy, 'base64').toString()).Statement[0].Condition.DateLessThan['AWS:EpochTime'];
    expiresAtUtc = new Date(expiry * 1000).toISOString();
  } catch {}
  return {
    schemaVersion: 1,
    videoId: VIDEO_ID,
    title: catalog.name,
    officialPageUrl: PAGE_URL,
    publicPlayerUrl: PLAYER_URL,
    publicCatalogUrl: CATALOG_URL,
    sourceUrl: mp4.src,
    posterUrl: catalog.poster,
    sourceMimeType: 'video/mp4',
    sourceWidth: mp4.width,
    sourceHeight: mp4.height,
    sourceDurationSeconds: catalog.duration / 1000,
    publishedAtUtc: catalog.published_at,
    resolvedAtUtc: new Date().toISOString(),
    expiresAtUtc,
    localFallbackUrl: './data/singapore-2026-verstappen-pole.mp4',
    lapStartVideoSeconds: 2.1,
    sync: {
      status: 'frame-verified',
      lapDurationSeconds: 91.373,
      lapEndVideoSeconds: 93.473,
      estimatedUncertaintySeconds: 0.1,
      method: 'Broadcast lap clock and start/finish stripe visually checked against exact OpenF1 lap duration.',
      evidence: [
        { videoSeconds: 2.1, observed: 'Clock 0.0; car crosses the timing stripe.' },
        { videoSeconds: 10, observed: 'Clock 7.9.' },
        { videoSeconds: 29.1, observed: 'Clock 27.0 at sector 1 boundary; OpenF1 S1 is 27.002.' },
        { videoSeconds: 93.48, observed: 'Clock 1:31.3; the same timing stripe crosses beneath the car, consistent with 91.373-second lap.' }
      ],
      note: 'Broadcast timer resolution is 0.1s; this is an initial visual alignment, with user trim supported by the player.'
    },
    refresh: 'Resolve the official public player catalog again before expiresAtUtc; sourceUrl is a temporary signed CDN URL.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web-player/data/singapore-2026-media.json');
  const metadata = await resolveSingaporeVideo();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify({ outputPath, title: metadata.title, dimensions: `${metadata.sourceWidth}x${metadata.sourceHeight}`, duration: metadata.sourceDurationSeconds, expiresAtUtc: metadata.expiresAtUtc }, null, 2));
}
