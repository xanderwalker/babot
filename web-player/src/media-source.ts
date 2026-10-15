/**
 * Formula 1's public browser player supplies this freely accessible onboard.
 * Resolve a new catalog response for each page load because its CDN URLs expire.
 * No account credentials, signed URLs, or video bytes are bundled in the site.
 */
const ACCOUNT_ID = '6057949432001';
const PLAYER_ID = 'FC1Xxg8gIw';
const VIDEO_ID = '1878677458343183007';

export const OFFICIAL_VIDEO_PAGE =
  'https://www.formula1.com/en/video/onboard-max-verstappens-2026-pirelli-pole-position-award-lap-at-the-singapore-grand-prix.' + VIDEO_ID;

const PLAYER_URL = `https://players.brightcove.net/${ACCOUNT_ID}/${PLAYER_ID}_default/index.min.js`;
export interface EventMedia {
  videoId: string; officialPageUrl: string; title?: string; driverName?: string;
  lapStartSeconds?: number; syncStatus: string; offsetNote?: string;
}
export const SINGAPORE_MEDIA: EventMedia = {videoId:VIDEO_ID,officialPageUrl:OFFICIAL_VIDEO_PAGE,driverName:'Max Verstappen',lapStartSeconds:2.1,syncStatus:'verified',offsetNote:'Lap zero is 2.10s into the official video. Broadcast timer and timing stripe checked; estimated alignment ±0.10s.'};

export interface OfficialMedia {
  url: string;
  poster: string;
  lapStartSeconds: number;
  title: string;
  /** Stable attribution link; `url` is the temporary video rendition. */
  sourceUrl: string;
  offsetNote: string;
  syncVerified: boolean;
}

interface CatalogSource {
  src?: string;
  container?: string;
  height?: number;
  key_systems?: unknown;
}

interface VideoCatalog {
  id?: string;
  name?: string;
  poster?: string;
  sources?: CatalogSource[];
}

export async function loadOfficialMedia(event: EventMedia = SINGAPORE_MEDIA): Promise<OfficialMedia> {
  if (!event.videoId || !/^\d+$/.test(event.videoId)) throw new Error('An official onboard is not available for this round yet.');
  const catalogUrl = `https://edge.api.brightcove.com/playback/v1/accounts/${ACCOUNT_ID}/videos/${event.videoId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const playerResponse = await fetch(PLAYER_URL, { signal: controller.signal });
    if (!playerResponse.ok) throw new Error(`Official player returned HTTP ${playerResponse.status}.`);
    const playerSource = await playerResponse.text();
    // Public playback policy distributed in F1's browser player, not a user credential.
    const policyKey = playerSource.match(/videoCloud:\{policyKey:"([^"]+)"/)?.[1];
    if (!policyKey) throw new Error('The official player did not provide a playback policy.');

    const catalogResponse = await fetch(catalogUrl, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: `application/json;pk=${policyKey}` },
    });
    if (!catalogResponse.ok) throw new Error(`Official video catalog returned HTTP ${catalogResponse.status}.`);
    const catalog: VideoCatalog = await catalogResponse.json();
    const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const surname=event.driverName?.trim().split(/\s+/).at(-1);
    if (catalog.id !== event.videoId || !catalog.name || (event.title ? normalize(catalog.name)!==normalize(event.title) : !catalog.name.includes('2026')) || (surname && !normalize(catalog.name).includes(normalize(surname)))) {
      throw new Error('The official video does not match the selected pole lap.');
    }

    const source = (Array.isArray(catalog.sources) ? catalog.sources : [])
      .filter(item => item.src?.startsWith('https://') && item.container === 'MP4' && !item.key_systems)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!source?.src) throw new Error('The official catalog has no public MP4 rendition available.');

    return {
      url: source.src,
      poster: catalog.poster?.startsWith('https://') ? catalog.poster : '',
      lapStartSeconds: event.lapStartSeconds ?? 0,
      title: catalog.name,
      sourceUrl: event.officialPageUrl,
      offsetNote: event.offsetNote ?? 'Check the timing stripe and lap timer before enabling synchronized motion.',
      syncVerified: event.syncStatus==='verified' && Number.isFinite(event.lapStartSeconds),
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The official video request timed out after 10 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
