import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the builtins' dependency graph.
import '../../index.js';
import { settingsStore } from '../../config/index.js';
import { SettingsRepository } from '../../db/repositories/settings.js';
import { StremThruService } from '../../debrid/stremthru.js';
import { processTorrents, processTorrentsForP2P } from './debrid.js';
import type {
  DebridDownload,
  Torrent,
  TitleMetadata,
} from '../../debrid/index.js';

function makeTorrent(title: string, extra: Partial<Torrent> = {}): Torrent {
  return {
    type: 'torrent',
    title,
    hash: '0'.repeat(40),
    sources: ['udp://tracker.example:80/announce'],
    size: 4096,
    ...extra,
  };
}

const series: TitleMetadata = {
  titles: ['Game of Thrones'],
  year: 2011,
  season: 2,
  episode: 3,
};

describe('processTorrentsForP2P', () => {
  it('keeps a torrent without a file list as the whole torrent', async () => {
    const torrent = makeTorrent('Game.of.Thrones.S02.1080p.BluRay', {
      confirmed: true,
    });
    const [result] = await processTorrentsForP2P([torrent], series);
    assert.equal(result.hash, torrent.hash);
    assert.deepEqual(result.sources, torrent.sources);
    assert.deepEqual(result.file, { name: torrent.title, size: torrent.size });
  });

  it('keeps an ID-matched torrent whatever its title', async () => {
    const results = await processTorrentsForP2P(
      [makeTorrent('Игра престолов (2 сезон)', { confirmed: true })],
      series
    );
    assert.equal(results.length, 1);
  });

  it('drops a torrent of another season', async () => {
    const results = await processTorrentsForP2P(
      [makeTorrent('Game.of.Thrones.S05E03.1080p', { confirmed: true })],
      series
    );
    assert.equal(results.length, 0);
  });

  it('drops a torrent of another title found by a text search', async () => {
    const results = await processTorrentsForP2P(
      [makeTorrent('House.of.the.Dragon.S02E03.1080p')],
      series
    );
    assert.equal(results.length, 0);
  });

  describe('a namesake of the same year found by a text search', () => {
    // «Красота» (2026), TMDB en-US «Beauty»: «The Beauty» passes the title check.
    const krasota: TitleMetadata = {
      titles: ['Красота', 'Beauty'],
      year: 2026,
      season: 1,
      episode: 1,
      originalLanguage: 'ru',
      releaseDate: '2026-10-30',
    };
    const hoursAgo = (date: string) =>
      (Date.now() - Date.parse(date)) / 3_600_000;

    it('drops a release published long before the premiere', async () => {
      const results = await processTorrentsForP2P(
        [
          makeTorrent(
            'Красота / The Beauty / Сезон: 1 / Серии: 1-3 из 11 (2026)',
            {
              age: hoursAgo('2026-01-22'),
            }
          ),
        ],
        krasota
      );
      assert.equal(results.length, 0);
    });

    it('drops a translated release of a Russian-language title', async () => {
      const results = await processTorrentsForP2P(
        [makeTorrent('Красота / The Beauty (2026) S01E01 WEB-DL 1080p | ПМ')],
        krasota
      );
      assert.equal(results.length, 0);
    });

    it("keeps the title's own release", async () => {
      const results = await processTorrentsForP2P(
        [
          makeTorrent(
            'Красота (1 сезон: 1-3 серии из 8) / 2026 / РУ / WEB-DL (1080p)',
            {
              age: hoursAgo('2026-10-30'),
            }
          ),
        ],
        krasota
      );
      assert.equal(results.length, 1);
    });

    it('drops an early dubbed release without a Latin name (R3)', async () => {
      const results = await processTorrentsForP2P(
        [
          makeTorrent('Красота (2026) S01E01 WEB-DL | ПМ', {
            age: hoursAgo('2026-01-22'),
          }),
        ],
        krasota
      );
      assert.equal(results.length, 0);
    });

    it("keeps a Russian title's release older than TMDB's first date", async () => {
      // TMDB dates «Империя» by a rerun (04.11.2022); «Пётр I» aired in June
      const results = await processTorrentsForP2P(
        [
          makeTorrent(
            'Империя (Петр I) (1-4 серии из 4) / 2022 / РУ, СТ / DVB',
            { age: hoursAgo('2022-06-12') }
          ),
        ],
        {
          ...krasota,
          titles: ['Империя'],
          year: 2022,
          releaseDate: '2022-11-04',
        }
      );
      assert.equal(results.length, 1);
    });

    it('keeps an ID-matched release whatever its date and tags', async () => {
      const results = await processTorrentsForP2P(
        [
          makeTorrent('Красота / The Beauty (2026) S01E01 | ПМ', {
            confirmed: true,
            age: hoursAgo('2026-01-22'),
          }),
        ],
        krasota
      );
      assert.equal(results.length, 1);
    });
  });

  it('picks the episode file when the torrent lists its files', async () => {
    const files = [1, 2, 3].map((episode) => ({
      index: episode - 1,
      name: `Game.of.Thrones.S02E0${episode}.1080p.mkv`,
      size: 1000 + episode,
    }));
    const [result] = await processTorrentsForP2P(
      [makeTorrent('Game.of.Thrones.S02.1080p', { confirmed: true, files })],
      series
    );
    assert.equal(result.file.index, 2);
    assert.equal(result.file.name, 'Game.of.Thrones.S02E03.1080p.mkv');
  });
});

