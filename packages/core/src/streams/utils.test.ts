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
      makeCopy('abc', 6, { filename: FILE, size: 22 * GB }),
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

  it('gives a copy reporting the torrent size the size its file agrees on', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 325 * GB });
    const packSized = makeCopy('abc', 0, { filename: FILE, size: 325 * GB });
    shareFileInfo([
      recipient,
      packSized,
      makeCopy('abc', 0, { filename: FILE, size: 34 * GB }),
    ]);
    assert.equal(packSized.size, 34 * GB);
    assert.equal(packSized.folderSize, 325 * GB);
    assert.equal(packSized.filename, FILE);
    assert.equal(recipient.filename, FILE);
    assert.equal(recipient.size, 34 * GB);
    assert.equal(recipient.folderSize, 325 * GB);
    assert.equal(recipient.torrent?.fileIdx, 0);
  });

  it('takes the file copies without a fileIdx agree on, leaving it unknown', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 311 * GB });
    const p2p = makeCopy('abc', -1, { filename: PACK, size: 311 * GB }, 'p2p');
    shareFileInfo([
      recipient,
      makeCopy('abc', undefined, { filename: FILE, size: 32.7 * GB }),
      makeCopy('abc', null, {
        filename: ` ${FILE.toUpperCase()} `,
        size: 32.6 * GB,
      }),
      makeCopy('abc', -1, { filename: FILE, size: 32.8 * GB }),
      p2p,
    ]);
    assert.equal(recipient.size, 32.6 * GB);
    assert.equal(recipient.folderSize, 311 * GB);
    assert.equal(recipient.folderName, PACK);
    assert.equal(recipient.torrent?.fileIdx, -1);
    assert.equal(p2p.size, 311 * GB);
  });

  it('takes the fileIdx of a copy that reported the torrent size for the file', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 311 * GB });
    shareFileInfo([
      recipient,
      makeCopy('abc', 0, { filename: FILE, size: 311 * GB }),
      makeCopy('abc', undefined, { filename: FILE, size: 32.7 * GB }),
    ]);
    assert.equal(recipient.size, 32.7 * GB);
    assert.equal(recipient.torrent?.fileIdx, 0);
  });

  it('changes nothing when copies without a fileIdx disagree', () => {
    for (const other of [
      { filename: 'Game.of.Thrones.S01E02.mkv', size: 32.7 * GB },
      { filename: FILE, size: 35 * GB },
    ]) {
      const recipient = makeCopy('abc', -1, {
        filename: PACK,
        size: 311 * GB,
      });
      shareFileInfo([
        recipient,
        makeCopy('abc', undefined, { filename: FILE, size: 32.7 * GB }),
        makeCopy('abc', undefined, other),
      ]);
      assert.equal(recipient.filename, PACK);
      assert.equal(recipient.size, 311 * GB);
      assert.equal(recipient.folderSize, undefined);
    }
  });

  it('leaves a copy showing a file to copies without a fileIdx', () => {
    const recipient = makeCopy('abc', undefined, {
      filename: FILE,
      size: 2.1 * GB,
    });
    shareFileInfo([
      recipient,
      makeCopy('abc', 0, { filename: FILE, size: 2.1 * GB }),
      makeCopy('abc', 0, { filename: FILE, size: 20.8 * GB }),
      makeCopy('abc', undefined, { filename: 'Extra.mkv', size: 0.02 * GB }),
    ]);
    assert.equal(recipient.filename, FILE);
    assert.equal(recipient.size, 2.1 * GB);
    assert.equal(recipient.folderSize, undefined);
  });

  it('leaves a copy named after a video file as it is', () => {
    const episode = 'Hra.o.trony.S01E01.mkv';
    const recipient = makeCopy('abc', undefined, {
      filename: episode,
      size: 2.9 * GB,
    });
    const indexedRecipient = makeCopy('def', -1, {
      filename: episode,
      size: 2.9 * GB,
    });
    shareFileInfo([
      recipient,
      makeCopy('abc', undefined, {
        filename: 'Rod.S01E01.mkv',
        size: 1.1 * GB,
      }),
      indexedRecipient,
      makeCopy('def', 0, { filename: 'Rod.S01E01.mkv', size: 1.1 * GB }),
    ]);
    for (const stream of [recipient, indexedRecipient]) {
      assert.equal(stream.filename, episode);
      assert.equal(stream.size, 2.9 * GB);
      assert.equal(stream.folderSize, undefined);
    }
    assert.equal(indexedRecipient.torrent?.fileIdx, -1);
  });

  it('changes nothing when copies name different files, whatever their fileIdx', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 311 * GB });
    shareFileInfo([
      recipient,
      makeCopy('abc', undefined, { filename: 'Other.mkv', size: 10 * GB }),
      makeCopy('abc', 3, { filename: FILE, size: 32.7 * GB }),
    ]);
    assert.equal(recipient.filename, PACK);
    assert.equal(recipient.size, 311 * GB);
    assert.equal(recipient.torrent?.fileIdx, -1);
  });

  it('gives the file its copies name even when their fileIdx differ', () => {
    // A season pack as the NAS returned it: MediaFusion reports the pack's
    // size for the file, TorBox numbers files differently from Real-Debrid.
    const rdPack = makeCopy('abc', -1, { filename: PACK, size: 226.8 * GB });
    const mediaFusion = makeCopy('abc', 71, {
      filename: FILE,
      size: 226.8 * GB,
    });
    const streams = [
      mediaFusion,
      makeCopy('abc', 71, { filename: FILE, size: 4.7 * GB }),
      makeCopy('abc', 0, {
        filename: FILE,
        size: 4.7 * GB,
        folderName: PACK,
      }),
      rdPack,
      makeCopy('abc', undefined, { filename: FILE, size: 4.71 * GB }),
    ];
    streams[4].folderSize = 227 * GB;
    shareFileInfo(streams);
    assert.equal(mediaFusion.size, 4.7 * GB);
    assert.equal(mediaFusion.folderSize, 226.8 * GB);
    assert.equal(rdPack.filename, FILE);
    assert.equal(rdPack.size, 4.7 * GB);
    assert.equal(rdPack.folderSize, 226.8 * GB);
    assert.equal(rdPack.folderName, PACK);
    assert.equal(rdPack.torrent?.fileIdx, -1);
  });

  it('gives a copy named after the torrent the file, keeping its own fileIdx', () => {
    const recipient = makeCopy('abc', 0, { filename: PACK, size: 230 * GB });
    shareFileInfo([
      recipient,
      makeCopy('abc', undefined, { filename: FILE, size: 4.1 * GB }),
      makeCopy('abc', 3, { filename: FILE, size: 4.1 * GB }),
    ]);
    assert.equal(recipient.filename, FILE);
    assert.equal(recipient.size, 4.1 * GB);
    assert.equal(recipient.folderName, PACK);
    assert.equal(recipient.torrent?.fileIdx, 0);
  });

  it('matches the file by its basename, trimmed and in any case', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 311 * GB });
    shareFileInfo([
      recipient,
      makeCopy('abc', 2, { filename: `Season 1/${FILE}`, size: 32.7 * GB }),
      makeCopy('abc', 2, {
        filename: ` ${FILE.toUpperCase()}`,
        size: 32.7 * GB,
      }),
    ]);
    assert.equal(recipient.size, 32.7 * GB);
    assert.equal(recipient.torrent?.fileIdx, 2);
  });

  it('keeps the size of a torrent-sized copy when smaller copies disagree', () => {
    const packSized = makeCopy('abc', 71, { filename: FILE, size: 300 * GB });
    shareFileInfo([
      packSized,
      makeCopy('abc', 71, { filename: FILE, size: 4.7 * GB }),
      makeCopy('abc', 0, { filename: FILE, size: 5 * GB }),
      makeCopy('abc', -1, { filename: PACK, size: 300 * GB }),
    ]);
    assert.equal(packSized.size, 300 * GB);
    assert.equal(packSized.folderSize, undefined);
  });

  it('gives a copy reporting a tiny size for the file the size others agree on', () => {
    const tiny = makeCopy('abc', undefined, {
      filename: FILE,
      size: 0.02 * GB,
    });
    shareFileInfo([
      tiny,
      makeCopy('abc', 0, { filename: FILE, size: 7.84 * GB }),
      makeCopy('abc', undefined, { filename: FILE, size: 7.8 * GB }),
    ]);
    assert.equal(tiny.size, 7.8 * GB);
    assert.equal(tiny.folderSize, undefined);
  });

  it('matches names whatever their spacing and punctuation', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 311 * GB });
    shareFileInfo([
      recipient,
      makeCopy('abc', 2, { filename: 'Movie (2014) 4K.mkv', size: 32.7 * GB }),
      makeCopy('abc', 2, { filename: 'Movie(2014) 4K.mkv', size: 32.7 * GB }),
    ]);
    assert.equal(recipient.filename, 'Movie (2014) 4K.mkv');
    assert.equal(recipient.torrent?.fileIdx, 2);
  });

  it('keeps same-named files of different sizes apart', () => {
    // Two discs of one BDMV torrent, each with its own 00001.m2ts.
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 70 * GB });
    const first = makeCopy('abc', 3, { filename: '00001.m2ts', size: 30 * GB });
    const second = makeCopy('abc', 9, { filename: '00001.m2ts', size: 5 * GB });
    shareFileInfo([recipient, first, second]);
    assert.equal(first.size, 30 * GB);
    assert.equal(second.size, 5 * GB);
    assert.equal(recipient.size, 70 * GB);
    assert.equal(recipient.filename, PACK);
  });

  it('changes nothing more when run again', () => {
    const recipient = makeCopy('abc', -1, { filename: PACK, size: 325 * GB });
    const packSized = makeCopy('abc', 0, { filename: FILE, size: 325 * GB });
    const streams = [
      recipient,
      packSized,
      makeCopy('abc', 0, { filename: FILE, size: 34 * GB }),
    ];
    shareFileInfo(streams);
    const once = structuredClone(streams);
    shareFileInfo(streams);
    assert.deepEqual(streams, once);
  });

  it('leaves p2p copies and other torrents alone', () => {
    const p2p = makeCopy('abc', -1, { filename: PACK, size: 2000 * GB }, 'p2p');
    const p2pFile = makeCopy(
      'abc',
      5,
      { filename: FILE, size: 2000 * GB },
      'p2p'
    );
    const other = makeCopy('def', -1, { filename: PACK, size: 2000 * GB });
    shareFileInfo([
      makeCopy('abc', 5, { filename: FILE, size: 20 * GB }),
      p2p,
      p2pFile,
      other,
    ]);
    assert.equal(p2p.size, 2000 * GB);
    assert.equal(p2p.torrent?.fileIdx, -1);
    assert.equal(p2pFile.size, 2000 * GB);
    assert.equal(other.size, 2000 * GB);
  });
});
