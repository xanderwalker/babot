import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureContract, frameChunks, validateProbe } from '../scripts/render-season-ribbons.mjs';

const fixture = JSON.parse(await readFile(new URL('../public/data/openf1-singapore-2026-verstappen-pole.json', import.meta.url), 'utf8'));

test('season render preserves Singapore production timing and requires verified measured data', () => {
  const contract = fixtureContract(fixture);
  assert.equal(contract.frameCount, 4569);
  assert.equal(contract.duration, 91.38);
  assert.equal(contract.samples, 16);
  assert.throws(() => fixtureContract({ ...fixture, meta: { ...fixture.meta, poleVerified: false } }), /verified/);
  assert.throws(() => fixtureContract({ ...fixture, carSamples: [fixture.carSamples[1], fixture.carSamples[0]] }), /unordered/);
  assert.throws(() => fixtureContract({ ...fixture, carSamples: [[-1, 1, 1, 1, 1, 1], ...fixture.carSamples] }), /Invalid/);
  assert.throws(() => fixtureContract({ ...fixture, carSamples: [...fixture.carSamples, [91374, 1, 1, 1, 1, 1]] }), /Invalid/);
});

test('resumable chunks cover every frame exactly once including an incomplete final chunk', () => {
  assert.deepEqual(frameChunks(1001, 500), [{ start: 1, end: 500 }, { start: 501, end: 1000 }, { start: 1001, end: 1001 }]);
  const chunks = frameChunks(4569);
  assert.equal(chunks.reduce((sum, r) => sum + r.end - r.start + 1, 0), 4569);
  assert.equal(chunks.at(-1).end, 4569);
  assert.throws(() => frameChunks(0));
  assert.throws(() => frameChunks(100, 0));
});

test('publication rejects truncated, retimed, or wrong-resolution films', () => {
  const contract = fixtureContract(fixture);
  const video = { codec_type: 'video', codec_name: 'h264', width: 810, height: 720, r_frame_rate: '50/1', nb_read_frames: '4569', duration: '91.380000' };
  assert.equal(validateProbe({ streams: [video] }, contract), video);
  for (const mismatch of [{ nb_read_frames: '4568' }, { duration: '91.36' }, { r_frame_rate: '25/1' }, { width: 1080 }, { codec_name: 'hevc' }]) {
    assert.throws(() => validateProbe({ streams: [{ ...video, ...mismatch }] }, contract), /contract mismatch/);
  }
});