const hash = (c: string) => c.repeat(40);

function torrent(c: string, title?: string, confirmed?: boolean): Torrent {
  return {
    type: 'torrent',
    hash: hash(c),
    title,
    confirmed,
    size: 1_000_000_000,
    sources: [],
  };
}

const metadata = { titles: ['Show Name'], year: 2020, season: 2, episode: 3 };

describe('processTorrents', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  it('checks only the hashes that can pass validation', async () => {
    const names: Record<string, string> = {
      [hash('a')]: 'Show.Name.S02E03.1080p.WEB-DL',
      [hash('d')]: 'Show.Name.S02E03.720p.WEB-DL',
      [hash('e')]: 'Other.Name.S02E03.1080p.WEB-DL',
    };
    const checked: string[][] = [];
    mock.method(
      StremThruService.prototype,
      'checkMagnets',
      async (magnets: string[]): Promise<DebridDownload[]> => {
        checked.push(magnets);
        return magnets.map((h) => ({
          id: -1,
          hash: h,
          name: names[h],
          status: 'cached',
          size: 1_000_000_000,
          files: [{ name: `${names[h]}.mkv`, size: 1_000_000_000, index: 0 }],
        }));
      }
    );

    const { results, errors } = await processTorrents(
      [
        torrent('a', 'Show.Name.S02E03.1080p.WEB-DL'),
        torrent('b', 'Show.Name.S05E01.1080p.WEB-DL'), // another season
        torrent('c', 'Another.Film.2019.1080p.BluRay'), // another title
        torrent('d'), // untitled: passed to the check, as before
        torrent('e', 'Other.Name.S02E03.1080p.WEB-DL', true), // id-matched
      ],
      [{ id: 'realdebrid', credential: 'token' }],
      'tt0000001:2:3',
      metadata,
      undefined,
      false
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(checked, [[hash('a'), hash('d'), hash('e')]]);
    assert.deepEqual(
      results.map((r) => r.hash),
      [hash('a'), hash('d'), hash('e')]
    );
  });

  it('checks every hash without metadata', async () => {
    const checked: string[][] = [];
    mock.method(
      StremThruService.prototype,
      'checkMagnets',
      async (magnets: string[]): Promise<DebridDownload[]> => {
        checked.push(magnets);
        return [];
      }
    );

    await processTorrents(
      [
        torrent('a', 'Show.Name.S02E03.1080p.WEB-DL'),
        torrent('b', 'Another.Film.2019.1080p.BluRay'),
      ],
      [{ id: 'realdebrid', credential: 'token' }],
      'tt0000001:2:3',
      undefined,
      undefined,
      false
    );

    assert.deepEqual(checked, [[hash('a'), hash('b')]]);
  });
});

