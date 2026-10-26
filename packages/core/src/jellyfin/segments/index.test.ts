import { describe, test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { settingsStore } from '../../config/index.js';
import { SettingsRepository } from '../../db/repositories/settings.js';
import { AnimeDatabase } from '../../anime-database/index.js';
import { AnimeType, type AnimeEntry } from '../../anime-database/types.js';
import { IdMappingDataset } from '../../metadata/id-mappings.js';
import { IMDBMetadata } from '../../metadata/imdb.js';
import { cacheKey, fillIds } from './index.js';
import type { SegmentLookup } from './types.js';

// One Piece on IMDb: one MAL entry counted on through every IMDb season.
const onePiece: AnimeEntry = {
  type: AnimeType.TV,
  mappings: { malId: 21, imdbId: 'tt0388629' },
  imdb: { id: 'tt0388629', seasonNumber: 1, fromEpisode: 1 },
  tmdb: { seasonNumber: null, seasonId: null },
  tvdb: { seasonNumber: null, seasonId: 31893, absoluteOrder: true },
} as AnimeEntry;

async function stub(
  t: TestContext,
  entry: () => Promise<AnimeEntry | null>,
  videos: () => Promise<unknown>
) {
  mock.method(SettingsRepository, 'getAll', async () => []);
  mock.method(SettingsRepository, 'getVersion', async () => 0);
  await settingsStore.initialise();
  const dataset = IdMappingDataset.getInstance();
  t.mock.method(dataset, 'resolve', () => ({}));
  const database = AnimeDatabase.getInstance();
  t.mock.method(database, 'getEntryById', entry);
  t.mock.method(IMDBMetadata.prototype, 'getCinemetaData', videos);
}

function s21e1(): SegmentLookup {
  return {
    kind: 'episode',
    ids: { imdb: 'tt0388629' },
    season: 21,
    episode: 1,
  };
}

describe('fillIds', () => {
  test("counts through Cinemeta's list only for the providers that wait", async (t) => {
    let fetched = 0;
    await stub(
      t,
      async () => onePiece,
      async () => {
        fetched++;
        return {
          videos: [
            { season: 1, episode: 1 },
            { season: 1, episode: 2 },
            { season: 21, episode: 1 },
          ],
        };
      }
    );
    const lookup = s21e1();
    const resolution = await fillIds(lookup, ['aniskip', 'introdb']);
    assert.equal(lookup.ids.mal, '21');
    await resolution.animeEpisode;
    assert.equal(fetched, 1);
    assert.equal(lookup.animeEpisode, 3);
    assert.equal(resolution.animeEpisodeFailed, false);
  });

  test("lookups of one show at once share Cinemeta's list", async (t) => {
    let fetched = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await stub(
      t,
      async () => onePiece,
      async () => {
        fetched++;
        await gate;
        return { videos: [{ season: 21, episode: 1 }] };
      }
    );
    const first = await fillIds(s21e1(), ['aniskip']);
    const second = await fillIds(s21e1(), ['aniskip']);
    release();
    await Promise.all([first.animeEpisode, second.animeEpisode]);
    assert.equal(fetched, 1);
    // A settled fetch is not held, so a failure can be retried.
    const later = await fillIds(s21e1(), ['aniskip']);
    await later.animeEpisode;
    assert.equal(fetched, 2);
  });

  test('a failed episode list is not a miss', async (t) => {
    await stub(
      t,
      async () => onePiece,
      async () => {
        throw new Error('timeout');
      }
    );
    const lookup = s21e1();
    const resolution = await fillIds(lookup, ['aniskip']);
    await resolution.animeEpisode;
    assert.equal(lookup.animeEpisode, undefined);
    assert.equal(resolution.animeEpisodeFailed, true);
    assert.equal(resolution.idsFailed, false);
  });

  test('a failed anime database lookup is not a miss', async (t) => {
    await stub(
      t,
      async () => {
        throw new Error('db down');
      },
      async () => ({ videos: [] })
    );
    const lookup = s21e1();
    const resolution = await fillIds(lookup, ['aniskip']);
    assert.equal(lookup.ids.mal, undefined);
    assert.equal(resolution.idsFailed, true);
  });

  test('a database without the entry is a miss', async (t) => {
    await stub(
      t,
      async () => null,
      async () => ({ videos: [] })
    );
    const lookup = s21e1();
    const resolution = await fillIds(lookup, ['aniskip']);
    await resolution.animeEpisode;
    assert.equal(resolution.idsFailed, false);
    assert.equal(resolution.animeEpisodeFailed, false);
  });
});

describe('cacheKey', () => {
  const episode: SegmentLookup = {
    kind: 'episode',
    ids: { imdb: 'tt0903747' },
    season: 1,
    episode: 1,
  };

  test('keys a length-aware provider per 10 s step of the length asked', () => {
    const at = (durationMs?: number, runtimeMs?: number) =>
      cacheKey('aniskip', { ...episode, durationMs, runtimeMs });
    assert.equal(at(2839_000), at(2843_000));
    assert.notEqual(at(2839_000), at(2846_000));
    // A measured length and a listed runtime of the same value are asked differently.
    assert.notEqual(at(2840_000), at(undefined, 2840_000));
    assert.match(at(2839_000), /\|f2840000$/);
    assert.match(at(), /\|$/);
  });

  test('keeps the length out of other providers keys', () => {
    assert.equal(
      cacheKey('introdb', { ...episode, durationMs: 2839_000 }),
      cacheKey('introdb', episode)
    );
  });

  test('keys by ids, never by which one was stated', () => {
    assert.notEqual(
      cacheKey('introdb', episode),
      cacheKey('introdb', { ...episode, season: 2 })
    );
    assert.notEqual(
      cacheKey('introdb', episode),
      cacheKey('introdb', { ...episode, ids: { tmdb: '1396' } })
    );
  });
});
