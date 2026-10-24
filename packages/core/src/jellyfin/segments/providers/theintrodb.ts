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
import { askedLength } from '../length.js';

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

/** A release cluster from `list_versions`; a length of 0 is "unknown". */
interface TheIntroDbVersion {
  duration_ms?: number | null;
  submission_count?: number | null;
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

/*
 * Every 10 s step of a file's length is its own marker-cache key, so the
 * provider keeps its own answers per episode: the list of releases, and the
 * markers per release asked for. However many lengths an episode is played
 * at, it costs one request for the list and one per release it lands in.
 */
const answers = Cache.getInstance<string, TheIntroDbResponse>(
  'theintrodb-answers',
  20_000
);
const versionLists = Cache.getInstance<string, TheIntroDbVersion[]>(
  'theintrodb-versions',
  20_000
);

/** The server's own window for matching a length to a release. */
const VERSION_WINDOW_MS = 5 * 60_000;

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

/** One request; `undefined` for a 404 (`no_submissions`, `episode_not_found`). */
async function ask<T>(
  ctx: ProviderContext,
  params: URLSearchParams
): Promise<T | undefined> {
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
  if (response.status === 404) return undefined;
  if (response.status === 429) {
    const seconds = pauseFor(response.headers);
    await pause
      .set(PAUSE_KEY, Date.now() + seconds * 1000, seconds)
      .catch(() => undefined);
  }
  // Anything else, a rate limit included, is thrown so it is not remembered
  // as a miss.
  if (!response.ok) throw new Error(`TheIntroDB answered ${response.status}`);
  return (await response.json()) as T;
}

/** Answers, misses included, are kept as long as the marker cache keeps them. */
async function cached<T extends object>(
  store: Cache<string, T>,
  key: string,
  miss: T,
  load: () => Promise<T | undefined>
): Promise<T> {
  const hit = await store.get(key).catch(() => undefined);
  if (hit) return hit;
  const answer = await load();
  // An empty release list is a miss too: nothing submitted for any release.
  const found = Array.isArray(answer) ? answer.length > 0 : !!answer;
  const { ttl, negativeTtl } = appConfig.jellyfin.segments;
  await store
    .set(key, answer ?? miss, found ? ttl : negativeTtl)
    .catch(() => undefined);
  return answer ?? miss;
}

/** The known release closest to `lengthMs`, within the server's own window. */
function closestVersion(
  versions: TheIntroDbVersion[],
  lengthMs: number
): number | undefined {
  let best: number | undefined;
  for (const version of versions) {
    const ms = version?.duration_ms;
    if (typeof ms !== 'number' || ms <= 0) continue;
    if (
      best === undefined ||
      Math.abs(ms - lengthMs) < Math.abs(best - lengthMs)
    )
      best = ms;
  }
  return best !== undefined && Math.abs(best - lengthMs) <= VERSION_WINDOW_MS
    ? best
    : undefined;
}

/**
 * TVDB-, TMDB- or IMDb-keyed, series and movies. Each type is a list, best
 * first here; `null` bounds mean the start or the end of the file, and `0–0`
 * is a vote that the episode has no such segment.
 *
 * Given a length, the release is chosen here from `list_versions` (which
 * lists the releases' lengths but no markers) and asked for by its exact
 * length, so answers are kept per release, not per length. Without one, or
 * with no release within five minutes of it, the server answers for its most
 * submitted release.
 */
export const theIntroDbProvider: SegmentProvider = {
  id: 'theintrodb',
  name: 'TheIntroDB',
  defaultBaseUrl: 'https://api.theintrodb.org',
  kinds: ['episode', 'movie'],
  idKeys: ['imdb'],
  lengthAware: true,

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
    const episodeKey = `${ctx.baseUrl}|${params}`;

    const length = askedLength(lookup);
    let release: number | undefined;
    if (length) {
      const versions = await cached(
        versionLists,
        `${episodeKey}|versions`,
        [],
        async () => {
          const list = new URLSearchParams(params);
          list.set('list_versions', 'true');
          const body = await ask<{ versions?: TheIntroDbVersion[] }>(ctx, list);
          return body
            ? Array.isArray(body.versions)
              ? body.versions
              : []
            : undefined;
        }
      );
      // Nothing submitted for any release.
      if (!versions.length) return [];
      release = closestVersion(versions, length.ms);
    }
    const body = await cached(
      answers,
      `${episodeKey}|${release ?? 'top'}`,
      {},
      () => {
        const one = new URLSearchParams(params);
        if (release) one.set('duration_ms', String(release));
        return ask<TheIntroDbResponse>(ctx, one);
      }
    );

    const group = body?.group_duration_ms;
    const releaseMs =
      typeof group === 'number' && group > 0 ? group : undefined;

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
        out.push({
          type,
          startMs,
          endMs,
          provider: 'theintrodb',
          ...(releaseMs && { releaseMs }),
        });
      }
    }
    return out;
  },
};
