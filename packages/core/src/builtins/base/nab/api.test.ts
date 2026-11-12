import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import '../../torznab/addon.js';
import { createLogger } from '../../../utils/index.js';
import { settingsStore } from '../../../config/index.js';
import { SettingsRepository } from '../../../db/repositories/settings.js';
import {
  BaseNabApi,
  extractTorznabInfoHash,
  TorznabSearchResultItem,
} from './api.js';
import { NabScanner, type NabScanProfile } from './scan.js';

const VALID_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Base32 BTIH encoding of VALID_HASH, per BEP 3. */
const VALID_HASH_BASE32 = 'VKVKVKVKVKVKVKVKVKVKVKVKVKVKVKVK';

function makeResult(overrides: {
  infohash?: string;
  magneturl?: string;
  enclosure?: { url: string; type: string }[];
}): TorznabSearchResultItem {
  return {
    title: 'Test.Release.1080p',
    link: undefined,
    guid: 'guid-1',
    pubDate: new Date().toUTCString(),
    prowlarrindexer: undefined,
    jackettindexer: undefined,
    type: undefined,
    size: undefined,
    enclosure: (overrides.enclosure ?? []).map((e) => ({
      url: e.url,
      type: e.type,
      length: 0,
    })),
    torznab: {
      infohash: overrides.infohash,
      magneturl: overrides.magneturl,
    },
  };
}

describe('extractTorznabInfoHash', () => {
  it('returns a valid infohash attr directly', () => {
    const result = makeResult({ infohash: VALID_HASH });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('lowercases an uppercase infohash', () => {
    const result = makeResult({ infohash: VALID_HASH.toUpperCase() });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('falls back to magneturl when infohash is present but invalid', () => {
    const result = makeResult({
      infohash: 'not-a-real-hash',
      magneturl: `magnet:?xt=urn:btih:${VALID_HASH}&dn=test`,
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('falls back to a magnet enclosure when infohash and magneturl are both absent', () => {
    const result = makeResult({
      enclosure: [
        {
          url: `magnet:?xt=urn:btih:${VALID_HASH}&dn=test`,
          type: 'application/x-bittorrent',
        },
      ],
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('accepts the magnet-specific enclosure type from the torznab torrent-support spec', () => {
    const result = makeResult({
      enclosure: [
        {
          url: `magnet:?xt=urn:btih:${VALID_HASH}&dn=test`,
          type: 'application/x-bittorrent;x-scheme-handler/magnet',
        },
      ],
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('uses a later magnet enclosure when the first hash is invalid', () => {
    const result = makeResult({
      enclosure: [
        {
          url: 'magnet:?xt=urn:btih:not-a-real-hash',
          type: 'application/x-bittorrent',
        },
        {
          url: `magnet:?xt=urn:btih:${VALID_HASH}&dn=test`,
          type: 'application/x-bittorrent',
        },
      ],
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('ignores a non-magnet .torrent enclosure', () => {
    const result = makeResult({
      enclosure: [
        {
          url: 'https://example.com/download.torrent',
          type: 'application/x-bittorrent',
        },
      ],
    });
    assert.equal(extractTorznabInfoHash(result), undefined);
  });

  it('returns undefined when nothing usable is present', () => {
    assert.equal(extractTorznabInfoHash(makeResult({})), undefined);
  });

  it('converts a base32 infohash attr to canonical hex', () => {
    const result = makeResult({ infohash: VALID_HASH_BASE32 });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('converts a base32 BTIH in magneturl to canonical hex', () => {
    const result = makeResult({
      magneturl: `magnet:?xt=urn:btih:${VALID_HASH_BASE32}&dn=test`,
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });

  it('converts a base32 BTIH in a magnet enclosure to canonical hex', () => {
    const result = makeResult({
      enclosure: [
        {
          url: `magnet:?xt=urn:btih:${VALID_HASH_BASE32}&dn=test`,
          type: 'application/x-bittorrent',
        },
      ],
    });
    assert.equal(extractTorznabInfoHash(result), VALID_HASH);
  });
});

describe('Torznab scan profile', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  // Trimmed from a JacRed response: <comments> sits between <link> and <pubDate>.
  const body = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
<item>
<title>Venom (2018) HDRip</title>
<guid>http://rutor.info/torrent/669136</guid>
<link>magnet:?xt=urn:btih:${VALID_HASH}</link>
<comments>http://rutor.info/torrent/669136/venom_venom-2018-hdrip</comments>
<pubDate>Sat, 01 Dec 2018 00:00:00 +0000</pubDate>
<torznab:attr name="seeders" value="12" />
</item>
</channel>
</rss>`);

  it('reads <comments>', async () => {
    const api = new BaseNabApi(
      'torznab',
      createLogger('test'),
      'https://jacred.example'
    );
    const { profile } = api as unknown as { profile: NabScanProfile };
    const document = await new NabScanner(body).scanSearch(profile);
    assert.equal(document.kind, 'search');
    assert.equal(
      document.kind === 'search' ? document.results[0].comments : undefined,
      'http://rutor.info/torrent/669136/venom_venom-2018-hdrip'
    );
  });
});
