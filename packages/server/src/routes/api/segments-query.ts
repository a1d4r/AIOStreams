import { z } from 'zod';
import type { SegmentIdKey, SegmentLookup } from '@aiostreams/core';

/** The id spaces a segment provider keys on, in the spelling `/api/v1/anime` takes. */
const ID_KEYS = {
  imdbId: 'imdb',
  themoviedbId: 'tmdb',
  thetvdbId: 'tvdb',
  malId: 'mal',
  kitsuId: 'kitsu',
  anilistId: 'anilist',
  anidbId: 'anidb',
} as const satisfies Record<string, SegmentIdKey>;

/** Anime ids number episodes within their own entry, so need no season. */
const ANIME_ID_TYPES = new Set(['malId', 'kitsuId', 'anilistId', 'anidbId']);

/**
 * Below this a length is not an episode's: a client's placeholder or a
 * fraction of the file. Refused rather than ignored, so the client learns of it.
 */
const MIN_DURATION_S = 60;

/** Digits only: an empty `season=` must not read as season 0. */
const whole = (max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(0).max(max));

export const SegmentsQuerySchema = z
  .object({
    idType: z.enum(
      Object.keys(ID_KEYS) as [
        keyof typeof ID_KEYS,
        ...(keyof typeof ID_KEYS)[],
      ]
    ),
    idValue: z.string(),
    season: whole(9999).optional(),
    episode: whole(99999).optional(),
    /** The played file's length in seconds. */
    duration: z
      .string()
      .regex(/^\d{1,6}(\.\d{1,6})?$/, 'must be a number of seconds')
      .transform(Number)
      .pipe(z.number().min(MIN_DURATION_S).max(86_400))
      .optional(),
  })
  .superRefine((q, ctx) => {
    const pattern = q.idType === 'imdbId' ? /^tt\d{1,10}$/ : /^\d{1,10}$/;
    if (!pattern.test(q.idValue))
      ctx.addIssue({
        code: 'custom',
        path: ['idValue'],
        message: `not a valid ${q.idType}`,
      });
    if (q.season != null && q.episode == null)
      ctx.addIssue({
        code: 'custom',
        path: ['episode'],
        message: 'required with season',
      });
    if (q.episode != null && q.season == null && !ANIME_ID_TYPES.has(q.idType))
      ctx.addIssue({
        code: 'custom',
        path: ['season'],
        message: 'required with episode for this idType',
      });
  });

export type SegmentsQuery = z.infer<typeof SegmentsQuerySchema>;

/** Without season and episode it is a movie. */
export function lookupOf(query: SegmentsQuery): SegmentLookup {
  const episode = query.episode != null;
  return {
    kind: episode ? 'episode' : 'movie',
    ids: { [ID_KEYS[query.idType]]: query.idValue },
    season: episode ? query.season : undefined,
    episode: episode ? query.episode : undefined,
    durationMs: query.duration ? Math.round(query.duration * 1000) : undefined,
  };
}
