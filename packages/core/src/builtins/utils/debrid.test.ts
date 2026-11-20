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
