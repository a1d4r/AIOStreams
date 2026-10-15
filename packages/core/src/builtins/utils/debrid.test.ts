import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the builtins' dependency graph.
import '../../index.js';
import { processTorrentsForP2P } from './debrid.js';
import type { Torrent, TitleMetadata } from '../../debrid/index.js';

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
