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
const CATALOG_URL = `https://edge.api.brightcove.com/playback/v1/accounts/${ACCOUNT_ID}/videos/${VIDEO_ID}`;

export interface OfficialMedia {
  url: string;
  poster: string;
  lapStartSeconds: number;
  title: string;
  /** Stable attribution link; `url` is the temporary video rendition. */
  sourceUrl: string;
  offsetNote: string;
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

export async function loadOfficialMedia(): Promise<OfficialMedia> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const playerResponse = await fetch(PLAYER_URL, { signal: controller.signal });
    if (!playerResponse.ok) throw new Error(`Official player returned HTTP ${playerResponse.status}.`);
    const playerSource = await playerResponse.text();
    // Public playback policy distributed in F1's browser player, not a user credential.
    const policyKey = playerSource.match(/videoCloud:\{policyKey:"([^"]+)"/)?.[1];
    if (!policyKey) throw new Error('The official player did not provide a playback policy.');

    const catalogResponse = await fetch(CATALOG_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: `application/json;pk=${policyKey}` },
    });
    if (!catalogResponse.ok) throw new Error(`Official video catalog returned HTTP ${catalogResponse.status}.`);
    const catalog: VideoCatalog = await catalogResponse.json();
    if (catalog.id !== VIDEO_ID || !catalog.name?.includes('2026') || !catalog.name.includes('Max Verstappen')) {
      throw new Error('The official video does not match Verstappen’s 2026 Singapore pole lap.');
    }

    const source = (Array.isArray(catalog.sources) ? catalog.sources : [])
      .filter(item => item.src?.startsWith('https://') && item.container === 'MP4' && !item.key_systems)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!source?.src) throw new Error('The official catalog has no public MP4 rendition available.');

    return {
      url: source.src,
      poster: catalog.poster?.startsWith('https://') ? catalog.poster : '',
      lapStartSeconds: 2.1,
      title: catalog.name,
      sourceUrl: OFFICIAL_VIDEO_PAGE,
      offsetNote: 'Lap zero is 2.10s into the official video. Broadcast timer and start/finish stripe checked; estimated alignment ±0.10s. Fine-tune with sync trim.',
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The official video request timed out after 10 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
