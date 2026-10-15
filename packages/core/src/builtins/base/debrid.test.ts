import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the builtins' dependency graph.
import '../../index.js';
import { BaseDebridAddon, type SearchMetadata } from './debrid.js';
import StreamParser from '../../parser/streams.js';
import { BuiltinStreamParser } from '../../presets/builtin.js';
import type { Addon } from '../../db/schemas.js';
import type { Stream, ParsedStream } from '../../db/schemas.js';
import type {
  TorrentWithSelectedFile,
  NZBWithSelectedFile,
} from '../../debrid/utils.js';
import type { ParsedId } from '../../utils/id-parser.js';
import { deduplicateTitles } from '../../metadata/utils.js';
import { settingsStore } from '../../config/index.js';
import { SettingsRepository } from '../../db/repositories/settings.js';

type SelectedFile = TorrentWithSelectedFile | NZBWithSelectedFile;

// Exercise stream creation and parsing without starting addon searches.
const addon = Object.assign(Object.create(BaseDebridAddon.prototype), {
  name: 'Test',
  userData: {},
}) as {
  _createStream: (
    result: SelectedFile,
    metadataId: string,
    encryptedStoreAuths: {}
  ) => Stream;
};
const parser = Object.create(StreamParser.prototype) as {
  getSeeders: (stream: Stream, parsed: ParsedStream) => number | undefined;
};

function makeTorrent(): TorrentWithSelectedFile {
  return {
    type: 'torrent',
    title: 'Test.1080p.WEB-DL',
    hash: '0'.repeat(40),
    sources: [],
    size: 1024,
    file: { index: 0, name: 'Test.1080p.WEB-DL.mkv', size: 1024 },
  };
}

function assertSeeders(result: SelectedFile, expected: number | undefined) {
  const stream = addon._createStream(result, 'tt0000001', {});
  assert.equal(parser.getSeeders(stream, {} as ParsedStream), expected);
  if (expected === undefined) {
    assert.doesNotMatch(stream.description ?? '', /👤/u);
  } else {
    assert.ok(stream.description?.includes(`👤 ${expected}`));
  }
}

describe('BaseDebridAddon seeder metadata', () => {
  it('preserves an explicitly reported zero through stream parsing', () => {
    assertSeeders({ ...makeTorrent(), seeders: 0 }, 0);
  });

  it('preserves a positive seeder count through stream parsing', () => {
    assertSeeders({ ...makeTorrent(), seeders: 42 }, 42);
  });

  it('does not invent a zero when the seeder property is absent', () => {
    assertSeeders(makeTorrent(), undefined);
  });

  it('omits an explicitly undefined seeder count', () => {
    assertSeeders({ ...makeTorrent(), seeders: undefined }, undefined);
  });

  it('does not add seeder metadata to a Usenet result without it', () => {
    assertSeeders(
      {
        type: 'usenet',
        title: 'Test.1080p.WEB-DL',
        hash: '0'.repeat(40),
        nzb: 'https://example.com/test.nzb',
        size: 1024,
        file: { index: 0, name: 'Test.1080p.WEB-DL.mkv', size: 1024 },
      },
      undefined
    );
  });
});

describe('BaseDebridAddon P2P streams', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  const builtinParser = new BuiltinStreamParser({} as Addon) as unknown as {
    getStreamType: (
      stream: Stream,
      service: ParsedStream['service'],
      parsed: ParsedStream
    ) => ParsedStream['type'];
  };
  const torrent: TorrentWithSelectedFile = {
    ...makeTorrent(),
    sources: ['udp://tracker.example:80/announce'],
    file: { name: 'Test.1080p.WEB-DL', size: 1024 },
  };

  it('returns a torrent without a service as a P2P stream', () => {
    const stream = addon._createStream(torrent, 'tt0000001', {});
    assert.equal(stream.url, undefined);
    assert.equal(stream.infoHash, torrent.hash);
    assert.equal(stream.fileIdx, undefined);
    assert.deepEqual(stream.sources, [
      'tracker:udp://tracker.example:80/announce',
      `dht:${torrent.hash}`,
    ]);
    assert.match(stream.name ?? '', /^\[P2P\] Test /);
    assert.equal(
      builtinParser.getStreamType(stream, undefined, {} as ParsedStream),
      'p2p'
    );
  });

  it('lists each P2P source once, in order', () => {
    const stream = addon._createStream(
      {
        ...torrent,
        sources: [
          'udp://tracker.example:80/announce',
          'udp://other.example:80/announce',
          'udp://tracker.example:80/announce',
        ],
      },
      'tt0000001',
      {}
    );
    assert.deepEqual(stream.sources, [
      'tracker:udp://tracker.example:80/announce',
      'tracker:udp://other.example:80/announce',
      `dht:${torrent.hash}`,
    ]);
  });

  it('keeps a debrid stream without sources', () => {
    const stream = addon._createStream(
      {
        ...torrent,
        service: { id: 'torbox', cached: true, library: false },
      },
      'tt0000001',
      { torbox: 'auth' }
    );
    assert.ok(stream.url);
    assert.equal(stream.sources, undefined);
    assert.match(stream.name ?? '', /^\[TB ⚡\] Test /);
    assert.equal(
      builtinParser.getStreamType(stream, undefined, {} as ParsedStream),
      'debrid'
    );
  });
});

