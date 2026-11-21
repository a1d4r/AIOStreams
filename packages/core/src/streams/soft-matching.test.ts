import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import StreamFilterer from './filterer.js';
import StreamSorter from './sorter.js';
import StreamLimiter from './limiter.js';
import StreamDeduplicator from './deduplicator.js';
import FileParser from '../parser/file.js';
import { StremioTransformer } from '../transformers/stremio.js';
import { IdParser } from '../utils/index.js';
import type { ParsedStream, Unconfirmed, UserData } from '../db/schemas.js';

function makeStream(
  filename: string,
  extra: Partial<ParsedStream> = {}
): ParsedStream {
  return {
    id: Math.random().toString(),
    type: 'p2p',
    filename,
    parsedFile: FileParser.parse(filename),
    addon: {
      instanceId: 'text-search',
      name: 'Text Search',
      resultPassthrough: false,
      preset: { id: 'text-search' },
    },
    ...extra,
  } as unknown as ParsedStream;
}

const matching = {
  yearMatching: { enabled: true, addons: ['text-search'] },
  titleMatching: {
    enabled: true,
    mode: 'contains',
    similarityThreshold: 0.75,
    addons: ['text-search'],
  },
  seasonEpisodeMatching: { enabled: true },
};

function makeFilterer(softMatching: boolean) {
  return new StreamFilterer({
    uuid: 'test',
    ...matching,
    softMatching: { enabled: softMatching },
  } as unknown as UserData);
}

const film = {
  title: 'Film',
  titles: [{ title: 'Film' }],
  year: 2011,
};
const show = {
  title: 'Show',
  titles: [{ title: 'Show' }],
  year: 2022,
  yearEnd: 2024,
};

function context(
  type: 'movie' | 'series',
  metadata: Record<string, unknown>
): any {
  const id = type === 'movie' ? 'tt0000001' : 'tt0000002:1:1';
  return {
    type,
    id,
    parsedId: IdParser.parse(id, type),
    isAnime: false,
    queryType: type,
    getPermittedPatterns: async () => ({
      permitted: new Set(),
      unrestricted: true,
    }),
    getMetadata: async () => metadata,
    getReleaseDates: async () => undefined,
    getEpisodeAirDate: async () => undefined,
    getEpisodeRuntime: async () => undefined,
    getSeaDex: async () => undefined,
    toExpressionContext: () => ({ type, id }),
  };
}

async function filterFilm(filterer: StreamFilterer, streams: ParsedStream[]) {
  return filterer.filter(streams, context('movie', film));
}

describe('soft matching in the filterer', () => {
  it('removes year and title mismatches when it is off', async () => {
    const filterer = makeFilterer(false);
    const kept = await filterFilm(filterer, [
      makeStream('Film (2011) WEB-DL 2160p'),
      makeStream('Film (2006) WEB-DL 2160p'),
      makeStream('Other Story (2011) WEB-DL 2160p'),
    ]);
    assert.deepEqual(
      kept.map((s) => s.filename),
      ['Film (2011) WEB-DL 2160p']
    );
    assert.equal(kept[0].unconfirmed, undefined);
    const { removed, included } = filterer.getFilterStatistics();
    assert.equal(removed.yearMatching.total, 1);
    assert.equal(removed.titleMatching.total, 1);
    assert.equal(included.unconfirmed.total, 0);
  });

  it('keeps a year mismatch with both years', async () => {
    const filterer = makeFilterer(true);
    const kept = await filterFilm(filterer, [
      makeStream('Film (2011) WEB-DL 2160p'),
      makeStream('Film (2006) WEB-DL 2160p'),
    ]);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].unconfirmed, undefined);
    assert.deepEqual(kept[1].unconfirmed, {
      reason: 'year',
      releaseYear: 2006,
      titleYear: 2011,
    });
    const { removed, included } = filterer.getFilterStatistics();
    assert.equal(removed.yearMatching.total, 0);
    assert.equal(included.unconfirmed.total, 1);
    assert.deepEqual(included.unconfirmed.details, { year: 1 });
  });

  it("gives a series' range of years", async () => {
    const kept = await makeFilterer(true).filter(
      [makeStream('Show (2014) S01E01 WEB-DL 1080p')],
      context('series', show)
    );
    assert.deepEqual(kept[0]?.unconfirmed, {
      reason: 'year',
      releaseYear: 2014,
      titleYear: 2022,
      titleYearEnd: 2024,
    });
  });

  it('keeps a title mismatch', async () => {
    const kept = await filterFilm(makeFilterer(true), [
      makeStream('Other Story (2011) WEB-DL 2160p'),
    ]);
    assert.deepEqual(kept[0]?.unconfirmed, { reason: 'title' });
  });

  it('names the first check failed: the year before the title', async () => {
    const kept = await filterFilm(makeFilterer(true), [
      makeStream('Other Story (2006) WEB-DL 2160p'),
    ]);
    assert.equal(kept[0]?.unconfirmed?.reason, 'year');
  });

  it("keeps a built-in addon's reason", async () => {
    const date: Unconfirmed = {
      reason: 'date',
      releaseDate: '2006-05-01',
      titleDate: '2011-06-01',
    };
    const kept = await filterFilm(makeFilterer(true), [
      makeStream('Film (2006) WEB-DL 2160p', { unconfirmed: date }),
    ]);
    assert.deepEqual(kept[0]?.unconfirmed, date);
  });

  it('still removes what other checks remove', async () => {
    const filterer = makeFilterer(true);
    const kept = await filterFilm(filterer, [
      // a season under a movie: a show of another year
      makeStream('Film.2006.S01.2160p.WEB-DL'),
      // a collection of three films
      makeStream('Film 1-3 (2004-2006) BDRip 1080p'),
    ]);
    assert.deepEqual(kept, []);
    const { removed, included } = filterer.getFilterStatistics();
    assert.equal(removed.seasonEpisodeMatching.total, 2);
    assert.equal(included.unconfirmed.total, 0);
  });

  it('leaves the addons year matching is not set for', async () => {
    const kept = await filterFilm(makeFilterer(true), [
      makeStream('Film (2006) WEB-DL 2160p', {
        addon: {
          instanceId: 'by-id',
          name: 'By ID',
          resultPassthrough: false,
          preset: { id: 'by-id' },
        },
      } as Partial<ParsedStream>),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].unconfirmed, undefined);
  });
});
