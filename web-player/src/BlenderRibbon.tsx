import { useEffect, useRef, useState } from 'react';
import { assetUrl } from './asset-url';
import { Ribbon } from './Visuals';

type RibbonManifest = { datasetId?: string; src: string; poster?: string; fps: number; startTimeSeconds: number; duration: number; title: string };
const MASTER_STALE_MS = 180;

/** The onboard remains authoritative. This media element only follows its lap clock. */
export function BlenderRibbon({timeSeconds, playing, playbackRate, duration, manifestPath='/media/ribbon.json', eventName='Singapore Grand Prix', samples, onFilmReady, datasetId}: {timeSeconds:number;playing:boolean;playbackRate:number;duration:number;manifestPath?:string;eventName?:string;samples?:number[][];onFilmReady?:()=>void;datasetId?:string}) {
  const element=useRef<HTMLVideoElement>(null);
  const masterClock=useRef({time:Number.NaN,advancedAt:-Infinity});
  const [manifest,setManifest]=useState<RibbonManifest|null>(null);
  const [videoUrl,setVideoUrl]=useState('');
  const [loading,setLoading]=useState(false);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState('');
  const [progress,setProgress]=useState<{completed:number;total:number;message?:string}|null>(null);
  useEffect(()=>{
    let cancelled=false, timer:ReturnType<typeof setTimeout>;
    const controller=new AbortController();
    const check=async()=>{
      try {
        const response=await fetch(assetUrl(manifestPath),{signal:controller.signal,cache:'no-store'});
        if(!response.ok || !response.headers.get('content-type')?.includes('json'))throw new Error('pending');
        const value:RibbonManifest=await response.json();
        if((datasetId && value.datasetId!==datasetId) || !value.src || Math.abs(value.duration-duration)>.04 || value.startTimeSeconds!==0 || value.fps!==50)throw new Error('Ribbon timing does not match this lap.');
        if(cancelled)return;
        setManifest({...value,src:assetUrl(value.src),poster:value.poster?assetUrl(value.poster):undefined});setError('');
      } catch {
        if(cancelled)return;
        setError('Live telemetry preview. The Blender film is not available yet.');
        try { const r=await fetch(assetUrl(manifestPath.replace(/ribbon\.json$/,'ribbon-progress.json')),{signal:controller.signal,cache:'no-store'});if(r.ok&&r.headers.get('content-type')?.includes('json')){const p=await r.json();if(!cancelled)setProgress(p);}} catch {}
        if(!cancelled)timer=setTimeout(check,30000);
      }
    };
    void check();
    return()=>{cancelled=true;controller.abort();clearTimeout(timer);};
  },[manifestPath,duration,datasetId]);
  useEffect(()=>{
    if(!manifest)return;
    let cancelled=false, objectUrl='';
    const controller=new AbortController();
    setReady(false);setVideoUrl('');setLoading(true);setError('');
    const load=async()=>{
      try {
        // The static host does not serve byte ranges. A complete local Blob
        // gives the media element a seekable source on both hosted and local pages.
        const response=await fetch(manifest.src,{signal:controller.signal});
        if(!response.ok)throw new Error(`Ribbon video could not load (HTTP ${response.status}). Reload to try again.`);
        const blob=await response.blob();
        if(cancelled)return;
        if(!blob.size)throw new Error('The ribbon video file is empty. Reload to try again.');
        objectUrl=URL.createObjectURL(new Blob([blob],{type:'video/mp4'}));
        setVideoUrl(objectUrl);
      } catch(cause) {
        if(cancelled)return;
        setLoading(false);
        setError(cause instanceof Error?cause.message:'Ribbon video could not load. Reload to try again.');
      }
    };
    void load();
    return()=>{
      cancelled=true;controller.abort();
      if(objectUrl)URL.revokeObjectURL(objectUrl);
    };
  },[manifest]);
  useEffect(()=>{
    if(Number.isFinite(timeSeconds)&&timeSeconds!==masterClock.current.time){
      masterClock.current={time:timeSeconds,advancedAt:performance.now()};
    }
    const el=element.current;if(!el||!manifest||!ready)return;
    const target=Math.max(0,Math.min(manifest.duration-.02,timeSeconds-manifest.startTimeSeconds));
    // Small drift corrections avoid independent clocks diverging during playback.
    if(Math.abs(el.currentTime-target)>(playing?.06:.008))el.currentTime=target;
    el.playbackRate=playbackRate;
    const clockFresh=performance.now()-masterClock.current.advancedAt<MASTER_STALE_MS;
    if(playing&&clockFresh&&timeSeconds<duration){if(el.paused)void el.play().then(()=>setError('')).catch((cause:unknown)=>{if(!(cause instanceof DOMException&&cause.name==='AbortError'))setError('Press Play again to start the ribbon video.');});}
    else if(!el.paused)el.pause();
  },[timeSeconds,playing,playbackRate,manifest,ready,duration]);
  useEffect(()=>{
    const el=element.current;if(!el||!playing||!ready)return;
    // A frozen master does not change React props. Independently pause this
    // follower so it cannot run ahead while the onboard is buffering.
    const watchdog=setInterval(()=>{
      if(performance.now()-masterClock.current.advancedAt>=MASTER_STALE_MS&&!el.paused)el.pause();
    },40);
    return()=>clearInterval(watchdog);
  },[playing,ready,manifest]);
  return <div className="blender-ribbon">
    {!videoUrl&&samples?<Ribbon samples={samples} timeSeconds={timeSeconds} duration={duration}/>:null}
    {!videoUrl&&!samples&&manifest?.poster?<img className="ribbon-preview-still" src={manifest.poster} alt="Preview still from this lap's Blender ribbon render"/>:null}
    {manifest&&videoUrl?<video key={videoUrl} ref={element} src={videoUrl} poster={manifest.poster} muted playsInline preload="auto" aria-label={`Blender-rendered Twin Ribbon of the 2026 ${eventName} pole lap`} onLoadedMetadata={()=>{setReady(true);setLoading(false);setError('');onFilmReady?.();}} onError={()=>{setReady(false);setLoading(false);setError('Ribbon video unavailable. Reload to try again.');}}/>:null}
    {loading?<div className="ribbon-render-status" role="status"><span>LOADING RIBBON VIDEO</span><p>Preparing the ribbon film for synchronized playback.</p></div>:null}
    {error?<div className="ribbon-render-status" role="status"><span>{manifest?(ready?'RIBBON PLAYBACK ERROR':'RIBBON LOAD ERROR'):'LIVE RIBBON PREVIEW'}</span><p>{error}</p>{!manifest&&progress&&progress.total>0?<small>{Math.round(progress.completed/progress.total*100)}% · {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} frames</small>:null}</div>:null}
  </div>;
}
