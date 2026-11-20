import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// Load the core entry point first; the metadata sources import each other.
import '../index.js';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import { AnimeDatabase } from '../anime-database/database.js';
import { IdParser } from '../utils/id-parser.js';
import type { Meta } from '../db/schemas.js';
import { TMDBMetadata } from './tmdb.js';
import { IMDBMetadata } from './imdb.js';
import { MOVIE_CINEMETA_GRACE_MS, MetadataService } from './service.js';

const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe('MetadataService.getMetadata', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  function mockSources(tmdb: unknown, cinemetaMs: number) {
    mock.method(AnimeDatabase.prototype, 'getEntryById', async () => null);
    mock.method(TMDBMetadata.prototype, 'getMetadata', async () => tmdb);
    mock.method(IMDBMetadata.prototype, 'getCinemetaData', () =>
      after(cinemetaMs, {
        id: 'tt0000001',
        type: 'movie',
        name: 'Cinemeta Film',
        releaseInfo: '2001',
      } as Meta)
    );
    mock.method(IMDBMetadata.prototype, 'getImdbSuggestionData', async () => {
      throw new Error('not found');
    });
  }

  // a distinct id per test: the metadata lock shares a result for 12 s
  const movie = (id: string) => IdParser.parse(id, 'movie')!;
  const service = () => new MetadataService({ tmdbAccessToken: 'token' });

  it("doesn't wait for a slow Cinemeta once TMDB has answered", async () => {
    mockSources(
      { title: 'TMDB Film', titles: [{ title: 'TMDB Film' }], year: 2001 },
      5000
    );
    const start = Date.now();
    const metadata = await service().getMetadata(movie('tt0000001'), 'movie');
    assert.ok(Date.now() - start < MOVIE_CINEMETA_GRACE_MS + 1000);
    assert.equal(metadata.title, 'TMDB Film');
    assert.equal(metadata.year, 2001);
  });

  it('still uses a Cinemeta answer inside the grace period', async () => {
    mockSources(
      { title: 'TMDB Film', titles: [{ title: 'TMDB Film' }], year: 2001 },
      50
    );
    const metadata = await service().getMetadata(movie('tt0000002'), 'movie');
    assert.ok(metadata.titles.some((t) => t.title === 'Cinemeta Film'));
  });

  it('waits for Cinemeta when TMDB has no year', async () => {
    mockSources(
      { title: 'TMDB Film', titles: [{ title: 'TMDB Film' }], year: NaN },
      MOVIE_CINEMETA_GRACE_MS + 300
    );
    const metadata = await service().getMetadata(movie('tt0000004'), 'movie');
    assert.equal(metadata.year, 2001);
  });

  it('waits for Cinemeta when TMDB has nothing', async () => {
    mockSources(undefined, MOVIE_CINEMETA_GRACE_MS + 300);
    const metadata = await service().getMetadata(movie('tt0000003'), 'movie');
    assert.equal(metadata.title, 'Cinemeta Film');
    assert.equal(metadata.year, 2001);
  });
});
