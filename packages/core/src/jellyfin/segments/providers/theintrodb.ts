import { appConfig } from '../../../index.js';
import { Cache } from '../../../utils/cache.js';
import { makeRequest } from '../../../utils/http.js';
import type {
  ProviderContext,
  Segment,
  SegmentLookup,
  SegmentProvider,
  SegmentType,
} from '../types.js';

interface TheIntroDbSegment {
  start_ms?: number | null;
  end_ms?: number | null;
  confidence?: number | null;
  submission_count?: number | null;
}

interface TheIntroDbResponse {
  group_duration_ms?: number | null;
  intro?: TheIntroDbSegment[] | null;
  recap?: TheIntroDbSegment[] | null;
  credits?: TheIntroDbSegment[] | null;
}

type Field = 'intro' | 'recap' | 'credits';

const EPISODE_FIELDS: [Field, SegmentType][] = [
  ['intro', 'Intro'],
  ['recap', 'Recap'],
  ['credits', 'Outro'],
];

/** As with IntroDB: a movie's "intro" rows are studio logos, not an opening to skip. */
const MOVIE_FIELDS: [Field, SegmentType][] = [['credits', 'Outro']];

/**
 * The id whose numbering `season`/`episode` are in: the server translates
 * IMDb and TMDB numbering to its own TVDB order, but only for the id it is
 * handed. Movies have no numbering, so any id will do.
 */
function idParam(lookup: SegmentLookup): [string, string] | null {
  const { ids } = lookup;
  if (lookup.kind === 'movie') {
    if (ids.tmdb) return ['tmdb_id', ids.tmdb];
    return ids.imdb ? ['imdb_id', ids.imdb] : null;
  }
  switch (lookup.numberedBy ?? 'imdb') {
    case 'imdb':
      return ids.imdb ? ['imdb_id', ids.imdb] : null;
    case 'tmdb':
      return ids.tmdb ? ['tmdb_id', ids.tmdb] : null;
    case 'tvdb':
      return ids.tvdb ? ['tvdb_id', ids.tvdb] : null;
    default:
      // An anime id's episode numbers are its entry's, which TheIntroDB does not know.
      return null;
  }
}

function sortKey(raw: TheIntroDbSegment): [number, number] {
  return [raw.confidence ?? 0, raw.submission_count ?? 0];
}

/*
 * The daily allowance is per IP, so every user of an instance shares it, and
 * a 429 is answered again for every lookup until the window resets. After one,
 * nothing is sent until then. In the shared cache so every replica waits.
 */
const pause = Cache.getInstance<string, number>('theintrodb-pause', 1);
const PAUSE_KEY = 'until';
/** When the response names no reset: the short window is ten seconds, the daily one unknown. */
const DEFAULT_PAUSE_S = 60;
const EXHAUSTED_PAUSE_S = 3600;
const MAX_PAUSE_S = 86_400;

/** Seconds from now: a delta, or an epoch time in seconds. */
function resetIn(value: string | null): number | undefined {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e9 ? n - Date.now() / 1000 : n;
}

export function pauseFor(headers: Headers): number {
  const exhausted = headers.get('x-usagelimit-remaining') === '0';
  const daily = exhausted
    ? resetIn(headers.get('x-usagelimit-reset'))
    : undefined;
  const named = [
    resetIn(headers.get('retry-after')),
    resetIn(headers.get('x-ratelimit-reset')),
    daily,
  ].filter((s): s is number => s !== undefined && s > 0);
  // Spent with no readable daily reset: the short window's reset says
  // nothing about when the day's allowance comes back.
  if (exhausted && !(daily !== undefined && daily > 0))
    named.push(EXHAUSTED_PAUSE_S);
  const seconds = named.length ? Math.max(...named) : DEFAULT_PAUSE_S;
  return Math.min(Math.ceil(seconds), MAX_PAUSE_S);
}

/**
 * TVDB-, TMDB- or IMDb-keyed, series and movies. Each type is a list, best
 * first here; `null` bounds mean the start or the end of the file, and `0–0`
 * is a vote that the episode has no such segment. Asked without a length, the
 * server answers for its most submitted release, so one lookup per episode
 * serves every runtime.
 */
export const theIntroDbProvider: SegmentProvider = {
  id: 'theintrodb',
  name: 'TheIntroDB',
  defaultBaseUrl: 'https://api.theintrodb.org',
  kinds: ['episode', 'movie'],
  idKeys: ['imdb'],

  supports(lookup) {
    if (!idParam(lookup)) return false;
    return (
      lookup.kind === 'movie' ||
      (lookup.season != null && lookup.episode != null)
    );
  },

  async fetch(lookup: SegmentLookup, ctx: ProviderContext) {
    const movie = lookup.kind === 'movie';
    const [idKey, idValue] = idParam(lookup)!;
    const params = new URLSearchParams({ [idKey]: idValue, details: 'true' });
    if (!movie) {
      params.set('season', String(lookup.season));
      params.set('episode', String(lookup.episode));
    }
    const until = await pause.get(PAUSE_KEY).catch(() => undefined);
    if (until && until > Date.now())
      throw new Error('TheIntroDB is rate limited, waiting for its reset');
    const response = await makeRequest(
      `${ctx.baseUrl.replace(/\/+$/, '')}/v4/media?${params}`,
      {
        timeout: ctx.timeoutMs,
        headers: {
          accept: 'application/json',
          'user-agent': appConfig.http.defaultUserAgent,
        },
      }
    );
    // `no_submissions` and `episode_not_found`. Anything else, a rate limit
    // included, is thrown so it is not remembered as a miss.
    if (response.status === 404) return [];
    if (response.status === 429) {
      const seconds = pauseFor(response.headers);
      await pause
        .set(PAUSE_KEY, Date.now() + seconds * 1000, seconds)
        .catch(() => undefined);
    }
    if (!response.ok) throw new Error(`TheIntroDB answered ${response.status}`);
    const body = (await response.json()) as TheIntroDbResponse;

    const out: Segment[] = [];
    for (const [field, type] of movie ? MOVIE_FIELDS : EPISODE_FIELDS) {
      const rows = Array.isArray(body?.[field]) ? body[field]! : [];
      const ordered = [...rows].sort((a, b) => {
        const [ac, as] = sortKey(a);
        const [bc, bs] = sortKey(b);
        return bc - ac || bs - as;
      });
      for (const raw of ordered) {
        // Credits "from the start of the file" are a mistaken submission; an
        // opening or a recap can start the file.
        if (raw?.start_ms == null && type === 'Outro') continue;
        const startMs = raw?.start_ms ?? 0;
        const endMs = raw?.end_ms ?? Number.POSITIVE_INFINITY;
        if (typeof startMs !== 'number' || typeof endMs !== 'number') continue;
        if (startMs === 0 && endMs === 0) continue;
        if (
          typeof raw.confidence === 'number' &&
          raw.confidence < ctx.minConfidence
        )
          continue;
        if ((raw.submission_count ?? 0) < ctx.minSubmissions) continue;
        out.push({ type, startMs, endMs, provider: 'theintrodb' });
      }
    }
    return out;
  },
};
