#!/usr/bin/env node
/** Public F1 page/catalog discovery only. No account credentials, DRM, or video redistribution. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAYER_URL = 'https://players.brightcove.net/6057949432001/FC1Xxg8gIw_default/index.min.js';
export const CATALOG_BASE = 'https://edge.api.brightcove.com/playback/v1/accounts/6057949432001/videos/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVENT_ALIASES = {
  australia: ['australian'], china: ['chinese'], japan: ['japanese'], miami: ['miami'],
  canada: ['canadian'], monaco: ['monaco'], 'barcelona-catalunya': ['barcelona-catalunya'],
  austria: ['austrian'], 'great-britain': ['british'], belgium: ['belgian'], hungary: ['hungarian'],
  netherlands: ['dutch'], italy: ['italian'], spain: ['spanish'], azerbaijan: ['azerbaijan'],
  bahrain: ['bahrain'], singapore: ['singapore'], 'united-states': ['united-states'],
  mexico: ['mexico-city','mexican'], brazil: ['sao-paulo','brazilian'], 'las-vegas': ['las-vegas'],
  qatar: ['qatar'], 'abu-dhabi': ['abu-dhabi'],
};
const normal = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
export function eventFromTitle(title) {
  const normalized = normal(title);
  if (!normalized.includes('pole-position-award-lap') || normalized.includes('sprint')) return null;
  return Object.entries(EVENT_ALIASES).find(([, aliases]) => aliases.some(alias => normalized.includes(`${alias}-grand-prix`) || normalized.endsWith(`${alias}-gp`)))?.[0] || null;
}
export function extractVideoLinks(html) {
  return [...new Set([...html.matchAll(/href="(\/en\/video\/[^"?#]+\.\d+)"/g)]
    .map(match => `https://www.formula1.com${match[1].replaceAll('&amp;', '&')}`)
    .filter(url => url.toLowerCase().includes('pole-position-award-lap')))];
}
export function catalogIdentity(catalog, eventId, season = 2026) {
  if (!catalog.id || eventFromTitle(catalog.name) !== eventId) throw new Error('Official video event identity mismatch');
  if (Number(catalog.published_at?.slice(0, 4)) !== season) throw new Error('Official video season mismatch');
  const description = `${catalog.description || ''} ${catalog.long_description || ''}`;
  const driverName = description.match(/Ride onboard with\s+([\p{L} .’'-]+?)\s+as\b/u)?.[1]
    || ['George Russell', 'Kimi Antonelli', 'Lando Norris', 'Pierre Gasly', 'Max Verstappen', 'Oscar Piastri', 'Lewis Hamilton', 'Charles Leclerc']
    .find(name => description.includes(name) || catalog.name.includes(name)) || null;
  const match = description.match(/lap of\s+(\d+):(\d{2}\.\d{3})/i);
  const lapDurationSeconds = match ? Number(match[1]) * 60 + Number(match[2]) : null;
  return { driverName, lapDurationSeconds };
}
export function mergeCatalog(previous, catalog, officialPageUrl, eventId, season = 2026) {
  const identity = catalogIdentity(catalog, eventId, season);
  // A changed driver, duration, or video invalidates the old frame alignment.
  const sameLap = previous?.videoId === String(catalog.id)
    && (!identity.driverName || previous.driverName === identity.driverName)
    && (!identity.lapDurationSeconds || Math.abs((previous.catalogLapDurationSeconds ?? previous.lapDurationSeconds) - identity.lapDurationSeconds) < 0.001);
  return {
    videoId: String(catalog.id), officialPageUrl, title: catalog.name,
    driverName: identity.driverName || (sameLap ? previous.driverName : null),
    lapDurationSeconds: sameLap ? previous.lapDurationSeconds : identity.lapDurationSeconds,
    catalogLapDurationSeconds: identity.lapDurationSeconds,
    lapStartSeconds: sameLap ? previous.lapStartSeconds : null,
    syncStatus: sameLap ? previous.syncStatus : 'unverified',
    syncEvidence: sameLap ? previous.syncEvidence : [],
    offsetNote: sameLap ? previous.offsetNote : 'Official pole lap located; broadcast-clock alignment still needs verification.',
    ...(sameLap && previous.estimatedUncertaintySeconds != null ? { estimatedUncertaintySeconds: previous.estimatedUncertaintySeconds } : {}),
    sourceDurationSeconds: catalog.duration / 1000,
    publishedAtUtc: catalog.published_at,
  };
}
async function fetchChecked(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
  return response;
}
export async function publicPolicy() {
  const source = await (await fetchChecked(PLAYER_URL)).text();
  const key = source.match(/videoCloud:\{policyKey:"([^"]+)"/)?.[1];
  if (!key) throw new Error('Official public player policy unavailable');
  return key;
}
export async function publicCatalog(videoId, policy) {
  if (!/^\d+$/.test(String(videoId))) throw new Error('Invalid video id');
  return (await fetchChecked(CATALOG_BASE + videoId, { headers: { Accept: `application/json;pk=${policy}` } })).json();
}
export async function refreshSeasonMedia({ output = path.join(ROOT, 'public/data/season-2026-media.json'), pages = 4, season = 2026 } = {}) {
  const previous = JSON.parse(await readFile(output, 'utf8').catch(() => '{"events":{}}'));
  const policy = await publicPolicy();
  const links = new Set(Object.values(previous.events).map(event => event.officialPageUrl).filter(Boolean));
  const warnings = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const url = `https://www.formula1.com/en/video?page=${page}&videoFilters=Feature`;
      const html = await (await fetchChecked(url)).text();
      extractVideoLinks(html).forEach(link => links.add(link));
    } catch (error) { warnings.push(`Discovery page ${page}: ${error.message}`); }
  }
  const events = { ...previous.events };
  let refreshed = 0;
  for (const url of links) {
    const guessedEvent = eventFromTitle(url.split('/').at(-1).replace(/\.\d+$/, ''));
    if (!guessedEvent) continue;
    const explicitYear = url.match(/-(20\d{2})-/)?.[1];
    if (explicitYear && Number(explicitYear) !== season) continue;
    try {
      const catalog = await publicCatalog(url.split('.').at(-1), policy);
      if (Number(catalog.published_at?.slice(0, 4)) !== season) continue;
      const eventId = eventFromTitle(catalog.name);
      if (!eventId) continue;
      // Do not replace a newer entry with an older duplicate discovered later.
      if (events[eventId]?.publishedAtUtc > catalog.published_at) continue;
      events[eventId] = mergeCatalog(events[eventId], catalog, url, eventId, season);
      refreshed++;
    } catch (error) { warnings.push(`${guessedEvent}: ${error.message}`); }
  }
  if (!refreshed) throw new Error('No official catalog entries refreshed; existing manifest preserved');
  for (const eventId of Object.keys(EVENT_ALIASES)) {
    events[eventId] ||= { videoId: null, officialPageUrl: null, title: null, driverName: null, lapStartSeconds: null, syncStatus: 'unavailable', syncEvidence: [], offsetNote: `Awaiting ${season} qualifying and the official pole-lap onboard.` };
  }
  const result = { schemaVersion: 1, season, updatedAtUtc: new Date().toISOString(), events };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return { output, refreshed, verified: Object.values(events).filter(event => event.syncStatus === 'verified').length, warnings };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pagesArg = process.argv.find(arg => arg.startsWith('--pages='));
  const pages = pagesArg ? Number(pagesArg.split('=')[1]) : 4;
  if (!Number.isInteger(pages) || pages < 0 || pages > 100) throw new Error('--pages must be between 0 and 100');
  console.log(JSON.stringify(await refreshSeasonMedia({ pages }), null, 2));
}