describe('BaseDebridAddon title language queries', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  const queryBuilder = Object.create(BaseDebridAddon.prototype) as {
    buildQueries: (
      parsedId: ParsedId,
      metadata: SearchMetadata,
      options: { titleLanguages: string[] }
    ) => string[];
  };
  // TMDB's ru translation and BG alternative title share the Cyrillic name.
  const titlesWithLang = deduplicateTitles([
    { title: 'Pokémon Detective Pikachu', language: 'en' },
    { title: 'Покемон: Детектив Пикачу', language: 'ru' },
    { title: 'Покемон: Детектив Пикачу', language: 'bg' },
    { title: 'Покемон: Детектив Пікачу', language: 'uk' },
  ]);
  const metadata = {
    primaryTitle: 'pokemon detective pikachu',
    titles: titlesWithLang.map((t) => t.title),
    titlesWithLang,
    year: 2019,
  } as SearchMetadata;
  const queries = (spec: string) =>
    queryBuilder.buildQueries({ mediaType: 'movie' } as ParsedId, metadata, {
      titleLanguages: [spec],
    });

  it('finds a title that several languages share by each of them', () => {
    assert.deepEqual(queries('ru'), ['покемон детектив пикачу 2019']);
    assert.deepEqual(queries('bg'), ['покемон детектив пикачу 2019']);
  });

  it('finds a shared title by the original language', () => {
    assert.deepEqual(
      queryBuilder.buildQueries(
        { mediaType: 'movie' } as ParsedId,
        { ...metadata, originalLanguage: 'ru' },
        { titleLanguages: ['original'] }
      ),
      ['покемон детектив пикачу 2019']
    );
  });

  it('still finds a title only one language uses', () => {
    assert.deepEqual(queries('uk'), ['покемон детектив пікачу 2019']);
  });

  it('falls back to the primary title for a language with no title', () => {
    assert.deepEqual(queries('sr'), ['pokemon detective pikachu 2019']);
  });

  const setLatinOnly = async (value: boolean) => {
    mock.method(SettingsRepository, 'getAll', async () => [
      {
        key: 'builtins.scrape.latinQueriesOnly',
        value: JSON.stringify(value),
        updated_at: new Date(),
        updated_by: null,
      },
    ]);
    await settingsStore.reload({ emit: false });
  };

  it('takes a native-script title tagged with the language before a shared one', async () => {
    // The ru/uk shared Cyrillic title comes before the uk-only one.
    const titles = deduplicateTitles([
      { title: 'Pokémon Detective Pikachu', language: 'en' },
      { title: 'Покемон: Детектив Пикачу', language: 'ru' },
      { title: 'Покемон: Детектив Пикачу', language: 'uk' },
      { title: 'Покемон: Детектив Пікачу', language: 'uk' },
    ]);
    await setLatinOnly(false);
    assert.deepEqual(
      queryBuilder.buildQueries(
        { mediaType: 'movie' } as ParsedId,
        {
          ...metadata,
          titles: titles.map((t) => t.title),
          titlesWithLang: titles,
        },
        { titleLanguages: ['uk'] }
      ),
      ['покемон детектив пікачу 2019']
    );
    await setLatinOnly(true);
  });

  describe('a romanisation tagged with the original language', () => {
    // Merge order: the primary and IMDb's title come first, untagged; TMDB's
    // RU alternative "Brat 2" (a transliteration) then tags IMDb's copy ru.
    const brat2 = deduplicateTitles(
      [
        { title: 'Brother 2' },
        { title: 'Brat 2' },
        { title: 'Брат 2', language: 'ru', trusted: true },
        { title: 'Brat 2', language: 'ru', trusted: true },
        { title: 'Brother 2', language: 'en', trusted: true },
      ],
      'ru'
    );
    const brat2Metadata = {
      primaryTitle: 'brother 2',
      titles: brat2.map((t) => t.title),
      titlesWithLang: brat2,
      originalLanguage: 'ru',
      year: 2000,
    } as SearchMetadata;
    const brat2Queries = (spec: string) =>
      queryBuilder.buildQueries(
        { mediaType: 'movie' } as ParsedId,
        brat2Metadata,
        {
          titleLanguages: ['default', spec],
        }
      );
    it('keeps the first tagged title while queries are Latin-only', async () => {
      await setLatinOnly(true);
      assert.deepEqual(brat2Queries('ru'), ['brother 2 2000', 'brat 2 2000']);
    });

    it('takes the native-script title once non-Latin queries are allowed', async () => {
      await setLatinOnly(false);
      assert.deepEqual(brat2Queries('ru'), ['brother 2 2000', 'брат 2 2000']);
      assert.deepEqual(brat2Queries('original'), [
        'brother 2 2000',
        'брат 2 2000',
      ]);
      // a Latin-script language is unaffected
      assert.deepEqual(brat2Queries('en'), ['brother 2 2000']);
      await setLatinOnly(true);
    });
  });
});
