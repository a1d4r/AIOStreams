import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shareCacheStatus, shareFileInfo } from './utils.js';
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

describe('shareFileInfo', () => {
  const GB = 1024 ** 3;
  const PACK = 'Game of Thrones S01-S08 2160p UHD BluRay';
  const FILE = 'Game.of.Thrones.S01E01.2160p.UHD.BluRay.mkv';

  function makeCopy(
    infoHash: string,
    fileIdx: number | null | undefined,
    file: { filename?: string; size?: number; folderName?: string },
    type: ParsedStream['type'] = 'debrid'
  ): ParsedStream {
    const stream = makeStream(
      infoHash,
      type === 'debrid' ? { id: 'realdebrid', cached: true } : undefined,
      type
    );
    stream.torrent!.fileIdx = fileIdx;
    return Object.assign(stream, file);
  }

  it('gives a copy of a season pack without a file the known file', () => {
    const donor = makeCopy('abc', 5, { filename: FILE, size: 20 * GB });
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 2000 * GB });
    const noFileIdx = makeCopy('abc', undefined, {
      filename: PACK,
      size: 2000 * GB,
    });
    shareFileInfo([recipient, donor, noFileIdx]);
    for (const stream of [recipient, noFileIdx]) {
      assert.equal(stream.filename, FILE);
      assert.equal(stream.size, 20 * GB);
      assert.equal(stream.folderSize, 2000 * GB);
      assert.equal(stream.folderName, PACK);
      assert.equal(stream.torrent?.fileIdx, 5);
    }
    assert.equal(donor.filename, FILE);
    assert.equal(donor.folderSize, undefined);
  });

  it('keeps a folder name and size the copy already has', () => {
    const donor = makeCopy('abc', 5, { filename: FILE, size: 20 * GB });
    const recipient = makeCopy('abc', null, {
      filename: PACK,
      folderName: 'Season Folder',
      size: 2000 * GB,
    });
    recipient.folderSize = 2100 * GB;
    shareFileInfo([donor, recipient]);
    assert.equal(recipient.folderName, 'Season Folder');
    assert.equal(recipient.folderSize, 2100 * GB);
    assert.equal(recipient.size, 20 * GB);
  });

  it('changes nothing when the copies point to different files', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 2000 * GB });
    shareFileInfo([
      makeCopy('abc', 5, { filename: FILE, size: 20 * GB }),
      makeCopy('abc', 6, { filename: FILE, size: 21 * GB }),
      recipient,
    ]);
    assert.equal(recipient.filename, PACK);
    assert.equal(recipient.size, 2000 * GB);
    assert.equal(recipient.torrent?.fileIdx, -1);
  });

  it('changes nothing when the known file is larger', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 20 * GB });
    shareFileInfo([
      makeCopy('abc', 5, { filename: FILE, size: 21 * GB }),
      recipient,
    ]);
    assert.equal(recipient.filename, PACK);
    assert.equal(recipient.folderSize, undefined);
    assert.equal(recipient.torrent?.fileIdx, -1);
  });

  it('leaves a single-file movie as it is', () => {
    const movie = 'Movie.2010.2160p.mkv';
    const recipient = makeCopy('abc', -1, {
      filename: 'Movie 2010 2160p',
      size: 30 * GB + 1024,
    });
    shareFileInfo([
      makeCopy('abc', 0, { filename: movie, size: 30 * GB }),
      recipient,
    ]);
    assert.equal(recipient.filename, 'Movie 2010 2160p');
    assert.equal(recipient.size, 30 * GB + 1024);
    assert.equal(recipient.torrent?.fileIdx, -1);
  });

  it('compares infoHashes case-insensitively', () => {
    const recipient = makeCopy('ABC', -1, { filename: PACK, size: 2000 * GB });
    shareFileInfo([
      makeCopy('abc', 5, { filename: FILE, size: 20 * GB }),
      recipient,
    ]);
    assert.equal(recipient.size, 20 * GB);
    assert.equal(recipient.torrent?.fileIdx, 5);
  });

  it('takes the file only from a copy that knows its name and size', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 2000 * GB });
    shareFileInfo([makeCopy('abc', 5, { size: 20 * GB }), recipient]);
    assert.equal(recipient.filename, PACK);
    assert.equal(recipient.torrent?.fileIdx, -1);
  });

  it('leaves p2p copies and other torrents alone', () => {
    const p2p = makeCopy('abc', -1, { filename: PACK, size: 2000 * GB }, 'p2p');
    const other = makeCopy('def', -1, { filename: PACK, size: 2000 * GB });
    shareFileInfo([
      makeCopy('abc', 5, { filename: FILE, size: 20 * GB }),
      p2p,
      other,
    ]);
    assert.equal(p2p.size, 2000 * GB);
    assert.equal(p2p.torrent?.fileIdx, -1);
    assert.equal(other.size, 2000 * GB);
  });
});
