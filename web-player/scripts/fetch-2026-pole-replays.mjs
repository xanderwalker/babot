#!/usr/bin/env node
/** Resumable 2026 pole-lap import. No synthetic telemetry or motion commands.
 * node scripts/fetch-2026-pole-replays.mjs [--event=singapore] [--refresh] [--as-of=ISO]
 * Completed fixtures are reused; each API response checkpoints to .openf1-pole-cache.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSingaporeBabotMotionSeries, createSingaporePlaybackMotionSampler } from '../src/motion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.openf1.org/v1';
export const CALENDAR_SOURCE = 'https://www.formula1.com/en/racing/2026';
// Current official calendar checked 2026-10-15: 23 rounds. April Bahrain and
// Saudi Arabia are cancelled; October Bahrain takes place in Kuala Lumpur.
export const CALENDAR = [
  [1279,'australia'],[1280,'china'],[1281,'japan'],[1284,'miami'],
  [1285,'canada'],[1286,'monaco'],[1287,'barcelona-catalunya'],[1288,'austria'],
  [1289,'great-britain'],[1290,'belgium'],[1291,'hungary'],[1292,'netherlands'],
  [1293,'italy'],[1294,'spain'],[1295,'azerbaijan'],[1308,'bahrain'],
  [1296,'singapore'],[1297,'united-states'],[1298,'mexico'],[1299,'brazil'],
  [1300,'las-vegas'],[1301,'qatar'],[1302,'abu-dhabi'],
];
const CAR_FIELDS = ['tMs','speedKph','rpm','throttlePct','brakeOn','gear','drs'];
const LOCATION_FIELDS = ['tMs','x','y','z'];
const invariant = (ok, message) => { if (!ok) throw new Error(message); };
const finite = (value, label) => {
  invariant(value !== null && value !== undefined && Number.isFinite(Number(value)), `${label} is missing or non-finite`);
  return Number(value);
};
const sameTime = (a,b) => Math.round(Number(a)*1000) === Math.round(Number(b)*1000);

export function selectPoleLap(results, laps, session) {
  invariant(session.session_name === 'Qualifying' && !session.is_cancelled, 'Not an active Grand Prix Qualifying session');
  const winners = results.filter(row => Number(row.position) === 1);
  invariant(winners.length === 1, 'Expected exactly one qualifying P1 classification');
  const result = winners[0];
  invariant(Number(result.session_key) === Number(session.session_key) && Number(result.meeting_key) === Number(session.meeting_key), 'Classification identity mismatch');
  invariant(!result.dsq && !result.dns, 'Pole classification is disqualified or did not start');
  invariant(Array.isArray(result.duration) && result.duration.length === 3, 'Expected Q1/Q2/Q3 classification durations');
  const q3 = finite(result.duration[2], 'Q3 duration');
  invariant(q3 > 0, 'Q3 duration must be positive');
  const candidates = laps.filter(lap => Number(lap.driver_number) === Number(result.driver_number)
    && Number(lap.session_key) === Number(session.session_key)
    && Number(lap.meeting_key) === Number(session.meeting_key)
    && !lap.is_pit_out_lap && lap.lap_duration != null && sameTime(lap.lap_duration, q3)
    && Number.isFinite(Date.parse(lap.date_start)));
  invariant(candidates.length > 0, 'No timed lap matches classified P1 Q3 duration');
  // If the same millisecond time occurs in an earlier segment, the final
  // matching lap is the Q3 candidate. Never substitute the fastest Q1/Q2 lap.
  const lap = candidates.sort((a,b) => Date.parse(b.date_start)-Date.parse(a.date_start))[0];
  const sectors = [lap.duration_sector_1,lap.duration_sector_2,lap.duration_sector_3].map((v,i)=>finite(v,`sector ${i+1}`));
  invariant(sectors.every(v=>v>0) && Math.abs(sectors.reduce((a,b)=>a+b,0)-q3) <= .002, 'Sector sum does not match classified pole lap');
  return { result, lap, durationSeconds:q3 };
}

export function inspectSamples(samples, width, durationMs, label) {
  invariant(Array.isArray(samples) && samples.length >= 20, `${label} has too few source samples`);
  const gaps = [];
  for (let i=0;i<samples.length;i++) {
    const row=samples[i];
    invariant(Array.isArray(row) && row.length===width && row.every((v,j)=>Number.isFinite(v)||(label==='car'&&j===6&&v===null)), `${label} malformed tuple`);
    invariant(Number.isInteger(row[0]) && row[0]>=0 && row[0]<=durationMs, `${label} timestamp outside lap`);
    if(i) {
      const span=row[0]-samples[i-1][0];
      invariant(span>0, `${label} timestamps must strictly increase`);
      if(span>500) gaps.push({startMs:samples[i-1][0],endMs:row[0],durationMs:span});
    }
  }
  return {sampleCount:samples.length,leadingGapMs:samples[0][0],trailingGapMs:durationMs-samples.at(-1)[0],maximumGapMs:Math.max(0,...gaps.map(g=>g.durationMs)),gapsOver500Ms:gaps};
}

export function validateFixture(fixture, session) {
  const meta=fixture?.meta;
  invariant(meta?.season===2026 && meta.poleVerified===true && meta.qualifyingPosition===1, 'Fixture is not verified 2026 pole data');
  invariant(meta.sessionName==='Qualifying' && Number.isInteger(meta.lapNumber) && meta.lapNumber>0 && Number.isInteger(meta.driverNumber) && meta.driverNumber>0, 'Fixture session/driver/lap identity is invalid');
  if(session) invariant(meta.sessionKey===Number(session.session_key)&&meta.meetingKey===Number(session.meeting_key), 'Cached fixture identity mismatch');
  invariant(Number.isFinite(meta.lapDurationMs) && meta.lapDurationMs>0 && sameTime(meta.lapDurationSeconds,meta.lapDurationMs/1000), 'Fixture lap duration is invalid');
  invariant(Date.parse(meta.lapEndUtc)-Date.parse(meta.lapStartUtc)===meta.lapDurationMs, 'Fixture timestamp window does not match lap duration');
  invariant(JSON.stringify(fixture.fields?.carSamples)===JSON.stringify(CAR_FIELDS) && JSON.stringify(fixture.fields?.locationSamples)===JSON.stringify(LOCATION_FIELDS), 'Fixture sample field order is invalid');
  const source = {
    car:inspectSamples(fixture.carSamples,7,meta.lapDurationMs,'car'),
    location:inspectSamples(fixture.locationSamples,4,meta.lapDurationMs,'location'),
  };
  return source;
}

export function summarizeMotion(fixture) {
  const model=buildSingaporeBabotMotionSeries(fixture);
  const at=createSingaporePlaybackMotionSampler(model,{durationSeconds:fixture.meta.lapDurationSeconds});
  let unavailable=0,reconstructed=0,total=0;
  for(let i=0;i<=Math.ceil(fixture.meta.lapDurationSeconds*50);i++) {
    const sample=at(Math.min(i/50,fixture.meta.lapDurationSeconds)); total++;
    if(!sample.valid) unavailable++;
    if(sample.playbackMode==='reconstructed-gap') reconstructed++;
  }
  return {sampleRateHz:50,checkedSamples:total,unavailableSamples:unavailable,reconstructedSamples:reconstructed,
    unavailableSeconds:Number((unavailable/50).toFixed(2)),completeMotionCoverage:unavailable===0,
    note:unavailable ? 'Unsupported telemetry intervals remain invalid and stop hardware motion.' : 'All replay samples have bounded motion cues; cues remain derived, not measured acceleration.'};
}

export function buildCatalog(meetings,sessions,asOf) {
  const milliseconds=Date.parse(asOf);
  invariant(Number.isFinite(milliseconds),'Invalid as-of date');
  return {schemaVersion:1,season:2026,updatedAtUtc:new Date().toISOString(),asOfUtc:new Date(milliseconds).toISOString(),
    sources:{calendar:CALENDAR_SOURCE,calendarCheckedAt:'2026-10-15',meetings:`${API}/meetings?year=2026`,sessions:`${API}/sessions?year=2026&session_name=Qualifying`},
    availabilityNote:'Available means verified pole telemetry. Official video availability and alignment are recorded separately.',
    excludedMeetings:meetings.filter(m=>m.is_cancelled).map(m=>({meetingKey:m.meeting_key,name:m.meeting_name,reason:'Cancelled in OpenF1; excluded from current official calendar.'})),
    events:CALENDAR.map(([key,id],index)=>{
      const meeting=meetings.find(m=>Number(m.meeting_key)===key);
      invariant(meeting && /grand prix/i.test(meeting.meeting_name),'Official calendar meeting missing from OpenF1: '+id);
      const session=sessions.find(s=>Number(s.meeting_key)===key && s.session_name==='Qualifying' && !s.is_cancelled);
      const upcoming=session ? Date.parse(session.date_end)>milliseconds : Date.parse(meeting.date_start)>milliseconds;
      return {id,round:index+1,meetingKey:key,name:meeting.meeting_name,circuit:meeting.circuit_short_name,country:meeting.country_name,
        date:meetingLocalDate(meeting),qualifyingDate:session?.date_start,status:upcoming?'upcoming':'unavailable',fixtureUrl:`./data/2026/${id}.json`,driverName:'',lapDurationSeconds:null,
        reason:upcoming?'Qualifying has not taken place.':'Pole telemetry has not been imported.'};
    })};
}

export function meetingLocalDate(meeting) {
  const match=String(meeting.gmt_offset||'+00:00').match(/^([+-]?)(\d{2}):(\d{2})/);
  invariant(match,'Invalid meeting GMT offset');
  const offset=(Number(match[2])*60+Number(match[3]))*(match[1]==='-'?-1:1);
  return new Date(Date.parse(meeting.date_end)+offset*60000).toISOString().slice(0,10);
}

async function readJson(file) { try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;} }
async function saveJson(file,data) {await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(data)+'\n');await rename(temp,file);}
function apiUrl(endpoint,params) {const url=new URL(`${API}/${endpoint}`);for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));return url.toString();}

export async function run(args=process.argv.slice(2)) {
  const options=Object.fromEntries(args.map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return[key,value.length?value.join('='):true];}));
  const asOf=options['as-of']||new Date().toISOString();
  const cacheDir=path.join(ROOT,'.openf1-pole-cache');
  const outputDir=path.join(ROOT,'public/data/2026');
  const catalogPath=path.join(ROOT,'public/data/season-2026.json');
  let lastRequest=0;
  async function request(url,{fresh=false}={}) {
    const cache=path.join(cacheDir,createHash('sha256').update(url).digest('hex')+'.json');
    const previous=options.refresh||fresh?null:await readJson(cache);
    if(previous?.url===url && Array.isArray(previous.data))return previous.data;
    for(let attempt=0;attempt<5;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,2150-(Date.now()-lastRequest))));
      lastRequest=Date.now();
      try {
        const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{accept:'application/json','user-agent':'babot-pole-season-importer/1.0'}});
        if(response.status===429 || response.status>=500) {
          const retry=response.headers.get('retry-after');
          const seconds=Number(retry);const delay=retry?(Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()):0;
          await new Promise(resolve=>setTimeout(resolve,Math.min(60000,Math.max(4000*2**attempt,delay||0))));
          continue;
        }
        invariant(response.ok,`OpenF1 HTTP ${response.status} for ${new URL(url).pathname}`);
        const data=await response.json(); invariant(Array.isArray(data),'OpenF1 response is not an array');
        // Empty data is deliberately not cached, so future refresh can recover.
        if(data.length)await saveJson(cache,{url,fetchedAtUtc:new Date().toISOString(),data});
        return data;
      } catch(error) {if(attempt===4)throw error;await new Promise(resolve=>setTimeout(resolve,2000*2**attempt));}
    }
    throw new Error('OpenF1 retry limit reached: '+new URL(url).pathname);
  }
  const meetings=await request(apiUrl('meetings',{year:2026}),{fresh:true});
  const sessions=await request(apiUrl('sessions',{year:2026,session_name:'Qualifying'}),{fresh:true});
  const catalog=buildCatalog(meetings,sessions,asOf);
  // Restore valid completed files before the first write; interrupted or
  // single-event imports never erase the season's already verified coverage.
  for(const event of catalog.events.filter(e=>e.status!=='upcoming')) {
    const session=sessions.find(s=>Number(s.meeting_key)===event.meetingKey&&!s.is_cancelled);
    const cached=await readJson(path.join(outputDir,event.id+'.json'));
    if(cached)try {validateFixture(cached,session);Object.assign(event,{status:'available',driverName:cached.meta.driverName,lapDurationSeconds:cached.meta.lapDurationSeconds,sessionKey:cached.meta.sessionKey,driverNumber:cached.meta.driverNumber,lapNumber:cached.meta.lapNumber,motionCoverage:cached.quality?.motion});delete event.reason;}catch{}
  }
  const selected=catalog.events.filter(e=>e.status!=='upcoming'&&(!options.event||e.id===options.event||String(e.meetingKey)===options.event));
  invariant(!options.event||selected.length,'No completed event matched --event');
  await saveJson(catalogPath,catalog);
  for(const event of selected) {
    if(event.status==='available'&&!options.refresh){console.log(`[cached] ${event.id}`);continue;}
    try {
      const session=sessions.find(s=>Number(s.meeting_key)===event.meetingKey&&s.session_name==='Qualifying'&&!s.is_cancelled);
      invariant(session,'Qualifying session is unavailable');
      const meeting=meetings.find(m=>Number(m.meeting_key)===event.meetingKey);
      let fixture=event.id==='singapore'&&!options.refresh ? await readJson(path.join(ROOT,'data/openf1-singapore-2026-verstappen-pole.json')):null;
      if(!fixture) {
        const resultsUrl=apiUrl('session_result',{session_key:session.session_key,position:1});
        const results=await request(resultsUrl);
        const pole=results.find(r=>Number(r.position)===1); invariant(pole,'P1 classification unavailable');
        const lapUrl=apiUrl('laps',{session_key:session.session_key,driver_number:pole.driver_number});
        const selection=selectPoleLap(results,await request(lapUrl),session);
        const {lap,durationSeconds}=selection;
        const driverUrl=apiUrl('drivers',{session_key:session.session_key,driver_number:pole.driver_number});
        const drivers=await request(driverUrl);const driver=drivers.find(d=>Number(d.driver_number)===Number(pole.driver_number)&&Number(d.session_key)===Number(session.session_key));
        invariant(driver,'Driver identity unavailable');
        const start=Date.parse(lap.date_start),durationMs=Math.round(durationSeconds*1000),end=start+durationMs;
        const query={session_key:session.session_key,driver_number:pole.driver_number,'date>':new Date(start).toISOString(),'date<':new Date(end).toISOString()};
        const carUrl=apiUrl('car_data',query),locationUrl=apiUrl('location',query);
        const inside=(rows,label)=>rows.filter(r=>Date.parse(r.date)>=start&&Date.parse(r.date)<=end).map(r=>{
          invariant(Number(r.session_key)===Number(session.session_key)&&Number(r.driver_number)===Number(pole.driver_number),label+' row identity mismatch');return r;
        }).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
        const cars=inside(await request(carUrl),'car'),locations=inside(await request(locationUrl),'location');
        fixture={meta:{datasetId:`openf1-${event.id}-2026-pole`,season:2026,meetingKey:event.meetingKey,meetingName:meeting.meeting_name,meetingOfficialName:meeting.meeting_official_name,
          location:meeting.location,country:meeting.country_name,circuit:meeting.circuit_short_name,sessionKey:Number(session.session_key),sessionName:'Qualifying',driverNumber:Number(pole.driver_number),driverName:driver.full_name,driverAcronym:driver.name_acronym,team:driver.team_name,teamColour:driver.team_colour,
          lapNumber:Number(lap.lap_number),sectorDurationSeconds:[lap.duration_sector_1,lap.duration_sector_2,lap.duration_sector_3],qualifyingPosition:1,poleVerified:true,lapStartUtc:new Date(start).toISOString(),lapEndUtc:new Date(end).toISOString(),lapDurationMs:durationMs,lapDurationSeconds:durationSeconds},
          provenance:{source:'OpenF1 API',generatedAtUtc:new Date().toISOString(),sourceUrls:{docs:'https://openf1.org/docs/',officialCalendar:CALENDAR_SOURCE,meeting:apiUrl('meetings',{meeting_key:event.meetingKey}),session:apiUrl('sessions',{session_key:session.session_key}),sessionResult:resultsUrl,lap:lapUrl,driver:driverUrl,carData:carUrl,location:locationUrl},
            selection:'Classified P1; latest non-pit lap matching the exact Q3 duration in milliseconds, with all three sectors verified.',window:{startUtc:new Date(start).toISOString(),endUtc:new Date(end).toISOString(),startInclusive:true,endInclusive:true},timestampBasis:'Raw OpenF1 sample date minus lapStartUtc in integer milliseconds',sourceCadence:'irregular',resampled:false,interpolated:false,syntheticEndpoints:false,derivedG:false},
          fields:{carSamples:CAR_FIELDS,locationSamples:LOCATION_FIELDS},
          carSamples:cars.map(r=>[Date.parse(r.date)-start,finite(r.speed,'speed'),finite(r.rpm,'rpm'),finite(r.throttle,'throttle'),finite(r.brake,'brake')>0?1:0,finite(r.n_gear,'gear'),r.drs==null?null:finite(r.drs,'drs')]),
          locationSamples:locations.map(r=>[Date.parse(r.date)-start,finite(r.x,'x'),finite(r.y,'y'),finite(r.z,'z')])};
      }
      const source=validateFixture(fixture,session);
      Object.assign(fixture.meta,{carSampleCount:fixture.carSamples.length,locationSampleCount:fixture.locationSamples.length,carFirstTMs:fixture.carSamples[0][0],carLastTMs:fixture.carSamples.at(-1)[0],locationFirstTMs:fixture.locationSamples[0][0],locationLastTMs:fixture.locationSamples.at(-1)[0]});
      fixture.quality={source,motion:summarizeMotion(fixture)};
      await saveJson(path.join(outputDir,event.id+'.json'),fixture);
      Object.assign(event,{status:'available',driverName:fixture.meta.driverName,lapDurationSeconds:fixture.meta.lapDurationSeconds,sessionKey:fixture.meta.sessionKey,driverNumber:fixture.meta.driverNumber,lapNumber:fixture.meta.lapNumber,motionCoverage:fixture.quality.motion});delete event.reason;
      console.log(`[available] ${event.id}: ${event.driverName}, ${event.lapDurationSeconds}s; ${fixture.carSamples.length}/${fixture.locationSamples.length} raw samples; motion gaps ${fixture.quality.motion.unavailableSeconds}s`);
    } catch(error) {
      if(event.status!=='available'){event.status='unavailable';event.reason=error.message;}
      else event.refreshError=error.message;
      console.error(`[unavailable] ${event.id}: ${error.message}`);
    }
    catalog.updatedAtUtc=new Date().toISOString();await saveJson(catalogPath,catalog);
  }
  const counts=Object.fromEntries(['available','upcoming','unavailable'].map(status=>[status,catalog.events.filter(e=>e.status===status).length]));
  console.log('[coverage] '+JSON.stringify(counts));return catalog;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await run();
