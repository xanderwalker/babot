import { memo } from 'react';
import './SeasonLibrary.css';
export interface SeasonEvent {
  id: string; round: number; meetingKey: number; name: string; circuit: string;
  country: string; date: string; status: 'available' | 'upcoming' | 'unavailable';
  motionCoverage?: {unavailableSeconds:number}; fixtureUrl?: string; driverName?: string; lapDurationSeconds?: number; reason?: string;
}

export const SeasonLibrary=memo(function SeasonLibrary({events, selected, loading, onSelect, error}: {events:SeasonEvent[];selected:string;loading:boolean;onSelect:(event:SeasonEvent)=>void;error:string}) {
  const available=events.filter(event=>event.status==='available').length;
  return <section className="season-library" aria-label="2026 replay library">
    <div className="season-heading"><div><span className="eyebrow">2026 SEASON</span><h2>Every circuit. One lap.</h2></div><span className="season-count">{available} REPLAYS <span>/ {events.length} GRANDS PRIX</span></span></div>
    <label className="race-select">Grand Prix<select aria-label="Grand Prix" value={selected} disabled={loading} onChange={e=>{const event=events.find(item=>item.id===e.target.value);if(event)onSelect(event);}}>{events.map(event=><option key={event.id} value={event.id} disabled={event.status!=='available'}>{String(event.round).padStart(2,'0')} · {event.name.replace(/ Grand Prix$/,'')} {event.status==='upcoming'?'— Upcoming':event.status==='unavailable'?'— Unavailable':`— ${event.driverName??'Pole lap'}`}</option>)}</select><span aria-live="polite">{loading?'Stopping motion and loading replay…':'Selecting a race pauses playback.'}</span></label>
    <details className="season-calendar"><summary>View the season calendar <span>↓</span></summary><div className="race-grid">{events.map(event=><button key={event.id} className={`race-card ${selected===event.id?'selected':''}`} aria-pressed={selected===event.id} disabled={loading||event.status!=='available'} onClick={()=>onSelect(event)} title={event.reason}><span className="race-round">{String(event.round).padStart(2,'0')} <small>{new Date(event.date).toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'})}</small></span><strong>{event.name.replace(/ Grand Prix$/,'')}</strong><span>{event.status==='available'?event.driverName:event.status==='upcoming'?'Qualifying ahead':event.reason??'Replay unavailable'}</span></button>)}</div></details>
    {error&&<p className="season-error" role="alert">{error}</p>}
  </section>;
});
