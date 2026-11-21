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

const year: Unconfirmed = {
  reason: 'year',
  releaseYear: 2006,
  titleYear: 2011,
};

describe('unconfirmed results in the order', () => {
  it('go after all others and are limited first', async () => {
    const userData = {
      sortCriteria: { global: [] },
      resultLimits: { global: 4 },
    } as unknown as UserData;
    const streams = [
      makeStream('Film (2006) A', { unconfirmed: year }),
      makeStream('Film (2011) B'),
      makeStream('Film (2006) C', { unconfirmed: year }),
      makeStream('Film (2006) D', { unconfirmed: year }),
      makeStream('Film (2011) E'),
      makeStream('Film (2006) F', { unconfirmed: year }),
      makeStream('Film (2011) G'),
      makeStream('Film (2006) H', { unconfirmed: year }),
    ];
    const sorted = await new StreamSorter(userData).sort(streams, {
      type: 'movie',
      isAnime: false,
    } as any);
    const limited = await new StreamLimiter(userData).limit(sorted);
    assert.deepEqual(
      limited.map((s) => s.filename),
      ['Film (2011) B', 'Film (2011) E', 'Film (2011) G', 'Film (2006) A']
    );
  });
});

describe('unconfirmed copies in the deduplicator', () => {
  const textSearch = makeStream('').addon;
  const byId = {
    instanceId: 'by-id',
    name: 'By ID',
    resultPassthrough: false,
    preset: { id: 'by-id' },
  } as ParsedStream['addon'];
  // the text search first: it wins a tie of everything else
  const presets = [{ instanceId: 'text-search' }, { instanceId: 'by-id' }];

  function dedup(
    deduplicator: Record<string, unknown>,
    streams: ParsedStream[]
  ) {
    return new StreamDeduplicator({
      deduplicator: { enabled: true, keys: ['filename'], ...deduplicator },
      presets,
      services: [
        { id: 'realdebrid', enabled: true },
        { id: 'torbox', enabled: true },
      ],
    } as unknown as UserData).deduplicate(streams);
  }

  // The confirmed results come out as without soft matching, where the
  // filterer would have removed the unconfirmed ones.
  async function assertMainListUnchanged(
    deduplicator: Record<string, unknown>,
    make: () => ParsedStream[]
  ) {
    const on = await dedup(deduplicator, make());
    const off = await dedup(
      deduplicator,
      make().filter((s) => !s.unconfirmed)
    );
    assert.deepEqual(
      on.filter((s) => !s.unconfirmed),
      off
    );
    return on;
  }

  const stream = (
    id: string,
    filename: string,
    extra: Partial<ParsedStream> = {}
  ) => makeStream(filename, { id, ...extra });

  it('keep the confirmed copy of a release: single_result', async () => {
    const kept = await assertMainListUnchanged({ p2p: 'single_result' }, () => [
      stream('a', 'Film.2006.2160p.WEB-DL.mkv', { unconfirmed: year }),
      stream('b', 'Film.2006.2160p.WEB-DL.mkv', { addon: byId }),
    ]);
    assert.deepEqual(
      kept.map((s) => s.id),
      ['b']
    );
  });

  it('keep the confirmed copy of a release: per_addon', async () => {
    const kept = await assertMainListUnchanged({ p2p: 'per_addon' }, () => [
      stream('a', 'Film.2006.2160p.WEB-DL.mkv', { unconfirmed: year }),
      stream('b', 'Film.2006.2160p.WEB-DL.mkv', { addon: byId }),
    ]);
    assert.deepEqual(
      kept.map((s) => s.id),
      ['b']
    );
  });

  it('keep the confirmed copy of a release: per_service', async () => {
    const debrid = (service: string) =>
      ({
        type: 'debrid',
        service: { id: service, cached: true },
      }) as Partial<ParsedStream>;
    const kept = await assertMainListUnchanged(
      { cached: 'per_service' },
      () => [
        stream('a', 'Film.2006.2160p.WEB-DL.mkv', {
          ...debrid('realdebrid'),
          unconfirmed: year,
        }),
        stream('b', 'Film.2006.2160p.WEB-DL.mkv', {
          ...debrid('realdebrid'),
          addon: byId,
        }),
        stream('c', 'Film.2006.2160p.WEB-DL.mkv', {
          ...debrid('torbox'),
          unconfirmed: year,
        }),
      ]
    );
    assert.deepEqual(
      kept.map((s) => s.id),
      ['b']
    );
  });

  it('keep the confirmed copy by size and tags, not a namesake', async () => {
    const size = 20 * 1024 ** 3;
    const kept = await assertMainListUnchanged(
      { keys: ['smartDetect'], p2p: 'single_result' },
      () => [
        stream('a', 'Other.Film.2011.2160p.WEB-DL.mkv', {
          size,
          unconfirmed: { reason: 'title' },
        }),
        stream('b', 'Film.2011.2160p.WEB-DL.mkv', { size, addon: byId }),
      ]
    );
    assert.deepEqual(
      kept.map((s) => s.id),
      ['b']
    );
  });

  it('do not join confirmed results that are not copies', async () => {
    const size = 20 * 1024 ** 3;
    // the unconfirmed copy shares the name with one, size and tags with the other
    const kept = await assertMainListUnchanged(
      { keys: ['filename', 'smartDetect'], p2p: 'single_result' },
      () => [
        stream('a', 'Film.2011.1080p.WEB-DL.mkv', { size: size / 4 }),
        stream('b', 'Film.2011.1080p.WEB-DL.mkv', {
          size,
          unconfirmed: year,
        }),
        stream('c', 'Film.2011.1080p.WEB-DL.Repack.mkv', {
          size,
          addon: byId,
        }),
      ]
    );
    assert.deepEqual(kept.map((s) => s.id).sort(), ['a', 'c']);
  });

  it('stay unconfirmed when no copy confirms them', async () => {
    const kept = await dedup({ p2p: 'single_result' }, [
      stream('a', 'Film.2006.2160p.WEB-DL.mkv', { unconfirmed: year }),
      stream('b', 'Film.2006.2160p.WEB-DL.mkv', {
        addon: byId,
        unconfirmed: { reason: 'title' },
      }),
    ]);
    assert.equal(kept.length, 1);
    assert.ok(kept[0].unconfirmed);
  });

  it('stay out of the main list when filtered again', async () => {
    const make = () => [
      stream('a', 'Film (2006) WEB-DL 2160p'),
      stream('b', 'Film (2006) WEB-DL 2160p', { addon: byId }),
      stream('c', 'Film (2005) BDRip 1080p'),
    ];
    // a request filters and deduplicates twice: by addon, then all results
    const run = async (softMatching: boolean) => {
      const filterer = makeFilterer(softMatching);
      let streams = make();
      for (let pass = 0; pass < 2; pass++) {
        streams = await filterFilm(filterer, streams);
        streams = await dedup({ p2p: 'single_result' }, streams);
      }
      return { streams, statistics: filterer.getFilterStatistics() };
    };
    const on = await run(true);
    const off = await run(false);
    assert.deepEqual(
      on.streams.filter((s) => !s.unconfirmed),
      off.streams
    );
    assert.deepEqual(
      on.streams.map((s) => [s.id, s.unconfirmed?.reason]),
      [
        ['b', undefined],
        ['c', 'year'],
      ]
    );
    // each unconfirmed result counted once
    assert.deepEqual(on.statistics.included.unconfirmed.details, { year: 2 });
  });
});

