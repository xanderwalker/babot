import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import fixture from '../data/openf1-singapore-2026-verstappen-pole.json';
import { buildSingaporeBabotMotionSeries, singaporeMotionAt } from './motion.mjs';
import { carPoseToFirmwarePose, commandedPoseDegrees, isApprovedControllerOrigin } from './protocol.mjs';
import { BabotSerial } from './babot-serial';
import { ConceptChassis, ChassisGallery } from './ConceptChassis';
import { BlenderRibbon } from './BlenderRibbon';
import { loadOfficialMedia } from './media-source';
import { channelsAt, canSendMotion, clamp, distanceAt, distanceSeries, lapTime, videoTime, windowFits } from './player-clock.mjs';

const model = buildSingaporeBabotMotionSeries(fixture);
const carSamples: number[][] = fixture.carSamples.map(row => row.map(value => value ?? 0));
const distance = distanceSeries(carSamples);
const lap = fixture.meta;
const duration = lap.lapDurationSeconds;
const clock = (seconds:number) => `${Math.floor(Math.max(0,seconds)/60)}:${(Math.max(0,seconds)%60).toFixed(3).padStart(6,'0')}`;
type Media = { url: string; poster?: string; lapStartSeconds?: number; title?: string; sourceUrl?: string; offsetNote?: string };
const officialVideo = 'https://www.formula1.com/en/video/onboard-max-verstappens-2026-pirelli-pole-position-award-lap-at-the-singapore-grand-prix.1878677458343183007';
const trackBounds = fixture.locationSamples.reduce((a,r)=>[Math.min(a[0],r[1]),Math.max(a[1],r[1]),Math.min(a[2],r[2]),Math.max(a[3],r[2])],[Infinity,-Infinity,Infinity,-Infinity]);
const project = (x:number,y:number) => [12+((x-trackBounds[0])/(trackBounds[1]-trackBounds[0]))*176, 106-((y-trackBounds[2])/(trackBounds[3]-trackBounds[2]))*94];
const trackPath = fixture.locationSamples.filter((_,i)=>i%2===0).map((r,i)=>`${i?'L':'M'}${project(r[1],r[2]).join(',')}`).join(' ');

