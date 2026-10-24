import type { SegmentProviderId } from '../../utils/constants.js';

/** The Jellyfin segment types a provider here can supply. */
export type SegmentType = 'Intro' | 'Recap' | 'Outro';

export interface Segment {
  type: SegmentType;
  startMs: number;
  endMs: number;
  /** Which provider supplied it; carried for logging, not for clients. */
  provider: SegmentProviderId;
}

/** Every id space a provider might key on. Keys are Stremio's spellings. */
export type SegmentIdKey =
  | 'imdb'
  | 'tmdb'
  | 'tvdb'
  | 'mal'
  | 'kitsu'
  | 'anilist'
  | 'anidb';

export interface SegmentLookup {
  kind: 'movie' | 'episode';
  ids: Partial<Record<SegmentIdKey, string>>;
  season?: number;
  episode?: number;
  /** Rejects and clamps entries that cannot fit this cut. Absent until an item has been resolved. */
  runtimeMs?: number;
  /**
   * The played file's measured length. A listed runtime is whole minutes and
   * fits every release; this tells one release from another, so providers
   * that match releases ask for this one and it takes over from `runtimeMs`.
   */
  durationMs?: number;
  /** TMDB season/episode candidates, best first. Absent: `season`/`episode` already are; empty: none known. */
  tmdbEpisodes?: { season: number; episode: number }[];
  /** The id space `season`/`episode` are numbered in: the stated id's. Set once ids are resolved. */
  numberedBy?: SegmentIdKey;
  /** The episode's number inside the resolved anime entry (one MAL record). Absent: unknown, so not asked. */
  animeEpisode?: number;
}

export interface SegmentProviderStatus {
  id: SegmentProviderId;
  name: string;
  /** `configuration`: usable only by configurations that enter their own key. */
  key: 'none' | 'instance' | 'configuration';
}

/** Per-configuration keys, each overriding the instance's own. */
export interface SegmentCredentials {
  pmdbApiKey?: string;
}

export interface ProviderContext {
  baseUrl: string;
  timeoutMs: number;
  /** Only applied by providers that publish a score. */
  minConfidence: number;
  minSubmissions: number;
  animeSkipClientId: string;
  pmdbApiKey: string;
}

export interface SegmentProvider {
  id: SegmentProviderId;
  name: string;
  defaultBaseUrl: string;
  /** Ids this provider needs, so the caller knows what to resolve first. */
  readonly idKeys: readonly SegmentIdKey[];
  /** What it covers before any ids are resolved, which `supports` cannot answer. */
  readonly kinds: readonly SegmentLookup['kind'][];
  /** Its answer depends on the length asked about, which then goes into its cache key. */
  readonly lengthAware?: boolean;
  /** Absent means it needs no credentials. */
  configured?(ctx: ProviderContext): boolean;
  /** The credential a configuration can supply when the instance has none. */
  readonly configurationKey?: keyof SegmentCredentials;
  /** The precise gate, run once ids are resolved. */
  supports(lookup: SegmentLookup, ctx: ProviderContext): boolean;
  /** Raw segments in any order. Throwing is safe, and ranges are validated centrally. */
  fetch(lookup: SegmentLookup, ctx: ProviderContext): Promise<Segment[]>;
}
