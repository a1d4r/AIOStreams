import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../index.js';
import { TorznabAddon } from './addon.js';
import type { UnprocessedTorrent } from '../../debrid/index.js';
import type { TorznabSearchResultItem } from '../base/nab/api.js';

const HASH = 'a'.repeat(40);

// Run the result mapping without a real search.
function mapResult(comments: string | undefined) {
  const result: TorznabSearchResultItem = {
    title: 'Venom.2018.HDRip',
    guid: 'guid-1',
    comments,
    enclosure: [],
    torznab: { infohash: HASH },
  };
  const addon = Object.assign(Object.create(TorznabAddon.prototype), {
    getSearchMetadata: async () => ({}),
    performSearch: async () => ({
      results: [result],
      meta: { searchType: 'query' },
    }),
  }) as { _searchTorrents: (id: unknown) => Promise<UnprocessedTorrent[]> };
  return addon._searchTorrents({});
}

describe('TorznabAddon info URL', () => {
  it('takes the release page from <comments>', async () => {
    const [torrent] = await mapResult(
      'http://rutor.info/torrent/669136/venom_venom-2018-hdrip'
    );
    assert.equal(torrent.hash, HASH);
    assert.equal(
      torrent.infoUrl,
      'http://rutor.info/torrent/669136/venom_venom-2018-hdrip'
    );
  });

  it('drops a <comments> value that is not an http(s) URL', async () => {
    const [torrent] = await mapResult('javascript:alert(1)');
    assert.equal(torrent.infoUrl, undefined);
  });

  it('leaves the info URL unset without <comments>', async () => {
    const [torrent] = await mapResult(undefined);
    assert.equal(torrent.infoUrl, undefined);
  });
});
