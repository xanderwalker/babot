/** Validate an event before it can replace the active replay and motion model. */
export function validateReplayFixture(fixture, event) {
  const meta = fixture?.meta;
  if (!meta || meta.season !== 2026 || !meta.poleVerified || meta.qualifyingPosition !== 1 || meta.sessionName !== 'Qualifying') throw new Error('This file is not a verified 2026 qualifying pole lap.');
  if (Number(meta.meetingKey) !== Number(event.meetingKey)) throw new Error('Replay identity does not match the selected Grand Prix.');
  if (!(meta.lapDurationSeconds > 0) || !Number.isFinite(meta.lapDurationSeconds)) throw new Error('Replay duration is invalid.');
  if (event.lapDurationSeconds && Math.abs(meta.lapDurationSeconds - event.lapDurationSeconds) > .002) throw new Error('Replay duration does not match its catalog entry.');
  if (!Array.isArray(meta.sectorDurationSeconds) || meta.sectorDurationSeconds.length !== 3 || meta.sectorDurationSeconds.some(value => !Number.isFinite(value) || value <= 0) || Math.abs(meta.sectorDurationSeconds.reduce((a,b) => a+b,0) - meta.lapDurationSeconds) > .01) throw new Error('Replay sector timing is incomplete.');
  for (const [key, width] of [['carSamples', 7], ['locationSamples', 4]]) {
    const rows = fixture[key];
    if (!Array.isArray(rows) || rows.length < 2) throw new Error('Replay telemetry is missing.');
    let previous = -1;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== width || row.some((value, i) => !(key === 'carSamples' && i === 6 && value === null) && !Number.isFinite(value)) || row[0] <= previous || row[0] < 0 || row[0] > meta.lapDurationSeconds * 1000 + 1) throw new Error('Replay contains invalid or unordered telemetry.');
      previous = row[0];
    }
  }
  return fixture;
}

/** An interrupted load must never replace a newer selection. */
export class ReplayLoader {
  constructor(fetcher = (url, options) => fetch(url, options)) { this.fetcher = fetcher; this.controller = null; this.generation = 0; }
  cancel() { this.generation++; this.controller?.abort(); }
  async load(event, url) {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    const response = await this.fetcher(url, { signal: controller.signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('Replay data could not be loaded. Try again.');
    const fixture = validateReplayFixture(await response.json(), event);
    if (generation !== this.generation || controller.signal.aborted) return null;
    return fixture;
  }
}

/** No replacement may proceed while the old physical motion is unconfirmed. */
export async function settleReplaySwitch(session) {
  if (!session) return;
  const needsOff = session.offRequired || ['arming', 'following', 'stopping'].includes(session.phase) || Boolean(session.runToken?.started);
  const result = await session.pause('Changing Grand Prix · motion stopped');
  if (needsOff && !result.offConfirmed) throw new Error('BaBot has not confirmed OFF. Reconnect before changing the replay.');
}
