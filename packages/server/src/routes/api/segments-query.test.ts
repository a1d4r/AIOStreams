import { describe, expect, test } from 'vitest';
import { lookupOf, SegmentsQuerySchema } from './segments-query.js';

const parse = (query: Record<string, unknown>) =>
  SegmentsQuerySchema.safeParse(query);

const episode = { idType: 'imdbId', idValue: 'tt0903747' };

describe('GET /api/v1/segments query', () => {
  test('reads an episode with a fractional file length', () => {
    const result = parse({
      ...episode,
      season: '5',
      episode: '14',
      duration: '2847.5',
    });
    expect(result.success).toBe(true);
    expect(lookupOf(result.data!)).toEqual({
      kind: 'episode',
      ids: { imdb: 'tt0903747' },
      season: 5,
      episode: 14,
      durationMs: 2_847_500,
    });
  });

  test('reads a movie without season and episode', () => {
    const result = parse({ idType: 'themoviedbId', idValue: '27205' });
    expect(result.success).toBe(true);
    expect(lookupOf(result.data!)).toMatchObject({
      kind: 'movie',
      ids: { tmdb: '27205' },
    });
  });

  test('takes an anime id without a season', () => {
    const result = parse({ idType: 'malId', idValue: '38524', episode: '1' });
    expect(result.success).toBe(true);
    expect(lookupOf(result.data!)).toMatchObject({
      kind: 'episode',
      ids: { mal: '38524' },
      episode: 1,
    });
  });

  test.each([
    ['an empty season and episode', { season: '', episode: '' }],
    ['an empty episode', { season: '1', episode: '' }],
    ['a fractional episode', { season: '1', episode: '1.5' }],
    ['a negative season', { season: '-1', episode: '1' }],
    ['a repeated season', { season: ['1', '2'], episode: '1' }],
    ['season without episode', { season: '1' }],
    ['episode without season', { episode: '1' }],
    ['an empty duration', { season: '1', episode: '1', duration: '' }],
    ['a tiny duration', { season: '1', episode: '1', duration: '0.5' }],
    [
      'a duration under a minute',
      { season: '1', episode: '1', duration: '59' },
    ],
    ['a duration over a day', { season: '1', episode: '1', duration: '86401' }],
    ['a non-numeric duration', { season: '1', episode: '1', duration: '1e4' }],
    ['a malformed IMDb id', { idValue: '0903747' }],
  ])('refuses %s', (_, extra) => {
    expect(parse({ ...episode, ...extra }).success).toBe(false);
  });

  test('refuses an unknown id type', () => {
    expect(parse({ idType: 'traktId', idValue: '1' }).success).toBe(false);
  });
});
