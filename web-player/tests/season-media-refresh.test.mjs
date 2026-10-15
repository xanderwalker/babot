import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogIdentity, eventFromTitle, extractVideoLinks, mergeCatalog } from '../scripts/refresh-season-media.mjs';

const japan = { id: '1860901063346183466', name: 'Kimi Antonelli’s 2026 Pirelli Pole Position Award lap at the Japanese Grand Prix', published_at: '2026-03-28T10:31:00Z', duration: 109013, description: 'Ride onboard with Kimi Antonelli as he claims pole with a lap of 1:29.362 in qualifying.' };
test('discovery distinguishes Catalunya, Madrid and Sprint qualifying', () => {
  assert.equal(eventFromTitle('ONBOARD: Russell’s 2026 Pirelli Pole Position Award lap at the Barcelona-Catalunya GP'), 'barcelona-catalunya');
  assert.equal(eventFromTitle('ONBOARD: Norris’ 2026 Pirelli Pole Position Award lap at the Spanish Grand Prix'), 'spain');
  assert.equal(eventFromTitle('ONBOARD: Sprint Pole Position Award lap at the Japanese Grand Prix'), null);
  assert.deepEqual(extractVideoLinks('<a href="/en/video/onboard-pole-position-award-lap.123">x</a><a href="/en/video/onboard-pole-position-award-lap.123">x</a>'), ['https://www.formula1.com/en/video/onboard-pole-position-award-lap.123']);
});
test('wrong season or circuit never reuses an alignment', () => {
  assert.throws(() => catalogIdentity(japan, 'china'), /event identity/);
  assert.throws(() => catalogIdentity({ ...japan, published_at: '2025-03-28T10:31:00Z' }, 'japan'), /season mismatch/);
});
test('source-description typo correction survives refresh; changed source invalidates verification', () => {
  const prior = { videoId: japan.id, driverName: 'Kimi Antonelli', lapDurationSeconds: 88.778, catalogLapDurationSeconds: 89.362, lapStartSeconds: 2, syncStatus: 'verified', syncEvidence: [{ observed: 'Broadcast and classification agree on 1:28.778.' }], offsetNote: 'Corrected official description typo.', estimatedUncertaintySeconds: .15 };
  const refreshed = mergeCatalog(prior, japan, 'https://www.formula1.com/en/video/japan.1860901063346183466', 'japan');
  assert.equal(refreshed.lapDurationSeconds, 88.778);
  assert.equal(refreshed.syncStatus, 'verified');
  assert.equal(refreshed.lapStartSeconds, 2);
  const changed = mergeCatalog(prior, { ...japan, id: '99999' }, 'https://www.formula1.com/en/video/japan.99999', 'japan');
  assert.equal(changed.syncStatus, 'unverified');
  assert.equal(changed.lapStartSeconds, null);
  assert.deepEqual(changed.syncEvidence, []);
});
test('every verified season video agrees with its telemetry fixture', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/data/season-2026-media.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../public/data/season-2026.json', import.meta.url), 'utf8'));
  for (const event of catalog.events) {
    const media = manifest.events[event.id];
    assert.ok(media, `${event.id}: missing media state`);
    if (media.syncStatus !== 'verified') continue;
    const fixture = JSON.parse(await readFile(new URL(`../public/data/2026/${event.id}.json`, import.meta.url), 'utf8'));
    assert.equal(media.driverName.toLowerCase(), fixture.meta.driverName.toLowerCase(), event.id);
    assert.equal(media.lapDurationSeconds, fixture.meta.lapDurationSeconds, event.id);
    assert.ok(Number.isFinite(media.lapStartSeconds) && media.lapStartSeconds >= 0, event.id);
    assert.ok(media.syncEvidence.length >= 3, event.id);
    assert.ok(media.sourceDurationSeconds > media.lapStartSeconds + media.lapDurationSeconds, event.id);
  }
});
