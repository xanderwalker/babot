export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
export function lapTime(mediaTime, offset, duration) { return clamp(mediaTime - offset, 0, duration); }
export function videoTime(seconds, offset, duration) { return Math.max(0, offset) + clamp(seconds, 0, duration); }
export function windowFits(videoDuration, offset, duration) { return Number.isFinite(videoDuration) && offset >= 0 && duration > 0 && offset + duration <= videoDuration + .12; }
export function canSendMotion({ playing, videoMode, ready, seeking, hidden, ended, confirmed, valid, sampledAt, now }) { return playing && videoMode && ready && !seeking && !hidden && !ended && confirmed && valid && now >= sampledAt && now - sampledAt < 180; }
export function distanceSeries(samples) {
  let distance = 0;
  return samples.map((row, i) => { if(i) distance += (row[0] - samples[i-1][0]) / 1000 * (row[1] + samples[i-1][1]) / 7.2; return [row[0] / 1000, distance]; });
}
export function distanceAt(series, seconds) {
  if(!series.length || seconds <= series[0][0]) return 0;
  let i=0, j=series.length-1;
  if(seconds >= series[j][0]) return series[j][1];
  while(i+1<j) { const m=(i+j)>>1; if(series[m][0] <= seconds) i=m; else j=m; }
  return series[i][1] + (series[j][1]-series[i][1]) * (seconds-series[i][0]) / (series[j][0]-series[i][0]);
}

// Visual telemetry interpolates the recorded channel samples. This function is
// deliberately separate from the stricter physical-motion validity model.
export function channelsAt(samples, timeSeconds) {
  if (!samples.length) return [];
  const t=timeSeconds*1000;
  if(t<=samples[0][0])return [...samples[0]];
  if(t>=samples.at(-1)[0])return [...samples.at(-1)];
  let lo=0,hi=samples.length-1;
  while(lo+1<hi){const mid=(lo+hi)>>1;if(samples[mid][0]<=t)lo=mid;else hi=mid;}
  const a=samples[lo],b=samples[hi],u=(t-a[0])/(b[0]-a[0]);
  return a.map((v,i)=>i===0?t:i>=4?v:v+(b[i]-v)*u);
}
