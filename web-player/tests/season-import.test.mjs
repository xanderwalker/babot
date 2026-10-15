import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectPoleLap,inspectSamples,validateFixture,buildCatalog,meetingLocalDate,CALENDAR } from '../scripts/fetch-2026-pole-replays.mjs';

const session={session_key:4,meeting_key:9,session_name:'Qualifying',is_cancelled:false};
const result={session_key:4,meeting_key:9,driver_number:63,position:1,duration:[80,78,79]};
const lap=(duration,start='2026-03-07T06:10:00Z')=>({session_key:4,meeting_key:9,driver_number:63,lap_number:20,date_start:start,lap_duration:duration,duration_sector_1:25,duration_sector_2:24,duration_sector_3:duration-49,is_pit_out_lap:false});
test('selects exact classified Q3, not faster Q2, and the final occurrence of an equal time',()=>{
  const selected=selectPoleLap([result],[lap(78),lap(79,'2026-03-07T05:10:00Z'),lap(79)],session);
  assert.equal(selected.durationSeconds,79);assert.equal(selected.lap.date_start,'2026-03-07T06:10:00Z');
});
test('rejects missing Q3, wrong identities, disqualification, sprint, and missing exact lap',()=>{
  for(const bad of [{...result,duration:[80,78,null]},{...result,session_key:99},{...result,dsq:true}])assert.throws(()=>selectPoleLap([bad],[lap(79)],session));
  assert.throws(()=>selectPoleLap([result],[lap(79)],{...session,session_name:'Sprint Qualifying'}));
  assert.throws(()=>selectPoleLap([result],[lap(78)],session),/No timed lap/);
  assert.throws(()=>selectPoleLap([result],[{...lap(79),duration_sector_3:1}],session),/Sector sum/);
});
test('raw telemetry validation discloses gaps without fabricating endpoints',()=>{
  const rows=Array.from({length:20},(_,i)=>[120+i*300+(i>8?1000:0),1,2,3]);
  const before=JSON.stringify(rows);const quality=inspectSamples(rows,4,8000,'location');
  assert.equal(quality.leadingGapMs,120);assert.equal(quality.maximumGapMs,1300);assert.equal(quality.gapsOver500Ms.length,1);assert.equal(JSON.stringify(rows),before);
  assert.throws(()=>inspectSamples([...rows.slice(0,19),rows[18]],4,8000,'location'),/strictly increase/);
  assert.throws(()=>inspectSamples(rows,4,5000,'location'),/outside lap/);
  const bad=structuredClone(rows);bad[3][1]=NaN;assert.throws(()=>inspectSamples(bad,4,8000,'location'),/malformed/);
});
test('current calendar excludes cancelled/testing and marks future qualifying upcoming',()=>{
  const meetings=CALENDAR.map(([meeting_key,id])=>({meeting_key,meeting_name:id+' Grand Prix',circuit_short_name:id,country_name:id,date_start:'2026-03-06T00:00:00Z',date_end:'2026-03-08T00:00:00Z'}));
  meetings.push({meeting_key:1283,meeting_name:'Saudi Arabian Grand Prix',is_cancelled:true});
  const sessions=CALENDAR.map(([meeting_key],i)=>({meeting_key,session_name:'Qualifying',date_start:i>16?'2026-11-01T10:00:00Z':'2026-03-07T10:00:00Z',date_end:i>16?'2026-11-01T11:00:00Z':'2026-03-07T11:00:00Z'}));
  const catalog=buildCatalog(meetings,sessions,'2026-10-15T00:00:00Z');
  assert.equal(catalog.events.length,23);assert.equal(catalog.events.filter(e=>e.status==='upcoming').length,6);assert.equal(catalog.events[16].id,'singapore');assert.equal(catalog.events[15].meetingKey,1308);assert.equal(catalog.excludedMeetings.length,1);
});
test('calendar displays Las Vegas race day locally, not the next UTC day',()=>{
  assert.equal(meetingLocalDate({date_end:'2026-11-22T06:00:00Z',gmt_offset:'-08:00:00'}),'2026-11-21');
});
test('every available catalog event loads its own verified raw pole fixture',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../public/data/season-2026.json',import.meta.url),'utf8'));
  assert.equal(new Set(catalog.events.map(e=>e.id)).size,catalog.events.length);
  for(const event of catalog.events.filter(e=>e.status==='available')) {
    const fixture=JSON.parse(await readFile(new URL(`../public/data/2026/${event.id}.json`,import.meta.url),'utf8'));
    validateFixture(fixture,{session_key:event.sessionKey,meeting_key:event.meetingKey});
    assert.equal(event.driverName,fixture.meta.driverName);assert.equal(event.lapDurationSeconds,fixture.meta.lapDurationSeconds);
    assert.equal(fixture.provenance.interpolated,false);assert.equal(fixture.provenance.syntheticEndpoints,false);
    assert.equal(fixture.quality.source.car.sampleCount,fixture.carSamples.length);
    assert.equal(event.motionCoverage.unavailableSamples,fixture.quality.motion.unavailableSamples);
  }
  assert.ok(catalog.events.some(e=>e.status==='available'));
  for(const event of catalog.events.filter(e=>e.status!=='available')) {
    assert.ok(event.reason);assert.equal(event.driverName,'');assert.equal(event.lapDurationSeconds,null);
  }
});
