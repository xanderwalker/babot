import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ReplayLoader, validateReplayFixture, settleReplaySwitch } from '../src/replay-library.mjs';
const fixture=JSON.parse(await readFile(new URL('../data/openf1-singapore-2026-verstappen-pole.json',import.meta.url)));
const event={meetingKey:1296,lapDurationSeconds:91.373};
test('rejects another race, non-pole classification, and malformed telemetry before replacement',()=>{
  assert.equal(validateReplayFixture(fixture,event),fixture);
  assert.throws(()=>validateReplayFixture(fixture,{...event,meetingKey:1234}),/identity/);
  const damaged=structuredClone(fixture);damaged.meta.qualifyingPosition=2;
  assert.throws(()=>validateReplayFixture(damaged,event),/pole/);
  damaged.meta.qualifyingPosition=1;damaged.carSamples[4][0]=damaged.carSamples[3][0];
  assert.throws(()=>validateReplayFixture(damaged,event),/unordered/);
});
test('a slow earlier fetch cannot replace a newer replay even if fetch ignores abort',async()=>{
  const pending=[];
  const loader=new ReplayLoader(()=>new Promise(resolve=>pending.push(resolve)));
  const first=loader.load(event,'first');const second=loader.load(event,'second');
  const response=()=>new Response(JSON.stringify(fixture),{headers:{'content-type':'application/json'}});
  pending[1](response());assert.equal((await second).meta.meetingKey,1296);
  pending[0](response());assert.equal(await first,null);
});
test('switch waits for physical OFF and rejects unconfirmed stop',async()=>{
  let resolveStop;const session={phase:'following',offRequired:true,pause:()=>new Promise(resolve=>{resolveStop=resolve;})};
  let completed=false;const stopping=settleReplaySwitch(session).then(()=>{completed=true;});
  await Promise.resolve();assert.equal(completed,false);
  resolveStop({offConfirmed:true});await stopping;assert.equal(completed,true);
  await assert.rejects(settleReplaySwitch({...session,pause:async()=>({offConfirmed:false})}),/confirmed OFF/);
  await settleReplaySwitch({phase:'ready',offRequired:false,pause:async()=>({offConfirmed:false})});
});