describe('unconfirmed results in the response', () => {
  it('copies the mark to streamData, and no key without it', async () => {
    const userData = {
      formatter: { id: 'torrentio' },
      presets: [],
      services: [],
    } as unknown as UserData;
    const response = await new StremioTransformer(userData).transformStreams(
      {
        success: true,
        data: {
          streams: [
            makeStream('Film (2011) WEB-DL 2160p'),
            makeStream('Film (2006) WEB-DL 2160p', { unconfirmed: year }),
          ],
          statistics: [],
        },
        errors: [],
      },
      { userData },
      { provideStreamData: true, disableAutoplay: true }
    );
    const [confirmed, unconfirmed] = JSON.parse(
      JSON.stringify(response)
    ).streams;
    assert.equal('unconfirmed' in confirmed.streamData, false);
    assert.deepEqual(unconfirmed.streamData.unconfirmed, year);
  });

  it('gives the formatter the reason', async () => {
    const userData = {
      formatter: {
        id: 'custom',
        definitions: {
          custom: {
            name: '{stream.unconfirmed::exists["? "||""]}{stream.unconfirmed}',
            description: '',
          },
        },
      },
      presets: [],
      services: [],
    } as unknown as UserData;
    const response = await new StremioTransformer(userData).transformStreams(
      {
        success: true,
        data: {
          streams: [
            makeStream('Film (2011) WEB-DL 2160p'),
            makeStream('Film (2006) WEB-DL 2160p', { unconfirmed: year }),
          ],
          statistics: [],
        },
        errors: [],
      },
      { userData },
      { provideStreamData: false, disableAutoplay: true }
    );
    assert.deepEqual(
      response.streams.map((s) => s.name),
      ['', '? year']
    );
  });
});
