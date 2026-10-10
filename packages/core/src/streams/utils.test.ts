import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shareCacheStatus } from './utils.js';
import type { ParsedStream } from '../db/schemas.js';

function makeStream(
  infoHash: string | undefined,
  service?: { id: string; cached: boolean },
  type: ParsedStream['type'] = 'debrid'
): ParsedStream {
  return {
    id: Math.random().toString(),
    type,
    torrent: infoHash ? { infoHash } : undefined,
    service: service ? { ...service } : undefined,
    addon: {
      instanceId: 'test-instance',
      resultPassthrough: false,
      preset: { id: 'test-preset' },
    },
  } as unknown as ParsedStream;
}

describe('shareCacheStatus', () => {
  it('marks every copy of a torrent cached on the same service', () => {
    const uncached = makeStream('abc', { id: 'realdebrid', cached: false });
    const cached = makeStream('abc', { id: 'realdebrid', cached: true });
    shareCacheStatus([uncached, cached]);
    assert.equal(uncached.service?.cached, true);
    assert.equal(cached.service?.cached, true);
  });

  it('flags only the copies it raised as shared', () => {
    const uncached = makeStream('abc', { id: 'realdebrid', cached: false });
    const cached = makeStream('abc', { id: 'realdebrid', cached: true });
    const tb = makeStream('abc', { id: 'torbox', cached: false });
    shareCacheStatus([uncached, cached, tb]);
    assert.equal(uncached.service?.cacheShared, true);
    assert.equal(cached.service?.cacheShared, undefined);
    assert.equal(tb.service?.cacheShared, undefined);
  });

  it('keeps the flags when run again', () => {
    const uncached = makeStream('abc', { id: 'realdebrid', cached: false });
    const cached = makeStream('abc', { id: 'realdebrid', cached: true });
    shareCacheStatus([uncached, cached]);
    shareCacheStatus([uncached, cached]);
    assert.equal(uncached.service?.cacheShared, true);
    assert.equal(cached.service?.cacheShared, undefined);
  });

  it('compares infoHashes case-insensitively', () => {
    const uncached = makeStream('ABC', { id: 'realdebrid', cached: false });
    const cached = makeStream('abc', { id: 'realdebrid', cached: true });
    shareCacheStatus([uncached, cached]);
    assert.equal(uncached.service?.cached, true);
  });

  it('does not share the status across services', () => {
    const tb = makeStream('abc', { id: 'torbox', cached: false });
    const rd = makeStream('abc', { id: 'realdebrid', cached: true });
    shareCacheStatus([tb, rd]);
    assert.equal(tb.service?.cached, false);
  });

  it('never marks a cached copy uncached', () => {
    const cached = makeStream('abc', { id: 'realdebrid', cached: true });
    const uncached = makeStream('abc', { id: 'realdebrid', cached: false });
    shareCacheStatus([cached, uncached]);
    assert.equal(cached.service?.cached, true);
  });

  it('leaves other torrents and streams without a service or infoHash alone', () => {
    const other = makeStream('def', { id: 'realdebrid', cached: false });
    const noHash = makeStream(undefined, { id: 'realdebrid', cached: false });
    const p2p = makeStream('abc', undefined, 'p2p');
    const usenet = makeStream(
      'abc',
      { id: 'realdebrid', cached: false },
      'usenet'
    );
    shareCacheStatus([
      makeStream('abc', { id: 'realdebrid', cached: true }),
      other,
      noHash,
      p2p,
      usenet,
    ]);
    assert.equal(other.service?.cached, false);
    assert.equal(noHash.service?.cached, false);
    assert.equal(p2p.service, undefined);
    assert.equal(usenet.service?.cached, false);
  });
});