function PlayIcon({playing=false}:{playing?:boolean}) { return <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">{playing?<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>:<path d="M7 3l15 9-15 9z"/>}</svg>; }
function Metric({label,value,unit,tone=''}:{label:string,value:string,unit?:string,tone?:string}) { return <div className={`metric ${tone}`}><span>{label}</span><div>{value}<small>{unit}</small></div></div>; }

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const serial = useRef<BabotSerial|null>(null);
  const autoConnect = useRef(true);
  const frame = useRef({time:0, stampedAt:0});
  const latest = useRef<any>({});
  const userSelectedSource = useRef(false);
  const [media,setMedia]=useState<Media|null>(null);
  const [source,setSource]=useState('');
  const [sourceLabel,setSourceLabel]=useState('Official F1 onboard');
  const [offset,setOffset]=useState(0);
  const [videoDuration,setVideoDuration]=useState(0);
  const [ready,setReady]=useState(false);
  const [videoMode,setVideoMode]=useState(true);
  const [playing,setPlaying]=useState(false);
  const [time,setTime]=useState(0);
  const [rate,setRate]=useState(1);
  const [muted,setMuted]=useState(false);
  const [error,setError]=useState('');
  const [connected,setConnected]=useState(false);
  const [active,setActive]=useState(false);
  const [starting,setStarting]=useState(false);
  const [status,setStatus]=useState('Connect via USB to enable motion.');
  const [confirmed,setConfirmed]=useState(false);
  const [rollGain,setRollGain]=useState(1);
  const [pitchGain,setPitchGain]=useState(.75);
  const [syncOpen,setSyncOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [conceptId,setConceptId]=useState('tron-f1');
  const [conceptsOpen,setConceptsOpen]=useState(false);
  const [flexDemo,setFlexDemo]=useState(false);
  const [flexPhase,setFlexPhase]=useState(0);
  const motionSample = singaporeMotionAt(model,time);
  const telemetry = channelsAt(carSamples,time);
  const locationSample = channelsAt(fixture.locationSamples,time);
  const sample = {...motionSample,speedKph:telemetry[1],rpm:telemetry[2],throttlePct:telemetry[3],brakeOn:telemetry[4],gear:telemetry[5],x:locationSample[1],y:locationSample[2]};
  const pose = commandedPoseDegrees(sample,{roll:rollGain,pitch:pitchGain});
  const fits = windowFits(videoDuration,offset,duration);
  const canConnectHere = isApprovedControllerOrigin({isSecureContext:window.isSecureContext,isTopLevel:window.top===window.self});
  const hasSerial = 'serial' in navigator && canConnectHere;
  const usbHint = !canConnectHere ? 'Open directly in an HTTPS browser tab' : !('serial' in navigator) ? 'Use desktop Chrome or Edge for USB' : 'USB · 115200 baud · 50 Hz';
  latest.current={time,offset,videoMode,playing,ready,confirmed,rollGain,pitchGain,fits,flexDemo};

  const stopMotion=useCallback((message='Motion stopped')=>{ setStarting(false); void serial.current?.stop(message); },[]);
  const pause=useCallback(()=>{ video.current?.pause(); setPlaying(false);setFlexDemo(false); stopMotion('Playback paused · motion stopped'); },[stopMotion]);

  useEffect(()=>{
    let disposed=false;
    const controller = new BabotSerial((message,isConnected,isActive,detail)=>{if(disposed)return;setStatus(message);setConnected(isConnected);setActive(isActive);setStarting(detail?.phase === 'arming');setBusy(detail?.phase === 'connecting');});
    serial.current=controller;
    const usb=(navigator as Navigator & {serial?:Pick<EventTarget,'addEventListener'|'removeEventListener'>}).serial;
    const restore=()=>{
      if(disposed||!hasSerial||!autoConnect.current)return;
      void controller.reconnect().catch(e=>{if(!disposed){setBusy(false);setStatus(e instanceof Error?e.message:'USB reconnection failed');}});
    };
    usb?.addEventListener('connect',restore);
    restore();
    return ()=>{disposed=true;usb?.removeEventListener('connect',restore);if(serial.current===controller)serial.current=null;void controller.disconnect();};
  },[hasSerial]);
  useEffect(()=>{
    let cancelled=false;
    loadOfficialMedia().then((data:Media)=>{
      if(cancelled||userSelectedSource.current)return;setMedia(data);setSource(data.url);setOffset(data.lapStartSeconds??0);
    }).catch(e=>{if(!cancelled&&!userSelectedSource.current)setError(e.message);});
    return ()=>{cancelled=true;};
  },[]);
  useEffect(()=>()=>{if(source.startsWith('blob:'))URL.revokeObjectURL(source);},[source]);
  useEffect(()=>{
    const el=video.current;if(!el || !source)return;
    let cancelled=false, id=0;
    const tick=(_now:number,metadata:VideoFrameCallbackMetadata)=>{
      if(cancelled)return;
      if(metadata.mediaTime!==frame.current.time) frame.current={time:metadata.mediaTime,stampedAt:performance.now()};
      if(!el.paused&&!el.seeking)setPlaying(true);
      id=el.requestVideoFrameCallback(tick);
    };
    if('requestVideoFrameCallback' in el)id=el.requestVideoFrameCallback(tick);
    return ()=>{cancelled=true;if(id)el.cancelVideoFrameCallback(id);};
  },[source]);
  useEffect(()=>{
    let id=0,last=performance.now();
    const tick=(now:number)=>{
      const state=latest.current;const el=video.current;
      if(state.videoMode && el && state.ready) {
        if(typeof (el as HTMLVideoElement & {requestVideoFrameCallback?:unknown}).requestVideoFrameCallback !== 'function' && el.currentTime!==frame.current.time) frame.current={time:el.currentTime,stampedAt:now};
        const next=lapTime(el.seeking?el.currentTime:frame.current.time,state.offset,duration);
        setTime(next);
        if(!el.paused && el.currentTime>=state.offset+duration) {el.pause();setTime(duration);setPlaying(false);stopMotion('Lap complete · motion stopped');}
      } else if(!state.videoMode && state.playing) {
        setTime((t:number)=>{const next=Math.min(duration,t+(now-last)/1000*rate);if(next>=duration){setPlaying(false);}return next;});
      }
      last=now;id=requestAnimationFrame(tick);
    };
    id=requestAnimationFrame(tick);return ()=>cancelAnimationFrame(id);
  },[rate,stopMotion]);
  useEffect(()=>{
    const hidden=()=>{if(document.hidden){pause();}};
    const exit=()=>{void serial.current?.stop('Page closed');};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',exit);
    return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',exit);};
  },[pause]);

  useEffect(()=>{if(!flexDemo)return;let id=0;const began=performance.now();const tick=(now:number)=>{setFlexPhase((now-began)/1000);id=requestAnimationFrame(tick);};id=requestAnimationFrame(tick);return()=>cancelAnimationFrame(id);},[flexDemo]);

  const toggle=useCallback(async()=>{
    setFlexDemo(false);
    if(latest.current.playing){pause();return;}
    if(latest.current.time>=duration){setTime(0);if(video.current)video.current.currentTime=latest.current.offset;}
    if(latest.current.videoMode){
      if(!video.current||!latest.current.ready)return;
      if(video.current.currentTime<latest.current.offset)video.current.currentTime=latest.current.offset;
      try{await video.current.play();setError('');}catch{setError('Video could not play. Try the local video picker.');}
    }else{setPlaying(true);}
  },[pause]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.code==='Space' && !/INPUT|SELECT|BUTTON|TEXTAREA|A/.test((event.target as HTMLElement).tagName)){event.preventDefault();void toggle();}if(event.key==='Escape')pause();};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[toggle,pause]);

  const seek=(value:number)=>{pause();setTime(value);frame.current={time:videoTime(value,offset,duration),stampedAt:0};if(videoMode&&video.current&&ready)video.current.currentTime=videoTime(value,offset,duration);};
  const changeOffset=(value:number)=>{pause();const next=clamp(value,0,Math.max(0,videoDuration-duration));setOffset(next);setConfirmed(false);};
  const selectFile=(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];if(!file)return;userSelectedSource.current=true;pause();setReady(false);setVideoDuration(0);setConfirmed(false);setOffset(0);setTime(0);setVideoMode(true);setError('');setSourceLabel(file.name);setSource(URL.createObjectURL(file));setSyncOpen(true);
  };
  const connect=async()=>{autoConnect.current=true;setBusy(true);try{await serial.current?.connect();}catch(e){setStatus(e instanceof Error?e.message:'Connection failed');}finally{setBusy(false);}};
  const disconnect=()=>{autoConnect.current=false;void serial.current?.disconnect();};
  const startMotion=async()=>{
    if(!connected||!confirmed||!playing||!videoMode||!fits)return;
    setStarting(true);
    try{await serial.current?.start(()=>{
      const s=latest.current, el=video.current;
      const elapsed=lapTime(frame.current.time,s.offset,duration);
      const motion=singaporeMotionAt(model,elapsed);
      if(!el||s.flexDemo||!s.fits||!canSendMotion({playing:!el.paused,videoMode:s.videoMode,ready:s.ready&&el.readyState>=3,seeking:el.seeking,hidden:document.hidden,ended:elapsed>=duration,confirmed:s.confirmed,valid:motion.valid,sampledAt:frame.current.stampedAt,now:performance.now()}))return null;
      const car=commandedPoseDegrees(motion,{roll:s.rollGain,pitch:s.pitchGain});
      return {...carPoseToFirmwarePose(car),sampledAt:frame.current.stampedAt};
    });}catch(e){setStatus(e instanceof Error?e.message:'Motion could not start');}finally{setStarting(false);}
  };
  const telemetryPath=useMemo(()=>carSamples.map((row,i)=>`${i?'L':'M'}${(row[0]/1000/duration*1000).toFixed(1)},${(96-row[1]/350*85).toFixed(1)}`).join(' '),[]);
  const throttlePath=useMemo(()=>carSamples.map((row,i)=>`${i?'L':'M'}${(row[0]/1000/duration*1000).toFixed(1)},${(96-row[3]/100*85).toFixed(1)}`).join(' '),[]);
  const trackPoint=project(sample.x,sample.y);
  const sectors=lap.sectorDurationSeconds;
  const sector=time<sectors[0]?1:time<sectors[0]+sectors[1]?2:3;
  const loaded=videoMode&&ready;

  return <main>
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">b.</span><span>BABOT <em>LAP PLAYER</em></span></a></header>
    <section className="intro"><div><div className="eyebrow">FORMULA 1 · QUALIFYING · 10 OCT 2026</div><h1>Singapore<span className="title-dot">.</span></h1></div><div className="driver"><span className="driver-number">03</span><div><span className="eyebrow">POLE POSITION</span><h2>Max Verstappen</h2><span className="driver-team">RED BULL RACING <b>1:31.373</b></span></div></div></section>
    <div className="session-strip"><span><i/> MAIN QUALIFYING / LAP {lap.lapNumber}</span><span>MARINA BAY STREET CIRCUIT</span><span>347 TELEMETRY SAMPLES <b>↗</b></span></div>
    <section className="viewer-grid">
      <article className="panel onboard-panel"><div className="panel-head"><h2><span>01</span> Onboard</h2><span className={loaded?'live-badge':'muted-label'}>{loaded?'● VIDEO CLOCK':videoMode?'LOADING VIDEO':'TELEMETRY PREVIEW'}</span></div>
        <div className="video-stage">
          <video ref={video} src={source||undefined} poster={media?.poster} playsInline preload="auto" muted={muted} aria-label="Max Verstappen 2026 Singapore pole onboard" onLoadedMetadata={()=>{const el=video.current!;setVideoDuration(el.duration);setReady(true);el.playbackRate=rate;el.currentTime=offset;frame.current={time:offset,stampedAt:0};setError('');}}
          onPlaying={()=>setPlaying(true)} onPause={()=>{setPlaying(false);stopMotion('Playback paused · motion stopped');}} onWaiting={()=>{setPlaying(false);stopMotion('Video buffering · motion stopped');}} onStalled={()=>stopMotion('Video network stalled · motion stopped')} onSeeking={()=>stopMotion('Seeking · motion stopped')} onEnded={()=>{setPlaying(false);stopMotion('Video ended · motion stopped');}} onError={()=>{setReady(false);setPlaying(false);stopMotion('Video unavailable');setError('Official video unavailable in this browser. Select a local MP4 to sync your replay.');}} />
          {!playing&&<button className="video-play" onClick={()=>void toggle()} disabled={videoMode&&!ready} aria-label="Play lap"><PlayIcon/></button>}
          <div className="video-corner"><span>VER / 03</span><span>{clock(time)}</span></div>
          {!videoMode&&<div className="preview-overlay">TELEMETRY PREVIEW<span>Video is paused. USB motion is disabled.</span></div>}
        </div>
        <div className="video-footer"><span title={sourceLabel}>{sourceLabel}</span><div><label className="text-button file-label">Open video<input type="file" accept="video/mp4,video/webm,video/quicktime,.mov,.m4v" onChange={selectFile}/></label><button className="text-button" onClick={()=>setSyncOpen(!syncOpen)}>Adjust sync <span>↗</span></button></div></div>
      </article>
      <article className="panel ribbon-panel"><div className="panel-head"><h2><span>02</span> Twin Ribbon</h2><span className="muted-label">BLENDER · 50 FPS</span></div><div className="ribbon-stage"><BlenderRibbon timeSeconds={time} playing={playing} playbackRate={rate} duration={duration}/><div className="ribbon-caption"><strong>{Math.round(sample.rpm).toLocaleString()}<small>RPM</small></strong></div></div><div className="ribbon-legend"><span><i className="legend-width"/> THROTTLE <b>WIDTH</b></span><span><i className="legend-height"/> SPEED <b>HEIGHT</b></span><span><i className="legend-color"/> RPM <b>COLOR</b></span></div></article>
    </section>
    {error&&<div className="notice" role="alert">{error} <a href={officialVideo} target="_blank" rel="noreferrer">Official onboard ↗</a></div>}
    {syncOpen&&<section className="sync-panel"><div><h3>Align the start / finish line</h3><p>Lap zero is the frame the car crosses the timing line. Set its video timestamp, then check the alignment. Changing it stops motion.</p></div><label>Lap start in video<input aria-label="Lap start in video seconds" type="number" min="0" max={Math.max(0,videoDuration-duration)} step="0.02" value={offset} onChange={e=>changeOffset(Number(e.target.value))}/><small>seconds</small></label><div className="sync-buttons"><button onClick={()=>changeOffset(offset-.02)}>− 1 frame</button><button onClick={()=>changeOffset(offset+.02)}>+ 1 frame</button><button onClick={()=>{seek(0);}}>Go to lap start</button><button onClick={()=>{pause();if(video.current)changeOffset(video.current.currentTime);}}>Use current frame</button></div><label className="check"><input type="checkbox" checked={confirmed} disabled={!ready||!fits||!videoMode} onChange={e=>{stopMotion();setConfirmed(e.target.checked);}}/>Start-line alignment checked</label>{!fits&&ready&&<span className="warning">The selected video must contain the full 1:31.373 lap.</span>}</section>}
    <section className="transport" aria-label="Playback controls"><div className="transport-main"><button className="play-button" onClick={()=>void toggle()} disabled={videoMode&&!ready} aria-label={playing?'Pause replay':'Play replay'}><PlayIcon playing={playing}/><span>{playing?'Pause':'Play lap'}</span></button><button className="restart" aria-label="Restart lap" onClick={()=>seek(0)}>↺</button><div className="lap-clock">{clock(time)}<span> / {clock(duration)}</span></div><div className="transport-options"><button className="mode-button" onClick={()=>{pause();setVideoMode(!videoMode);setConfirmed(false);if(!videoMode&&video.current)video.current.currentTime=videoTime(time,offset,duration);}}>{videoMode?'Video sync':'Telemetry preview'} <span>⌄</span></button><label className="rate-label"><select aria-label="Playback speed" value={rate} onChange={e=>{stopMotion('Playback speed changed');setRate(Number(e.target.value));if(video.current)video.current.playbackRate=Number(e.target.value);}}><option value=".5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><button className="text-button" onClick={()=>setMuted(!muted)} aria-label={muted?'Unmute video':'Mute video'}>{muted?'Sound off':'Sound on'}</button></div></div><div className="timeline"><div className="sector-lines"><span style={{left:`${sectors[0]/duration*100}%`}}/><span style={{left:`${(sectors[0]+sectors[1])/duration*100}%`}}/></div><input aria-label="Lap timeline" type="range" min="0" max={duration} step="0.001" value={time} onChange={e=>seek(Number(e.target.value))} style={{'--progress':`${time/duration*100}%`} as React.CSSProperties}/></div><div className="timeline-labels"><span>START</span>{sectors.map((s,i)=><button key={i} className={sector===i+1?'current-sector':''} onClick={()=>seek(i===0?0:sectors.slice(0,i).reduce((a,b)=>a+b,0))}>S{i+1} <b>{s.toFixed(3)}</b></button>)}<span>FINISH</span></div></section>
    {conceptsOpen&&<ChassisGallery selected={conceptId} onSelect={id=>{pause();setConceptId(id);setConceptsOpen(false);setFlexDemo(true);}} onClose={()=>setConceptsOpen(false)}/>}
    <section className="lower-grid">
      <article className="panel chassis-panel"><div className="panel-head"><h2><span>03</span> Rolling chassis</h2><button className="concept-trigger" onClick={()=>setConceptsOpen(!conceptsOpen)}>CHASSIS CONCEPTS ↗</button></div><div className="chassis-stage"><ConceptChassis conceptId={conceptId} roll={flexDemo?Math.sin(flexPhase*.9):pose.roll} pitch={flexDemo?Math.sin(flexPhase*.65)*.5:pose.pitch} distanceMeters={flexDemo?0:distanceAt(distance,time)} valid={flexDemo||sample.valid}/></div><div className="flex-controls"><button onClick={()=>{pause();setFlexDemo(!flexDemo);}}>{flexDemo?'Stop flex demo':'Preview suspension flex'}</button><span>{flexDemo?'CONCEPT DEMO · VISUAL ONLY':'DERIVED POSE · CONCEPTUAL SUSPENSION'}</span></div><div className="pose-readout"><span>ROLL <b>{pose.roll>=0?'+':''}{pose.roll.toFixed(2)}°</b></span><span>PITCH <b>{pose.pitch>=0?'+':''}{pose.pitch.toFixed(2)}°</b></span><span className="muted-label">BABOT ANGLES</span></div></article>
      <article className="panel telemetry-panel"><div className="panel-head"><h2><span>04</span> Telemetry</h2><span className="muted-label">{sample.valid?`S${sector}`:'INTERPOLATED GAP'}</span></div><div className="metrics"><Metric label="SPEED" value={String(Math.round(sample.speedKph))} unit="KM/H"/><Metric label="GEAR" value={String(sample.gear)} tone="orange"/><Metric label="ENGINE" value={(sample.rpm/1000).toFixed(1)} unit="×1000 RPM"/></div><div className="input-bars"><div><span>THROTTLE</span><div className="bar"><i style={{width:`${sample.throttlePct}%`}}/></div><b>{Math.round(sample.throttlePct)}%</b></div><div><span>BRAKE</span><div className="bar brake"><i style={{width:sample.brakeOn?'100%':'0%'}}/></div><b>{sample.brakeOn?'ON':'OFF'}</b></div></div><div className="track-row"><svg viewBox="0 0 200 120" role="img" aria-label="Position on Marina Bay circuit"><path d={trackPath} fill="none" stroke="#3a4e50" strokeWidth="3"/><circle cx={trackPoint[0]} cy={trackPoint[1]} r="5" fill="#ff7c42"/></svg><div><span className="eyebrow">ESTIMATED ACCELERATION</span><p><b>{sample.valid?sample.latG.toFixed(2):'—'}</b> lateral G</p><p><b>{sample.valid?sample.longG.toFixed(2):'—'}</b> longitudinal G</p><small>Derived from speed + path</small></div></div></article>
      <article className="panel hardware-panel"><div className="panel-head"><h2><span>05</span> BaBot</h2><span className={`hardware-state ${active?'active':''}`}>{active?'FOLLOWING':connected?'CONNECTED':'OFFLINE'}</span></div><div className="hardware-body"><div className="connection"><span className={`status-light ${connected?'connected':''}`}/><p>{active?'Following video clock':connected?'USB connection verified':'USB disconnected'}<small>{usbHint}</small></p><button onClick={()=>connected?disconnect():void connect()} disabled={!hasSerial||busy||active}>{busy?'…':connected?'Disconnect':'Connect'}</button></div><div className="gain-control"><label>Roll limit <b>{rollGain.toFixed(2)}°</b><input aria-label="Roll limit degrees" type="range" min="0" max="5" step=".25" value={rollGain} onChange={e=>{stopMotion('Motion range changed');setRollGain(Number(e.target.value));}}/></label><label>Pitch limit <b>{pitchGain.toFixed(2)}°</b><input aria-label="Pitch limit degrees" type="range" min="0" max="5" step=".25" value={pitchGain} onChange={e=>{stopMotion('Motion range changed');setPitchGain(Number(e.target.value));}}/></label></div><label className="check"><input type="checkbox" checked={confirmed} disabled={!ready||!fits||!videoMode} onChange={e=>{stopMotion();setConfirmed(e.target.checked);}}/>Video start-line alignment checked</label><div className="motion-buttons"><button className="start-motion" disabled={!connected||!confirmed||!playing||!videoMode||!fits||!sample.valid||active||starting||flexDemo} onClick={()=>void startMotion()}>{active?'Following lap':starting?'Starting…':time>0&&!sample.valid?'Telemetry gap':'Start motion'}</button><button className="stop-motion" onClick={()=>{pause();stopMotion('Level + stop requested');}}>■ Level + stop</button></div><p className="serial-status" role="status">{status}</p><p className="gap-note">Motion stops at source gaps near 27s, 51s and 63s. Resume explicitly after each gap.</p></div></article>
    </section>
    <section className="panel trace-panel"><div className="panel-head"><h2>Lap trace</h2><span className="trace-legend"><i/> SPEED <i/> THROTTLE</span><span className="muted-label">{clock(time)}</span></div><svg viewBox="0 0 1000 110" preserveAspectRatio="none" role="img" aria-label="Speed and throttle through the lap"><path d="M0 25H1000M0 60H1000M0 95H1000" stroke="#223034" strokeWidth=".7"/><path d={throttlePath} fill="none" stroke="#5faba4" strokeWidth="1.1" opacity=".6"/><path d={telemetryPath} fill="none" stroke="#f88a55" strokeWidth="1.8"/><line x1={time/duration*1000} x2={time/duration*1000} y1="0" y2="110" stroke="#e8ece6" strokeWidth="1"/></svg></section>
    <footer><p>Recorded OpenF1 telemetry. Roll, pitch and acceleration are derived cues; suspension is visual only.</p><a href={String(fixture.provenance.sourceUrls.officialQualifyingResults)} target="_blank" rel="noreferrer">Results ↗</a><a href={officialVideo} target="_blank" rel="noreferrer">Onboard ↗</a><a href="https://openf1.org/docs/" target="_blank" rel="noreferrer">Data ↗</a></footer>
  </main>;
}