describe('soft matching of text search results', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  const movie: TitleMetadata = {
    titles: ['Film'],
    year: 2011,
    country: 'GB',
    releaseDate: '2011-06-01',
  };
  const show: TitleMetadata = {
    titles: ['Show'],
    year: 2022,
    season: 1,
    episode: 2,
  };
  // «Фильм» (2011), a Russian-language title
  const russian: TitleMetadata = {
    titles: ['Фильм', 'Film'],
    year: 2011,
    originalLanguage: 'ru',
  };
  const hoursAgo = (date: string) =>
    (Date.now() - Date.parse(date)) / 3_600_000;
  const p2p = async (
    torrents: Torrent[],
    metadata: TitleMetadata,
    softMatching = true
  ) =>
    (await processTorrentsForP2P(torrents, metadata, softMatching)).map(
      (r) => r.unconfirmed
    );

  it('drops what it marks when it is off', async () => {
    assert.deepEqual(
      await p2p(
        [
          makeTorrent('Other Story (2011) WEB-DL 2160p'),
          makeTorrent('Film (2006) WEB-DL 2160p', {
            age: hoursAgo('2006-05-01T12:00:00Z'),
          }),
        ],
        movie,
        false
      ),
      []
    );
  });

  it('marks another title', async () => {
    assert.deepEqual(
      await p2p([makeTorrent('Other Story (2011) WEB-DL 2160p')], movie),
      [{ reason: 'title' }]
    );
  });

  it("marks another country's version as another title", async () => {
    assert.deepEqual(
      await p2p([makeTorrent('Film US 2011 WEB-DL 2160p')], movie),
      [{ reason: 'title' }]
    );
  });

  it('marks a release older than the title with both dates', async () => {
    assert.deepEqual(
      await p2p(
        [
          makeTorrent('Film (2006) WEB-DL 2160p', {
            age: hoursAgo('2006-05-01T12:00:00Z'),
          }),
        ],
        movie
      ),
      [{ reason: 'date', releaseDate: '2006-05-01', titleDate: '2011-06-01' }]
    );
  });

  it('marks a translated release of a Russian-language title', async () => {
    assert.deepEqual(
      await p2p(
        [makeTorrent('Фильм / Film (2011) WEB-DL 1080p | ПМ')],
        russian
      ),
      [{ reason: 'dub' }]
    );
  });

  it('names the first check failed', async () => {
    assert.deepEqual(
      await p2p(
        [
          makeTorrent('Other Story (2006) WEB-DL 2160p', {
            age: hoursAgo('2006-05-01T12:00:00Z'),
          }),
        ],
        movie
      ),
      [{ reason: 'date', releaseDate: '2006-05-01', titleDate: '2011-06-01' }]
    );
  });

  it("marks another title of a series' episode", async () => {
    assert.deepEqual(
      await p2p([makeTorrent('Other.Story.S01E02.1080p.WEB-DL')], show),
      [{ reason: 'title' }]
    );
  });

  it('still drops another season or episode', async () => {
    assert.deepEqual(
      await p2p(
        [
          makeTorrent('Other.Story.S03E02.1080p.WEB-DL'),
          makeTorrent('Other.Story.S01E05.1080p.WEB-DL'),
        ],
        show
      ),
      []
    );
  });

  it('leaves an ID-matched release unmarked', async () => {
    assert.deepEqual(
      await p2p(
        [makeTorrent('Other Story (2011) WEB-DL 2160p', { confirmed: true })],
        movie
      ),
      [undefined]
    );
  });

  it('marks results checked with a debrid service', async () => {
    const names: Record<string, string> = {
      [hash('a')]: 'Film.2011.2160p.WEB-DL',
      [hash('b')]: 'Other.Story.2011.2160p.WEB-DL',
      [hash('c')]: 'Other.Story.S01E02.1080p.WEB-DL',
      [hash('d')]: 'Other.Story.S03E02.1080p.WEB-DL',
    };
    const checked: string[][] = [];
    mock.method(
      StremThruService.prototype,
      'checkMagnets',
      async (magnets: string[]): Promise<DebridDownload[]> => {
        checked.push(magnets);
        return magnets.map((h) => ({
          id: -1,
          hash: h,
          name: names[h],
          status: 'cached',
          size: 1_000_000_000,
          files: [{ name: `${names[h]}.mkv`, size: 1_000_000_000, index: 0 }],
        }));
      }
    );
    const debrid = async (torrents: Torrent[], metadata: TitleMetadata) =>
      (
        await processTorrents(
          torrents,
          [{ id: 'realdebrid', credential: 'token' }],
          'tt0000001',
          metadata,
          undefined,
          false,
          true
        )
      ).results.map((r) => [r.hash, r.unconfirmed]);

    assert.deepEqual(
      await debrid(
        [torrent('a', names[hash('a')]), torrent('b', names[hash('b')])],
        movie
      ),
      [
        [hash('a'), undefined],
        [hash('b'), { reason: 'title' }],
      ]
    );
    assert.deepEqual(
      await debrid(
        [torrent('c', names[hash('c')]), torrent('d', names[hash('d')])],
        show
      ),
      [[hash('c'), { reason: 'title' }]]
    );
    // another season is not even checked
    assert.deepEqual(checked, [[hash('a'), hash('b')], [hash('c')]]);
  });
});
