import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import StreamDeduplicator from './deduplicator.js';
import {
  shareCacheStatus,
  shareFileInfo,
  shareInfoHash,
} from './torrent-copies.js';
import type { ParsedStream, UserData } from '../db/schemas.js';

function makeStream(
  mediaInfoQuality: 'probe' | 'indexer' | 'addon' | undefined,
  languages: string[],
  subtitles: string[],
  filename?: string
): ParsedStream {
  return {
    id: Math.random().toString(),
    type: 'p2p',
    filename,
    parsedFile: {
      audioChannels: [],
      visualTags: [],
      audioTags: [],
      languages,
      subtitles,
      mediaInfoQuality,
    },
    addon: {
      instanceId: 'test-instance',
      resultPassthrough: false,
      preset: { id: 'test-preset' },
    },
  } as unknown as ParsedStream;
}

// Access the private merge method directly to exercise it without
// standing up a full dedup grouping/winner-selection pipeline.
function merge(winner: ParsedStream, others: ParsedStream[]) {
  const dedup = new StreamDeduplicator({} as UserData) as unknown as {
    mergeLanguagesAndSubtitles: (
      winner: ParsedStream,
      others: ParsedStream[],
      fields: readonly string[]
    ) => void;
  };
  dedup.mergeLanguagesAndSubtitles(winner, others, ['languages', 'subtitles']);
}

async function dedup(streams: ParsedStream[]) {
  const deduplicator = new StreamDeduplicator({
    deduplicator: {
      enabled: true,
      keys: ['filename'],
      p2p: 'single_result',
    },
    presets: [],
    services: [],
  } as unknown as UserData);
  return deduplicator.deduplicate(streams);
}

describe('deduplicate', () => {
  it('file extension gets stripped correctly', async () => {
    const stream1 = makeStream(undefined, [], [], 'Name.mkv');
    const stream2 = makeStream(undefined, [], [], 'Name');
    const results = await dedup([stream1, stream2]);
    assert.equal(results.length, 1);
  });

  it('repost suffix gets stripped correctly', async () => {
    const stream1 = makeStream(undefined, [], [], 'Name-xpost');
    const stream2 = makeStream(undefined, [], [], 'Name');
    const results = await dedup([stream1, stream2]);
    assert.equal(results.length, 1);
  });

  it('repost suffix and file extension get stripped correctly together', async () => {
    const stream1 = makeStream(undefined, [], [], 'Name.mkv-xpost');
    const stream2 = makeStream(undefined, [], [], 'Name');
    const results = await dedup([stream1, stream2]);
    assert.equal(results.length, 1);
  });
});

function makeTorrentStream(
  infoHash: string,
  fileIdx: number | null | undefined
): ParsedStream {
  return {
    ...makeStream(undefined, [], []),
    torrent: { infoHash, fileIdx },
  } as unknown as ParsedStream;
}

async function dedupByInfoHash(streams: ParsedStream[]) {
  const deduplicator = new StreamDeduplicator({
    deduplicator: {
      enabled: true,
      keys: ['infoHash'],
      p2p: 'single_result',
    },
    presets: [],
    services: [],
  } as unknown as UserData);
  return deduplicator.deduplicate(streams);
}

const HASH = 'a'.repeat(40);

describe('deduplicate by infoHash', () => {
  it('groups streams without a fileIdx with the only known fileIdx', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, -1),
      makeTorrentStream(HASH, undefined),
      makeTorrentStream(HASH, null),
      makeTorrentStream(HASH, 3),
      makeTorrentStream(HASH, 3),
    ]);
    assert.equal(results.length, 1);
  });

  it('keeps different files of a torrent apart and does not guess for streams without a fileIdx', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, 1),
      makeTorrentStream(HASH, -1),
      makeTorrentStream(HASH, 2),
      makeTorrentStream(HASH, undefined),
    ]);
    assert.deepEqual(
      results.map((s) => s.torrent?.fileIdx ?? -1).sort(),
      [-1, 1, 2]
    );
  });

  it('groups streams of a torrent when none has a fileIdx', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, undefined),
      makeTorrentStream(HASH, -1),
    ]);
    assert.equal(results.length, 1);
  });

  it('keeps different files of a torrent apart', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, 0),
      makeTorrentStream(HASH, 1),
    ]);
    assert.equal(results.length, 2);
  });

  it('compares infoHashes case-insensitively', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH.toUpperCase(), -1),
      makeTorrentStream(HASH, 0),
    ]);
    assert.equal(results.length, 1);
  });

  it('does not group different torrents', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, 12),
      makeTorrentStream(HASH + '1', 2),
      makeTorrentStream('b'.repeat(40), undefined),
    ]);
    assert.equal(results.length, 3);
  });
});

describe('deduplicate by file', () => {
  const GB = 1024 ** 3;
  const PACK = 'Game of Thrones S01-S08 1080p BDRip';
  const FILE = 'Game.of.Thrones.S01E01.Winter.Is.Coming.mkv';

  function copy(
    fileIdx: number | null | undefined,
    filename?: string,
    size?: number,
    infoHash = HASH,
    type: ParsedStream['type'] = 'p2p'
  ): ParsedStream {
    return {
      ...makeTorrentStream(infoHash, fileIdx),
      type,
      filename,
      size,
    } as unknown as ParsedStream;
  }

  function debridCopy(
    fileIdx: number | undefined,
    filename: string,
    size: number
  ): ParsedStream {
    const stream = copy(fileIdx, filename, size, HASH, 'debrid');
    stream.service = { id: 'realdebrid', cached: true };
    return stream;
  }

  it('groups copies of one file whatever fileIdx they report', async () => {
    const streams = [
      copy(71, FILE, 4.7 * GB),
      copy(0, FILE, 4.7 * GB),
      copy(undefined, FILE, 4.71 * GB),
      // Reports the pack's size for the file.
      copy(71, FILE, 226.8 * GB),
      // Named after the torrent.
      copy(-1, PACK, 226.8 * GB),
      // Names nothing.
      copy(undefined),
    ];
    const results = await dedupByInfoHash(streams);
    assert.equal(results.length, 1);
  });

  it('keeps files of different names apart whatever fileIdx they report', async () => {
    for (const fileIdxs of [
      [1, 2],
      [0, 0],
      [undefined, undefined],
    ]) {
      const results = await dedupByInfoHash([
        copy(fileIdxs[0], 'Show.S01E01.mkv', 2 * GB),
        copy(fileIdxs[1], 'Show.S01E02.mkv', 2 * GB),
      ]);
      assert.equal(results.length, 2);
    }
  });

  it('keeps same-named files of different sizes apart', async () => {
    const results = await dedupByInfoHash([
      copy(3, '00001.m2ts', 30 * GB),
      copy(3, '00001.m2ts', 5 * GB),
      copy(undefined, PACK, 70 * GB),
    ]);
    assert.equal(results.filter((s) => s.filename === '00001.m2ts').length, 2);
  });

  it('matches names by basename, trimmed and in any case, and hashes in any case', async () => {
    const results = await dedupByInfoHash([
      copy(0, `Season 1/${FILE}`, 4.7 * GB),
      copy(5, ` ${FILE.toUpperCase()} `, 4.7 * GB, HASH.toUpperCase()),
    ]);
    assert.equal(results.length, 1);
  });

  it('falls back to fileIdx for a copy named after the torrent of several files', async () => {
    const results = await dedupByInfoHash([
      copy(1, 'Show.S01E01.mkv', 2 * GB),
      copy(2, 'Show.S01E02.mkv', 2 * GB),
      copy(-1, PACK, 20 * GB),
      copy(undefined, PACK, 20 * GB),
      copy(2, PACK, 20 * GB),
    ]);
    assert.deepEqual(results.map((s) => s.filename ?? '').sort(), [
      PACK,
      'Show.S01E01.mkv',
      'Show.S01E02.mkv',
    ]);
    const e02 = results.find((s) => s.filename === 'Show.S01E02.mkv');
    assert.equal(e02?.torrent?.fileIdx, 2);
  });

  it('gives a copy without a name the file whose copies report its fileIdx', async () => {
    const results = await dedupByInfoHash([
      copy(1, 'Show.S01E01.mkv', 2 * GB),
      copy(2, 'Show.S01E02.mkv', 2 * GB),
      copy(1),
      copy(7),
    ]);
    assert.equal(results.length, 3);
  });

  it('groups a copy naming the file without a size, or with a tiny one', async () => {
    const results = await dedupByInfoHash([
      copy(0, FILE, 4.7 * GB),
      copy(5, FILE),
      copy(undefined, FILE, 0.001 * GB),
    ]);
    assert.equal(results.length, 1);
  });

  it('groups a copy named after the torrent with the only file, whatever its fileIdx', async () => {
    const results = await dedupByInfoHash([
      copy(0, PACK, 230 * GB),
      copy(undefined, FILE, 4.1 * GB),
    ]);
    assert.equal(results.length, 1);
  });

  it('never groups a copy naming a file without a size with another file', async () => {
    const results = await dedupByInfoHash([
      copy(0, 'Show.S01E01.mkv', 2 * GB),
      copy(0, 'Show.S01E02.mkv'),
    ]);
    assert.equal(results.length, 2);
  });

  it('groups p2p and debrid copies of one file', async () => {
    const results = await dedupByInfoHash([
      copy(71, FILE, 4.7 * GB, HASH, 'debrid'),
      copy(0, FILE, 4.7 * GB),
    ]);
    assert.equal(results.length, 1);
  });

  it('lists every addon of the file in sources', async () => {
    const results = await new StreamDeduplicator({
      deduplicator: { enabled: true, keys: ['infoHash'], p2p: 'single_result' },
      presets: [],
      services: [],
    } as unknown as UserData).deduplicate(
      [
        ['MediaFusion', 71, FILE, 226.8 * GB],
        ['Torrentio', 71, FILE, 4.7 * GB],
        ['JacRed', -1, PACK, 226.8 * GB],
        ['JacRed', 0, FILE, 4.7 * GB],
        ['Comet', undefined, FILE, 4.7 * GB],
      ].map(([name, fileIdx, filename, size]) => {
        const stream = copy(
          fileIdx as number | undefined,
          filename as string,
          size as number
        );
        stream.addon = {
          ...stream.addon,
          name: name as string,
          preset: { id: name as string },
        } as ParsedStream['addon'];
        return stream;
      })
    );
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].dedupSources?.map((s) => s.addon).sort(), [
      'Comet',
      'JacRed',
      'MediaFusion',
      'Torrentio',
    ]);
  });

  it('keeps files told apart before filters apart once filters drop copies', async () => {
    for (const name of ['Movie.2012.BluRay.Remux.mkv', '00001.m2ts']) {
      const torrentio = debridCopy(3, name, 20 * GB);
      const mediaFusion = debridCopy(10, name, 25 * GB);
      // An uncached copy reporting the torrent's size, which filters drop.
      const jacRed = debridCopy(-1, PACK, 45 * GB);
      shareFileInfo([torrentio, mediaFusion, jacRed]);
      const filtered = [torrentio, mediaFusion];
      shareFileInfo(filtered);
      const fetched = await dedupByInfoHash(filtered);
      shareFileInfo(fetched);
      const results = await dedupByInfoHash(fetched);
      assert.equal(results.length, 2);
      assert.equal(mediaFusion.size, 25 * GB);
    }
  });

  it('groups copies of one file told in different fetches', async () => {
    const comet = copy(undefined, FILE, 5.38 * GB);
    const mediaFusion = copy(0, FILE, 5.78 * GB);
    const other = copy(1, 'Game.of.Thrones.S01E02.mkv', 5.5 * GB);
    shareFileInfo([comet]);
    shareFileInfo([mediaFusion, other]);
    const streams = [comet, mediaFusion, other];
    shareFileInfo(streams);
    const results = await dedupByInfoHash(streams);
    assert.equal(results.length, 2);
  });

  it('keeps files of one name in different folders apart', async () => {
    for (const [a, b] of [
      ['Season 1/E01.mkv', 'Season 2/E01.mkv'],
      ['Show A/Show.S01E01.mkv', 'Show B/Show.S01E01.mkv'],
      ['Disc1/BDMV/STREAM/00001.m2ts', 'Disc2/BDMV/STREAM/00001.m2ts'],
    ]) {
      const results = await dedupByInfoHash([
        copy(0, a, 1 * GB),
        copy(10, b, 1.03 * GB),
      ]);
      assert.equal(results.length, 2, a);
    }
  });

  it('keeps a copy without a folder apart when the name has several', async () => {
    const results = await dedupByInfoHash([
      copy(0, 'Show A/Show.S01E01.mkv', 1 * GB),
      copy(10, 'Show B/Show.S01E01.mkv', 1 * GB),
      copy(5, 'Show.S01E01.mkv', 1 * GB),
    ]);
    assert.equal(results.length, 3);
  });

  it('groups copies of a numbering name only in one folder, at one size to the byte or at one fileIdx', async () => {
    const VOB = 'VTS_01_1.VOB';
    const cases: [ParsedStream[], number][] = [
      [[copy(3, '00001.m2ts', 30 * GB), copy(9, '00001.m2ts', 31 * GB)], 2],
      [[copy(3, '00001.m2ts', 30 * GB), copy(3, '00001.m2ts', 31 * GB)], 1],
      [[copy(3, '00001.m2ts', 30 * GB), copy(9, '00001.m2ts', 30 * GB)], 1],
      [
        [
          copy(undefined, '00001.m2ts', 30 * GB),
          copy(undefined, '00001.m2ts', 30 * GB),
        ],
        1,
      ],
      [
        [
          copy(undefined, '00001.m2ts', 30 * GB),
          copy(undefined, '00001.m2ts', 31 * GB),
        ],
        2,
      ],
      [[copy(undefined, '00001.m2ts'), copy(undefined, '00001.m2ts')], 2],
      [[copy(undefined, VOB, 1 * GB), copy(undefined, VOB, 1 * GB)], 2],
      [
        [
          copy(3, 'BDMV/STREAM/00001.m2ts', 30 * GB),
          copy(9, 'BDMV/STREAM/00001.m2ts', 31 * GB),
        ],
        1,
      ],
      [
        [
          copy(3, 'Disc1/BDMV/STREAM/00001.m2ts', 30 * GB),
          copy(3, '00001.m2ts', 30 * GB),
        ],
        2,
      ],
      [[copy(1, '1.2.mkv', 1 * GB), copy(2, '12.mkv', 1.02 * GB)], 2],
      [[copy(1, '.mkv', 1 * GB), copy(2, '!!.mkv', 1.02 * GB)], 2],
      [[copy(1, 'E01.mkv', 1 * GB), copy(2, 'E01.mkv', 1.02 * GB)], 2],
    ];
    for (const [i, [streams, rows]] of cases.entries()) {
      const results = await dedupByInfoHash(streams);
      assert.equal(results.length, rows, `case ${i}`);
    }
  });

  it('takes a size reported in GiB as GB for the same', async () => {
    for (const jacRedName of [PACK, FILE]) {
      // An uncached copy reporting the torrent's size, 7% over MediaFusion's.
      const jacRed = debridCopy(-1, jacRedName, 6.2 * GB);
      const streams = [
        debridCopy(undefined, FILE, 5.38 * GB),
        debridCopy(0, FILE, 5.78 * GB),
        jacRed,
      ];
      shareFileInfo(streams);
      const results = await dedupByInfoHash(streams);
      assert.equal(results.length, 1, jacRedName);
      assert.equal(jacRed.filename, FILE);
      assert.equal(jacRed.size, 5.38 * GB);
    }
  });

  it('keeps a sample apart whatever its size', async () => {
    const sample = copy(undefined, `Sample/${FILE}`, 0.03 * GB);
    const results = await dedupByInfoHash([
      copy(0, FILE, 4.7 * GB),
      copy(undefined, FILE, 4.7 * GB),
      sample,
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.includes(sample));
  });

  it('never groups copies naming different files without sizes', async () => {
    for (const fileIdx of [undefined, 0]) {
      const results = await dedupByInfoHash([
        copy(fileIdx, 'Show.S01E01.mkv'),
        copy(fileIdx, 'Show.S01E02.mkv'),
        copy(fileIdx, PACK),
      ]);
      assert.equal(results.length, 3);
    }
  });

  it('matches names in either Unicode normalization, keeping letters apart', async () => {
    const name = 'Брат 2 (2000) Бойцовский.mkv';
    const nfd = await dedupByInfoHash([
      copy(0, name.normalize('NFC'), 2 * GB),
      copy(1, name.normalize('NFD'), 2 * GB),
    ]);
    assert.equal(nfd.length, 1);
    const otherLetter = await dedupByInfoHash([
      copy(0, name, 2 * GB),
      copy(1, name.replace('й', 'и'), 2 * GB),
    ]);
    assert.equal(otherLetter.length, 2);
  });
});

interface Copy {
  hash?: string;
  addon: string;
  size?: number;
  fileIdx?: number;
  languages?: string[];
}

// A cached TorBox copy of a torrent's file, as a debrid addon returns it.
// Without a hash, a copy as MediaFusion gives it.
function makeCopy(filename: string, copy: Copy): ParsedStream {
  return {
    id: `${copy.addon}-${copy.hash}-${Math.random()}`,
    type: 'debrid',
    filename,
    size: copy.size,
    service: { id: 'torbox', cached: true },
    torrent: copy.hash
      ? { infoHash: copy.hash, fileIdx: copy.fileIdx }
      : undefined,
    parsedFile: {
      audioChannels: [],
      visualTags: [],
      audioTags: [],
      languages: copy.languages ?? [],
      subtitles: [],
    },
    addon: {
      instanceId: copy.addon,
      resultPassthrough: false,
      preset: { id: copy.addon },
    },
  } as unknown as ParsedStream;
}

// Deduplicate debrid copies the way a filename + infoHash config does,
// merging languages into the kept copy.
async function dedupCopies(
  streams: ParsedStream[],
  keys = ['filename', 'infoHash']
) {
  const deduplicator = new StreamDeduplicator({
    deduplicator: {
      enabled: true,
      keys,
      cached: 'per_service',
      merge: { enabled: true, fields: ['languages', 'subtitles'] },
    },
    presets: [
      { instanceId: 'comet' },
      { instanceId: 'torrentio' },
      { instanceId: 'mediafusion' },
    ],
    services: [],
  } as unknown as UserData);
  return deduplicator.deduplicate(streams);
}

const hashes = (streams: ParsedStream[]) =>
  streams.map((s) => s.torrent?.infoHash ?? 'none').sort();

describe('deduplicate by filename and size', () => {
  const name = 'Show S01E01 1080p WEB-DL.mkv';

  it('keeps apart other torrents of that name more than 1% apart in size', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_445_000_000 }),
      makeCopy(name, {
        hash: 'b',
        addon: 'torrentio',
        size: 1_480_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b']);
    const a = results.find((s) => s.torrent?.infoHash === 'a')!;
    assert.deepEqual(a.parsedFile?.languages, []);
  });

  it('joins copies of one torrent with and without a fileIdx', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_479_307_976 }),
      makeCopy(name, {
        hash: 'a',
        addon: 'torrentio',
        size: 1_479_307_976,
        fileIdx: 18,
      }),
    ]);
    assert.equal(results.length, 1);
  });

  it('joins copies of one torrent whose sizes are rounded differently', async () => {
    // An addon that rounds to a tenth of a GiB gives exactly 1.4 GiB for a
    // file Comet counts to the byte, 1.6% apart. By the filename key alone:
    // torrentFileKeys joins these by the infoHash key too.
    const results = await dedupCopies(
      [
        makeCopy(name, { hash: 'a', addon: 'comet', size: 1_479_307_976 }),
        makeCopy(name, {
          hash: 'a',
          addon: 'torrentio',
          size: 1_503_238_554,
          fileIdx: 18,
        }),
      ],
      ['filename']
    );
    assert.equal(results.length, 1);
  });

  it('joins other torrents of that name within 1% in size', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_441_668_990 }),
      makeCopy(name, { hash: 'b', addon: 'torrentio', size: 1_438_814_044 }),
    ]);
    assert.equal(results.length, 1);
  });

  it('joins other torrents of that name when one has no size', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_445_000_000 }),
      makeCopy(name, { hash: 'b', addon: 'torrentio' }),
    ]);
    assert.equal(results.length, 1);
  });

  it('joins a copy without an infoHash that gives its season pack size', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_664_000_000 }),
      makeCopy(name, { addon: 'mediafusion', size: 14_128_000_000 }),
    ]);
    assert.equal(results.length, 1);
  });

  it('keeps apart other torrents of that name over twice apart in size', async () => {
    // Different rips of a movie under one name.
    const movie = 'Movie (2019) 1080p.mkv';
    const results = await dedupCopies([
      makeCopy(movie, { hash: 'a', addon: 'comet', size: 18_300_000_000 }),
      makeCopy(movie, { hash: 'b', addon: 'comet', size: 10_570_000_000 }),
      makeCopy(movie, { hash: 'c', addon: 'torrentio', size: 4_180_000_000 }),
      makeCopy(movie, { hash: 'd', addon: 'torrentio', size: 2_900_000_000 }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b', 'c', 'd']);
  });

  it('keeps apart files of one torrent with other fileIdx and size', async () => {
    // The filename key alone: torrentFileKeys tells a torrent's files by
    // name, so the infoHash key takes these two for one file.
    const results = await dedupCopies(
      [
        makeCopy(name, {
          hash: 'a',
          addon: 'comet',
          size: 1_000_000_000,
          fileIdx: 1,
        }),
        makeCopy(name, {
          hash: 'a',
          addon: 'torrentio',
          size: 1_300_000_000,
          fileIdx: 2,
        }),
      ],
      ['filename']
    );
    assert.equal(results.length, 2);
  });

  it('joins a copy without an infoHash to the one file its size fits', async () => {
    // MediaFusion gives 1.5 GiB as 1.5 GB.
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_200_000_000 }),
      makeCopy(name, {
        hash: 'b',
        addon: 'comet',
        size: 1_610_612_736,
        languages: ['Russian'],
      }),
      makeCopy(name, {
        addon: 'mediafusion',
        size: 1_500_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b']);
    const a = results.find((s) => s.torrent?.infoHash === 'a')!;
    assert.deepEqual(a.parsedFile?.languages, []);
  });

  it('joins a copy without an infoHash to the only file within 5% of its size', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_400_000_000 }),
      makeCopy(name, { hash: 'b', addon: 'comet', size: 3_500_000_000 }),
      makeCopy(name, {
        addon: 'mediafusion',
        size: 1_440_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b']);
    const b = results.find((s) => s.torrent?.infoHash === 'b')!;
    assert.deepEqual(b.parsedFile?.languages, []);
  });

  it('joins a copy without an infoHash to the only file its size is a pack of', async () => {
    // 14 GB is ten times the episode's 1.4 GB but under twice the 8 GB rip.
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_400_000_000 }),
      makeCopy(name, { hash: 'b', addon: 'comet', size: 8_000_000_000 }),
      makeCopy(name, {
        addon: 'mediafusion',
        size: 14_000_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b']);
    const a = results.find((s) => s.torrent?.infoHash === 'a')!;
    const b = results.find((s) => s.torrent?.infoHash === 'b')!;
    assert.deepEqual(a.parsedFile?.languages, ['Russian']);
    assert.deepEqual(b.parsedFile?.languages, []);
  });

  it('keeps apart a copy without an infoHash whose size does not fit the one file', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_445_000_000 }),
      makeCopy(name, {
        addon: 'mediafusion',
        size: 1_600_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'none']);
    const a = results.find((s) => s.torrent?.infoHash === 'a')!;
    assert.deepEqual(a.parsedFile?.languages, []);
  });

  it('joins a copy without an infoHash or a size to the one file', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_445_000_000 }),
      makeCopy(name, { addon: 'mediafusion' }),
    ]);
    assert.deepEqual(hashes(results), ['a']);
  });

  it('joins copies of one torrent whose infoHash differs in case', async () => {
    // By the filename key alone: torrentFileKeys lowers the infoHash too.
    const results = await dedupCopies(
      [
        makeCopy(name, { hash: 'ABCD', addon: 'comet', size: 1_400_000_000 }),
        makeCopy(name, {
          hash: 'abcd',
          addon: 'torrentio',
          size: 1_430_000_000,
        }),
      ],
      ['filename']
    );
    assert.equal(results.length, 1);
  });

  // These two by the filename key alone: torrentFileKeys tells a torrent's
  // files by name, so the infoHash key takes all three copies for one file.
  it('joins a copy without a fileIdx to the only file of its torrent its size fits', async () => {
    const results = await dedupCopies(
      [
        makeCopy(name, {
          hash: 'a',
          addon: 'comet',
          size: 1_000_000_000,
          fileIdx: 1,
        }),
        makeCopy(name, {
          hash: 'a',
          addon: 'torrentio',
          size: 1_300_000_000,
          fileIdx: 2,
          languages: ['Russian'],
        }),
        makeCopy(name, {
          hash: 'a',
          addon: 'mediafusion',
          size: 1_000_000_000,
        }),
      ],
      ['filename']
    );
    assert.equal(results.length, 2);
    const small = results.find((s) => s.size === 1_000_000_000)!;
    assert.deepEqual(small.parsedFile?.languages, []);
  });

  it('keeps apart a copy without a fileIdx whose size fits no file or two', async () => {
    const files = (second: number) => [
      makeCopy(name, {
        hash: 'a',
        addon: 'comet',
        size: 1_000_000_000,
        fileIdx: 1,
      }),
      makeCopy(name, {
        hash: 'a',
        addon: 'torrentio',
        size: second,
        fileIdx: 2,
        languages: ['Russian'],
      }),
    ];
    const none = await dedupCopies(
      [
        ...files(1_300_000_000),
        makeCopy(name, {
          hash: 'a',
          addon: 'mediafusion',
          size: 1_150_000_000,
        }),
      ],
      ['filename']
    );
    assert.equal(none.length, 3);
    const two = await dedupCopies(
      [
        ...files(1_016_000_000),
        makeCopy(name, {
          hash: 'a',
          addon: 'mediafusion',
          size: 1_008_000_000,
        }),
      ],
      ['filename']
    );
    assert.equal(two.length, 3);
  });

  it('keeps apart a copy without an infoHash whose size fits two files', async () => {
    const results = await dedupCopies([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_445_000_000 }),
      makeCopy(name, {
        hash: 'b',
        addon: 'comet',
        size: 1_480_000_000,
        languages: ['Russian'],
      }),
      makeCopy(name, {
        addon: 'mediafusion',
        size: 1_460_000_000,
        languages: ['Russian'],
      }),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b', 'none']);
    const a = results.find((s) => s.torrent?.infoHash === 'a')!;
    assert.deepEqual(a.parsedFile?.languages, []);
  });

  it('keeps Re:Zero S4E1 releases with a Russian track apart from the originals', async () => {
    // Rutracker adds a Russian track and keeps the name; Knaben has the
    // original. Real sizes from Comet and Torrentio.
    const erai =
      '[Erai-raws] Re Zero kara Hajimeru Isekai Seikatsu 4th Season - 01 [1080p CR WEB-DL AVC AAC].mkv';
    const budLight = '[BudLightSubs] ReZero S4 - 01 [1080p].mkv';
    const eraiRu = '066cc12b13d99c498b192ae75cbf07c904257283';
    const eraiKnaben = '8c10fcd75c79b8c439f1a86174df36e9b399338f';
    const budLightExt = 'e312720c1964df695b37e794aef0a66ebac933b9';
    const budLightRu = '996558ea6955801b23a56dcc6546c44bdd5a459c';
    const budLightKnaben = 'f38f7f1954960538aab3e5b62279da1d6624e966';
    const results = await dedupCopies([
      makeCopy(erai, { hash: eraiKnaben, addon: 'comet', size: 1445422834 }),
      makeCopy(erai, { hash: eraiRu, addon: 'comet', size: 1479307976 }),
      makeCopy(erai, {
        hash: eraiRu,
        addon: 'torrentio',
        size: 1481763717,
        fileIdx: 18,
        languages: ['Russian', 'Japanese', 'English'],
      }),
      makeCopy(budLight, {
        hash: budLightKnaben,
        addon: 'comet',
        size: 1441668990,
      }),
      makeCopy(budLight, {
        hash: budLightRu,
        addon: 'comet',
        size: 1441668990,
      }),
      makeCopy(budLight, {
        hash: budLightRu,
        addon: 'torrentio',
        size: 1438814044,
        fileIdx: 0,
        languages: ['Russian', 'Japanese'],
      }),
      makeCopy(budLight, {
        hash: budLightExt,
        addon: 'comet',
        size: 1511201900,
      }),
      makeCopy(budLight, {
        hash: budLightExt,
        addon: 'torrentio',
        size: 1513975972,
        fileIdx: 12,
        languages: ['Russian'],
      }),
    ]);
    const languages = (hash: string) =>
      results.find((s) => s.torrent?.infoHash === hash)?.parsedFile?.languages;
    assert.equal(results.length, 4);
    assert.deepEqual(languages(eraiKnaben), []);
    assert.deepEqual(languages(eraiRu), ['Russian', 'Japanese', 'English']);
    assert.deepEqual(languages(budLightExt), ['Russian']);
    // The Knaben copies of the BudLightSubs file are the same file as the
    // Rutracker one (same size from Comet), so they stay joined.
    assert.equal(
      results.filter(
        (s) =>
          s.torrent?.infoHash === budLightRu ||
          s.torrent?.infoHash === budLightKnaben
      ).length,
      1
    );
  });

  describe('Re:Zero S4E1 Erai-raws with a copy that cannot tell its file', () => {
    const erai =
      '[Erai-raws] Re Zero kara Hajimeru Isekai Seikatsu 4th Season - 01 [1080p CR WEB-DL AVC AAC].mkv';
    const eraiRu = '066cc12b13d99c498b192ae75cbf07c904257283';
    const eraiKnaben = '8c10fcd75c79b8c439f1a86174df36e9b399338f';
    const erais = () => [
      makeCopy(erai, { hash: eraiKnaben, addon: 'comet', size: 1445422834 }),
      makeCopy(erai, { hash: eraiRu, addon: 'comet', size: 1479307976 }),
      makeCopy(erai, {
        hash: eraiRu,
        addon: 'torrentio',
        size: 1481763717,
        fileIdx: 18,
        languages: ['Russian', 'Japanese', 'English'],
      }),
    ];
    const languages = (results: ParsedStream[], hash: string) =>
      results.find((s) => s.torrent?.infoHash === hash)?.parsedFile?.languages;

    it('keeps the two files apart beside a copy without a size', async () => {
      const results = await dedupCopies([
        ...erais(),
        makeCopy(erai, { hash: 'c', addon: 'mediafusion' }),
      ]);
      assert.deepEqual(languages(results, eraiKnaben), []);
      assert.deepEqual(languages(results, eraiRu), [
        'Russian',
        'Japanese',
        'English',
      ]);
    });

    it('keeps the two files apart beside a copy with a season pack size', async () => {
      const results = await dedupCopies([
        ...erais(),
        makeCopy(erai, { addon: 'mediafusion', size: 14_128_000_000 }),
      ]);
      assert.deepEqual(languages(results, eraiKnaben), []);
      assert.deepEqual(languages(results, eraiRu), [
        'Russian',
        'Japanese',
        'English',
      ]);
    });

    it('joins a copy without a size to its torrent', async () => {
      const results = await dedupCopies(
        [
          ...erais(),
          makeCopy(erai, { hash: eraiRu, addon: 'mediafusion', fileIdx: 18 }),
        ],
        ['filename']
      );
      assert.deepEqual(hashes(results), [eraiRu, eraiKnaben].sort());
    });
  });

  describe('a name with many streams', () => {
    // Other torrents of the name, each over 1% apart in size from the rest.
    const torrents = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeCopy(name, {
          hash: i.toString(16).padStart(40, '0'),
          addon: 'comet',
          size: Math.round(1e9 * 1.02 ** (i % 300)) + i,
        })
      );

    it('compares up to 200 streams of a name', async () => {
      const results = await dedupCopies(torrents(200), ['filename']);
      assert.equal(results.length, 200);
    });

    it('joins over 200 streams of a name as a whole', async () => {
      const results = await dedupCopies(torrents(201), ['filename']);
      assert.equal(results.length, 1);
    });

    it('deduplicates 10,000 streams of a name in well under a second', async () => {
      const streams = torrents(10_000);
      const start = performance.now();
      const results = await dedupCopies(streams);
      const elapsed = performance.now() - start;
      assert.equal(results.length, 1);
      assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
    });
  });
});

describe('deduplicate same-named streams with unconfirmed copies', () => {
  // Torrents of one name chained by their files: torrent i has file 0 of
  // size i (copy A, unconfirmed) and file 1 of size i - 1 (copy B,
  // unconfirmed), and a confirmed copy of it has no size or fileIdx (H).
  // H fits two files and stays apart until the copies of one of them are
  // removed; then it joins the other, whose copies go next, a link per
  // grouping. Each stream gets its own release group unless linked.
  const hash = (i: number) => i.toString(16).padStart(40, '0');
  let n = 0;
  const stream = (
    name: string,
    copy: { hash: string; size?: number; fileIdx?: number },
    unconfirmed: boolean,
    releaseGroup = `g${n}`
  ): ParsedStream => {
    const s = makeCopy(name, { ...copy, addon: 'comet' });
    s.id = `s${n++}`;
    s.parsedFile!.releaseGroup = releaseGroup;
    if (unconfirmed) s.unconfirmed = { reason: 'title' };
    return s;
  };
  // Links 1..k of a name; the first and the last copy can share a release
  // group with the chain of another name.
  const chain = (
    name: string,
    base: number,
    k: number,
    head: boolean,
    first?: string,
    last?: string
  ) => {
    const out: ParsedStream[] = [];
    if (head) out.push(stream(name, { hash: hash(base + 1) }, false));
    for (let i = 1; i <= k; i++) {
      const size = Math.round(1e9 * 1.1 ** i);
      const at = (j: number) => hash(base + j);
      out.push(
        stream(
          name,
          { hash: at(i), fileIdx: 0, size },
          true,
          ...(i === 1 && first ? [first] : [])
        )
      );
      out.push(
        stream(
          name,
          { hash: at(i + 1), fileIdx: 1, size },
          true,
          ...(i === k && last ? [last] : [])
        )
      );
      if (i < k) out.push(stream(name, { hash: at(i + 1) }, false));
    }
    return out;
  };
  // Deduplicate, failing on a third grouping.
  const dedupOnce = async (
    streams: ParsedStream[],
    keys: string[],
    extra: Record<string, unknown> = {}
  ) => {
    const deduplicator = new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys,
        cached: 'single_result',
        ...extra,
      },
      presets: [{ instanceId: 'comet' }],
      services: [],
    } as unknown as UserData);
    const deduplicate = deduplicator.deduplicate.bind(deduplicator);
    let calls = 0;
    deduplicator.deduplicate = (...args) => {
      assert.ok(++calls <= 2, 'grouped more than twice');
      return deduplicate(...args);
    };
    const start = performance.now();
    const results = await deduplicator.deduplicate(streams);
    return { results, elapsed: performance.now() - start };
  };

  it('removes copies that join a confirmed result on the second grouping', async () => {
    // H1 joins file 0 of torrent 2 once the first grouping removed file 1.
    const streams = chain('Show.mkv', 0, 2, true);
    const second = streams.find(
      (s) => s.torrent?.infoHash === hash(2) && s.torrent.fileIdx === 0
    )!;
    second.parsedFile!.languages = ['Russian'];
    const { results } = await dedupOnce(streams, ['filename'], {
      merge: { enabled: true, fields: ['languages', 'subtitles'] },
    });
    assert.deepEqual(
      results.filter((s) => s.unconfirmed),
      []
    );
    assert.deepEqual(
      results.flatMap((s) => s.parsedFile?.languages ?? []),
      []
    );
  });

  it('groups 10,000 chained streams of many names twice, in well under a second', async () => {
    const streams = Array.from({ length: 50 }, (_, m) =>
      chain(`C${m}.mkv`, m * 1000, 66, true)
    ).flat();
    const { elapsed } = await dedupOnce(streams, ['filename']);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });

  it('groups 10,000 streams chained across names by release group twice, in well under a second', async () => {
    const streams = Array.from({ length: 50 }, (_, m) =>
      chain(
        `C${m}.mkv`,
        m * 1000,
        66,
        m === 0,
        m > 0 ? `L${m}` : undefined,
        `L${m + 1}`
      )
    ).flat();
    const { elapsed } = await dedupOnce(streams, ['filename', 'smartDetect'], {
      smartDetectAttributes: ['releaseGroup'],
    });
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });
});

describe('deduplicate Usenet results by filename', () => {
  // A cached TorBox Usenet result with a playback URL, so a dropped one can
  // be a failover variant.
  const makeNzb = (filename: string, n: number, size: number) =>
    ({
      id: `nzb-${n}`,
      type: 'usenet',
      filename,
      size,
      nzbUrl: `https://indexer.example/nzb/${n}`,
      url: `https://aio.example/api/v1/debrid/playback/${n}`,
      service: { id: 'torbox', cached: true },
      parsedFile: {
        audioChannels: [],
        visualTags: [],
        audioTags: [],
        languages: [],
        subtitles: [],
      },
      addon: {
        instanceId: 'newznab',
        resultPassthrough: false,
        preset: { id: 'newznab' },
      },
    }) as unknown as ParsedStream;

  it('joins reposts of different sizes as failover variants', async () => {
    const deduplicator = new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys: ['filename', 'infoHash'],
        cached: 'per_service',
        merge: { enabled: true, failoverVariants: true },
      },
      presets: [{ instanceId: 'newznab' }],
      services: [],
    } as unknown as UserData);
    const results = await deduplicator.deduplicate([
      makeNzb('Movie.2020.1080p.mkv', 1, 10_000_000_000),
      makeNzb('Movie.2020.1080p.mkv-xpost', 2, 10_300_000_000),
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].failoverVariants?.length, 1);
  });

  const dedupMixed = (streams: ParsedStream[]) =>
    new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys: ['filename', 'infoHash'],
        cached: 'per_service',
      },
      presets: [{ instanceId: 'comet' }, { instanceId: 'newznab' }],
      services: [],
    } as unknown as UserData).deduplicate(streams);

  it('places Usenet results beside two torrent files together', async () => {
    const name = 'Movie.2020.1080p.mkv';
    const results = await dedupMixed([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_000_000_000 }),
      makeCopy(name, { hash: 'b', addon: 'comet', size: 1_500_000_000 }),
      makeNzb(name, 1, 1_000_000_000),
      makeNzb(name, 2, 1_500_000_000),
    ]);
    assert.deepEqual(hashes(results), ['a', 'b', 'none']);
  });

  it('joins Usenet results to the one torrent file whatever their sizes', async () => {
    const name = 'Movie.2020.1080p.mkv';
    const results = await dedupMixed([
      makeCopy(name, { hash: 'a', addon: 'comet', size: 1_000_000_000 }),
      makeNzb(name, 1, 1_600_000_000),
    ]);
    assert.equal(results.length, 1);
  });
});

describe('mergeLanguagesAndSubtitles', () => {
  it('takes only the probe, discarding the indexer entirely', () => {
    const winner = makeStream(undefined, [], []);
    const indexerOther = makeStream('indexer', ['English'], ['English']);
    const probeOther = makeStream('probe', ['French'], ['French']);
    merge(winner, [indexerOther, probeOther]);
    assert.deepEqual(winner.parsedFile?.languages, ['French']);
    assert.deepEqual(winner.parsedFile?.subtitles, ['French']);
    assert.equal(winner.parsedFile?.mediaInfoQuality, 'probe');
  });

  it('takes only the indexer, discarding the addon entirely', () => {
    const winner = makeStream(undefined, [], []);
    const indexerOther = makeStream('indexer', ['English'], ['English']);
    const addonOther = makeStream('addon', ['French'], ['French']);
    merge(winner, [indexerOther, addonOther]);
    assert.deepEqual(winner.parsedFile?.languages, ['English']);
    assert.deepEqual(winner.parsedFile?.subtitles, ['English']);
    assert.equal(winner.parsedFile?.mediaInfoQuality, 'indexer');
  });

  it('never lets a lower-tier other contaminate a winner already at the best tier', () => {
    const winner = makeStream('probe', ['English'], ['English']);
    const other = makeStream('addon', ['French'], ['French']);
    merge(winner, [other]);
    assert.deepEqual(winner.parsedFile?.languages, ['English']);
    assert.deepEqual(winner.parsedFile?.subtitles, ['English']);
    assert.equal(winner.parsedFile?.mediaInfoQuality, 'probe');
  });

  it('unions two sources that share the same tier', () => {
    const winner = makeStream('addon', ['English'], []);
    const other = makeStream('addon', ['French'], ['French']);
    merge(winner, [other]);
    assert.deepEqual(winner.parsedFile?.languages, ['English', 'French']);
    assert.deepEqual(winner.parsedFile?.subtitles, ['French']);
    assert.equal(winner.parsedFile?.mediaInfoQuality, 'addon');
  });

  it('falls back to merging everything when nobody has any tier', () => {
    const winner = makeStream(undefined, [], []);
    const other1 = makeStream(undefined, ['English'], []);
    const other2 = makeStream(undefined, ['French'], ['French']);
    merge(winner, [other1, other2]);
    assert.deepEqual(winner.parsedFile?.languages, ['English', 'French']);
    assert.deepEqual(winner.parsedFile?.subtitles, ['French']);
    assert.equal(winner.parsedFile?.mediaInfoQuality, undefined);
  });

  it('any real tier beats a source with no tier at all', () => {
    const winner = makeStream(undefined, [], []);
    const addonOther = makeStream('addon', ['English'], []);
    const unrankedOther = makeStream(undefined, ['French'], ['French']);
    merge(winner, [addonOther, unrankedOther]);
    assert.deepEqual(winner.parsedFile?.languages, ['English']);
    assert.deepEqual(winner.parsedFile?.subtitles, []);
    assert.equal(winner.parsedFile?.mediaInfoQuality, 'addon');
  });
});

describe('merge release', () => {
  function makeRelease(
    filename: string,
    parsed: Partial<NonNullable<ParsedStream['parsedFile']>> = {},
    folderName?: string
  ): ParsedStream {
    const stream = makeStream(undefined, [], [], filename);
    stream.type = 'debrid';
    stream.service = { id: 'realdebrid', cached: true };
    stream.folderName = folderName;
    stream.torrent = { infoHash: 'a'.repeat(40) };
    Object.assign(stream.parsedFile!, parsed);
    return stream;
  }

  async function dedupByHash(streams: ParsedStream[]) {
    const deduplicator = new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys: ['infoHash'],
        cached: 'single_result',
        merge: { enabled: true, fields: ['release'] },
      },
      presets: [],
      services: [],
    } as unknown as UserData);
    return deduplicator.deduplicate(streams);
  }

  it('names a bare disc file after its torrent', async () => {
    const disc = makeRelease('00030.m2ts');
    const title =
      'The Dark Knight Rises [2012 UHD Blu-ray disc 2160p] [IMAX Edition]';
    const torrent = makeRelease(title, {
      resolution: '2160p',
      quality: 'BluRay',
      visualTags: ['HDR10'],
    });
    const results = await dedupByHash([disc, torrent]);
    assert.equal(results.length, 1);
    const [winner] = results;
    assert.equal(winner.filename, '00030.m2ts');
    assert.equal(winner.folderName, title);
    assert.equal(winner.parsedFile?.resolution, '2160p');
    assert.equal(winner.parsedFile?.quality, 'BluRay');
    assert.deepEqual(winner.parsedFile?.visualTags, ['HDR10']);
  });

  it('keeps what the winner already has', async () => {
    const winner = makeRelease(
      'Movie.2160p.UHD.BDRemux-',
      { resolution: '2160p', visualTags: ['DV'] },
      'Movie.Folder'
    );
    const other = makeRelease('Movie.1080p.BluRay.mkv', {
      resolution: '1080p',
      quality: 'BluRay',
      visualTags: ['HDR10'],
      releaseGroup: 'GRP',
    });
    const [result] = await dedupByHash([winner, other]);
    assert.equal(result.folderName, 'Movie.Folder');
    assert.equal(result.parsedFile?.resolution, '2160p');
    assert.deepEqual(result.parsedFile?.visualTags, ['DV']);
    assert.equal(result.parsedFile?.quality, 'BluRay');
    assert.equal(result.parsedFile?.releaseGroup, 'GRP');
  });

  it('takes the indexer from a duplicate when the winner has none', async () => {
    const winner = makeRelease('Movie.2160p.UHD.BDRemux.mkv');
    const other = makeRelease('Movie.2160p.UHD.BDRemux.mkv');
    other.indexer = 'rutracker, kinozal';
    const [result] = await dedupByHash([winner, other]);
    assert.equal(result.indexer, 'rutracker, kinozal');

    const own = makeRelease('Movie.2160p.UHD.BDRemux.mkv');
    own.indexer = 'rutor';
    const [kept] = await dedupByHash([own, other]);
    assert.equal(kept.indexer, 'rutor');
  });
});

describe('deduplicate sources', () => {
  const presets = ['jacred', 'comet', 'mediafusion', 'torrentio'];
  const names: Record<string, string> = {
    jacred: 'JacRed',
    comet: 'Comet',
    mediafusion: 'MediaFusion',
    torrentio: 'Torrentio',
  };

  function torrent(
    preset: string,
    infoHash: string | undefined,
    service?: { id: string; cached: boolean; cacheShared?: boolean },
    fileIdx?: number
  ): ParsedStream {
    return {
      id: Math.random().toString(),
      type: service ? 'debrid' : 'p2p',
      torrent: infoHash ? { infoHash, fileIdx } : undefined,
      service: service ? { ...service } : undefined,
      addon: {
        instanceId: preset,
        name: names[preset],
        resultPassthrough: false,
        preset: { id: preset },
      },
    } as unknown as ParsedStream;
  }

  function deduplicator(
    overrides: Record<string, unknown> = {}
  ): StreamDeduplicator {
    return new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys: ['infoHash'],
        multiGroupBehaviour: 'aggressive',
        cached: 'single_result',
        uncached: 'single_result',
        p2p: 'single_result',
        ...overrides,
      },
      presets: presets.map((instanceId) => ({ instanceId })),
      services: [
        { id: 'realdebrid', enabled: true },
        { id: 'torbox', enabled: true },
      ],
    } as unknown as UserData);
  }

  const rd = (cached: boolean, cacheShared?: boolean) => ({
    id: 'realdebrid',
    cached,
    cacheShared,
  });
  const tb = (cached: boolean, cacheShared?: boolean) => ({
    id: 'torbox',
    cached,
    cacheShared,
  });

  it('lists every addon in the group once, own addon first, own cache only', async () => {
    const streams = [
      torrent('torrentio', 'abc', rd(true)),
      torrent('torrentio', 'abc', tb(false)),
      torrent('comet', 'abc', tb(false)),
      torrent('mediafusion', 'abc', tb(true)),
      torrent('mediafusion', 'abc', rd(true)),
      torrent('jacred', 'abc', tb(true)),
      torrent('jacred', 'abc', rd(true, true)),
    ];
    const results = await deduplicator().deduplicate(streams);
    assert.equal(results.length, 1);
    assert.equal(results[0].addon.name, 'JacRed');
    assert.equal(results[0].service?.id, 'realdebrid');
    assert.deepEqual(
      results[0].dedupSources?.map(({ addon, cached }) => ({ addon, cached })),
      [
        { addon: 'JacRed', cached: ['torbox'] },
        // Comet's uncached copy was dropped by the aggressive mode.
        { addon: 'Comet', cached: [] },
        { addon: 'MediaFusion', cached: ['realdebrid', 'torbox'] },
        { addon: 'Torrentio', cached: ['realdebrid'] },
      ]
    );
  });

  it('puts the stream own addon first when another addon is earlier', async () => {
    const results = await deduplicator().deduplicate([
      torrent('jacred', 'abc', tb(true)),
      torrent('mediafusion', 'abc', rd(true)),
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].addon.name, 'MediaFusion');
    assert.deepEqual(
      results[0].dedupSources?.map((s) => s.addon),
      ['MediaFusion', 'JacRed']
    );
  });

  it('gives each kept copy its own list', async () => {
    const results = await deduplicator({
      excludeAddons: ['jacred'],
    }).deduplicate([
      torrent('jacred', 'abc', tb(true)),
      torrent('mediafusion', 'abc', rd(true)),
    ]);
    assert.equal(results.length, 2);
    const byAddon = Object.fromEntries(
      results.map((s) => [s.addon.name, s.dedupSources?.map((x) => x.addon)])
    );
    assert.deepEqual(byAddon, {
      JacRed: ['JacRed', 'MediaFusion'],
      MediaFusion: ['MediaFusion', 'JacRed'],
    });
  });

  it('keeps sources recorded by an earlier dedup pass', async () => {
    const first = await deduplicator().deduplicate([
      torrent('mediafusion', 'abc', rd(true)),
      torrent('torrentio', 'abc', rd(true)),
    ]);
    const second = await deduplicator().deduplicate([
      ...first,
      torrent('jacred', 'abc', tb(false)),
    ]);
    assert.equal(second.length, 1);
    assert.deepEqual(
      second[0].dedupSources?.map(({ addon, cached }) => ({ addon, cached })),
      [
        { addon: 'MediaFusion', cached: ['realdebrid'] },
        { addon: 'JacRed', cached: [] },
        { addon: 'Torrentio', cached: ['realdebrid'] },
      ]
    );
  });

  it('skips streams without an infoHash and copies of other torrents', async () => {
    const http = {
      ...torrent('comet', undefined),
      type: 'http',
      filename: 'Movie.mkv',
    } as ParsedStream;
    const other = { ...torrent('torrentio', 'def'), filename: 'Movie.mkv' };
    const own = { ...torrent('jacred', 'abc'), filename: 'Movie.mkv' };
    const results = await deduplicator({
      keys: ['filename'],
      p2p: 'disabled',
      http: 'disabled',
    }).deduplicate([own, other, http]);
    assert.equal(results.length, 3);
    assert.deepEqual(
      own.dedupSources?.map((s) => s.addon),
      ['JacRed']
    );
    assert.deepEqual(
      other.dedupSources?.map((s) => s.addon),
      ['Torrentio']
    );
    assert.equal(http.dedupSources, undefined);
  });

  it('keeps a raised copy without a fileIdx apart when the torrent has several files', async () => {
    // Which file the -1 copy plays is unknown, so it is not grouped with
    // either known file and lists only its own addon, without own cache.
    const streams = [
      torrent('mediafusion', 'abc', rd(true), 1),
      torrent('torrentio', 'abc', rd(true), 2),
      torrent('jacred', 'abc', rd(false), -1),
    ];
    shareCacheStatus(streams);
    const results = await deduplicator().deduplicate(streams);
    assert.deepEqual(
      results.map((s) => ({
        addon: s.addon.name,
        service: s.service,
        sources: s.dedupSources?.map(({ addon, cached }) => ({
          addon,
          cached,
        })),
      })),
      [
        {
          addon: 'MediaFusion',
          service: { id: 'realdebrid', cached: true, cacheShared: undefined },
          sources: [{ addon: 'MediaFusion', cached: ['realdebrid'] }],
        },
        {
          addon: 'Torrentio',
          service: { id: 'realdebrid', cached: true, cacheShared: undefined },
          sources: [{ addon: 'Torrentio', cached: ['realdebrid'] }],
        },
        {
          addon: 'JacRed',
          service: { id: 'realdebrid', cached: true, cacheShared: true },
          sources: [{ addon: 'JacRed', cached: [] }],
        },
      ]
    );
  });

  it('groups copies whose infoHash differs in case into one full list', async () => {
    const streams = [
      torrent('jacred', 'ABCDEF', rd(false), -1),
      torrent('mediafusion', 'abcdef', rd(true), 0),
    ];
    shareCacheStatus(streams);
    const results = await deduplicator().deduplicate(streams);
    assert.equal(results.length, 1);
    assert.deepEqual(
      results[0].dedupSources?.map(({ addon, cached }) => ({ addon, cached })),
      [
        { addon: 'JacRed', cached: [] },
        { addon: 'MediaFusion', cached: ['realdebrid'] },
      ]
    );
  });

  it('adds nothing when dedup is disabled', async () => {
    const stream = torrent('jacred', 'abc', tb(true));
    await deduplicator({ enabled: false }).deduplicate([stream]);
    assert.equal(stream.dedupSources, undefined);
  });
});

describe('deduplicate copies without an infoHash', () => {
  // The Fellowship of the Ring (tt0120737): MediaFusion hides infoHashes
  // since 6.2.0, so its copies of two releases came as rows of their own.
  const TEAMHD =
    'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.2160p.DV.HDR.BluRay.Remux.TeamHD.mkv';
  const TEAMHD_SIZE = 223946512868;
  const TEAMHD_HASH = 'c668daf8c4b38f590d481b3c7e10d39acc207a87';
  const UHD_TITLE =
    'Властелин колец: Братство Кольца / The Lord of the Rings: The Fellowship of the Ring [2001 UHD BDRemux 2160p HDR10 Dolby Vision] [Extended Edition] Dub + 4x MVO + 5x AVO + Original (Eng) + Sub (Rus Eng)';
  const UHD_FILE =
    '1. Братство кольца (2001) UHD BDRemux UK 2160p HDR Dolby Vision Extended Edition от RuTracker - prodigy1201.mkv';
  const UHD_HASH = 'b0e4e3cf00000000000000000000000000000000';

  function copy(
    addon: string,
    infoHash: string | undefined,
    service: { id: string; cached: boolean },
    fields: Partial<ParsedStream> & { title?: string; fileIdx?: number }
  ): ParsedStream {
    const { title, fileIdx, ...rest } = fields;
    return {
      id: Math.random().toString(),
      type: 'debrid',
      service: { ...service },
      torrent: { infoHash, title, fileIdx },
      addon: {
        instanceId: addon,
        name: addon,
        resultPassthrough: false,
        preset: { id: addon },
      },
      ...rest,
    } as unknown as ParsedStream;
  }

  const rd = (cached: boolean) => ({ id: 'realdebrid', cached });
  const tb = (cached: boolean) => ({ id: 'torbox', cached });

  function deduplicator(): StreamDeduplicator {
    return new StreamDeduplicator({
      deduplicator: {
        enabled: true,
        keys: ['infoHash'],
        multiGroupBehaviour: 'aggressive',
        cached: 'single_result',
        uncached: 'single_result',
        p2p: 'single_result',
      },
      presets: ['Comet', 'StremThru Torz', 'MediaFusion', 'Torrentio'].map(
        (instanceId) => ({ instanceId })
      ),
      services: [
        { id: 'realdebrid', enabled: true },
        { id: 'torbox', enabled: true },
      ],
    } as unknown as UserData);
  }

  it('joins them with the copies of their torrent', async () => {
    const streams = [
      copy('Comet', TEAMHD_HASH, rd(false), {
        filename: TEAMHD,
        size: TEAMHD_SIZE,
        title: TEAMHD,
      }),
      copy('Comet', TEAMHD_HASH, tb(true), {
        filename: TEAMHD,
        size: TEAMHD_SIZE,
        title: TEAMHD,
      }),
      copy('StremThru Torz', TEAMHD_HASH, rd(false), {
        filename: TEAMHD,
        size: TEAMHD_SIZE,
      }),
      copy('MediaFusion', undefined, rd(true), {
        filename: TEAMHD,
        size: TEAMHD_SIZE,
      }),
      copy('MediaFusion', undefined, tb(true), {
        filename: TEAMHD,
        size: TEAMHD_SIZE,
      }),
      copy('Comet', UHD_HASH, rd(true), {
        filename: UHD_FILE,
        size: 193450314699,
        title: UHD_FILE,
      }),
      copy('Torrentio', UHD_HASH, rd(true), {
        filename: UHD_FILE,
        size: 193445327012,
        folderName: UHD_TITLE,
        title: UHD_TITLE,
        fileIdx: 0,
      }),
      copy('MediaFusion', undefined, rd(true), {
        filename: UHD_TITLE,
        size: 193450314699,
      }),
      copy('MediaFusion', undefined, tb(true), {
        filename: UHD_TITLE,
        size: 193450314699,
      }),
    ];
    shareInfoHash(streams);
    shareCacheStatus(streams);
    shareFileInfo(streams);
    const results = await deduplicator().deduplicate(streams);
    assert.deepEqual(
      results.map((s) => ({
        addon: s.addon.name,
        service: s.service?.id,
        infoHash: s.torrent?.infoHash,
        sources: s.dedupSources?.map(({ addon }) => addon),
      })),
      [
        {
          addon: 'Comet',
          service: 'realdebrid',
          infoHash: TEAMHD_HASH,
          sources: ['Comet', 'StremThru Torz', 'MediaFusion'],
        },
        {
          addon: 'Comet',
          service: 'realdebrid',
          infoHash: UHD_HASH,
          sources: ['Comet', 'MediaFusion', 'Torrentio'],
        },
      ]
    );
  });
  it("joins an addon's copies of one file on several services when no other copy has it", async () => {
    const trilogy =
      'Властелин колец: Трилогия / The Lord of the Rings: Trilogy (2001-2003) UHD BDRemux 2160p';
    const streams = [
      copy('MediaFusion', undefined, rd(true), {
        filename: trilogy,
        size: 84497308056,
      }),
      copy('MediaFusion', undefined, tb(true), {
        filename: trilogy,
        size: 84497308056,
      }),
      // Another file of the name, and another name.
      copy('MediaFusion', undefined, tb(true), {
        filename: trilogy,
        size: 39609929798,
      }),
      copy('MediaFusion', undefined, tb(true), {
        filename: TEAMHD,
        size: 84497308056,
      }),
    ];
    shareInfoHash(streams);
    const results = await deduplicator().deduplicate(streams);
    assert.deepEqual(
      results.map((s) => [s.service?.id, s.filename, s.size]),
      [
        ['realdebrid', trilogy, 84497308056],
        ['torbox', trilogy, 39609929798],
        ['torbox', TEAMHD, 84497308056],
      ]
    );
  });
  // Versions of a TheEqualizer release (dovi.club UPD) keep its name.
  const EQ = 'Iron.Man.2008.2160p.UHDRemux.HDR.DV-TheEqualizer.mkv';
  const EQ_OLD = 62378309238;
  const EQ_NEW = 62122145270;
  const EQ_ROUNDED = 58 * 1024 ** 3;

  async function dedup(streams: ParsedStream[]) {
    shareInfoHash(streams);
    shareCacheStatus(streams);
    shareFileInfo(streams);
    return (await deduplicator().deduplicate(streams)).map((s) => ({
      addon: s.addon.name,
      service: s.service?.id,
      cached: s.service?.cached,
      infoHash: s.torrent?.infoHash,
      size: s.size,
    }));
  }

  it('keeps versions of one name and different sizes apart', async () => {
    const results = await dedup([
      copy('Comet', 'aaa', rd(true), { filename: EQ, size: EQ_OLD }),
      copy('Comet', 'bbb', rd(true), { filename: EQ, size: EQ_NEW }),
      copy('MediaFusion', undefined, rd(true), { filename: EQ, size: EQ_NEW }),
    ]);
    assert.deepEqual(
      results.map((r) => [r.infoHash, r.size]),
      [
        ['aaa', EQ_OLD],
        ['bbb', EQ_NEW],
      ]
    );
  });

  it("joins a file of one name and byte size in two torrents, keeping MediaFusion's cached status", async () => {
    // Thelma & Louise (tt0103074): one file in torrents 89a48659 and b8e0cc58.
    const results = await dedup([
      copy('Comet', '89a48659', rd(false), { filename: EQ, size: EQ_NEW }),
      copy('MediaFusion', undefined, rd(true), { filename: EQ, size: EQ_NEW }),
    ]);
    assert.deepEqual(results, [
      {
        addon: 'Comet',
        service: 'realdebrid',
        cached: true,
        infoHash: '89a48659',
        size: EQ_NEW,
      },
    ]);
  });

  it('shows a version only MediaFusion has, with its cached status', async () => {
    const results = await dedup([
      copy('Comet', 'aaa', rd(false), { filename: EQ, size: EQ_OLD }),
      copy('MediaFusion', undefined, rd(true), { filename: EQ, size: EQ_NEW }),
      copy('MediaFusion', undefined, tb(true), { filename: EQ, size: EQ_NEW }),
    ]);
    assert.deepEqual(
      results.map((r) => [r.addon, r.service, r.cached, r.infoHash, r.size]),
      [
        ['Comet', 'realdebrid', false, 'aaa', EQ_OLD],
        ['MediaFusion', 'realdebrid', true, undefined, EQ_NEW],
      ]
    );
  });

  it('keeps versions MediaFusion alone has apart', async () => {
    const exact = await dedup([
      copy('MediaFusion', undefined, rd(true), { filename: EQ, size: EQ_OLD }),
      copy('MediaFusion', undefined, rd(true), { filename: EQ, size: EQ_NEW }),
    ]);
    assert.equal(exact.length, 2);
    // Rounded to one size, they can only be told apart by not joining them.
    const rounded = await dedup([
      copy('MediaFusion', undefined, rd(true), {
        filename: EQ,
        size: EQ_ROUNDED,
      }),
      copy('MediaFusion', undefined, rd(true), {
        filename: EQ,
        size: EQ_ROUNDED,
      }),
    ]);
    assert.equal(rounded.length, 2);
  });

  it('keeps a copy apart from another release of the same rounded size', async () => {
    // Terminator 2 (tt0103064): both are 29 GiB as Comet and MediaFusion
    // round them.
    const results = await dedup([
      copy('Comet', 'd2021862', rd(true), {
        filename:
          'Terminator.2.Judgment.Day.1991.THEATRICAL.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-Master5.mkv',
        size: 29 * 1024 ** 3,
      }),
      copy('MediaFusion', undefined, rd(true), {
        filename:
          'Terminator 2: Judgment Day [1991, BDRemux 1080p] [French Transfer] Dub',
        size: 29 * 1024 ** 3,
      }),
    ]);
    assert.deepEqual(
      results.map((r) => [r.addon, r.infoHash]),
      [
        ['Comet', 'd2021862'],
        ['MediaFusion', undefined],
      ]
    );
  });

  it('joins a copy to a torrent by an exact size when no copy gives its name', async () => {
    const results = await dedup([
      copy('Comet', 'aaa', rd(false), {
        filename: 'Iron.Man.2008.2160p.UHD.Remux.mkv',
        size: EQ_NEW,
      }),
      copy('MediaFusion', undefined, rd(true), {
        filename: 'Железный человек / Iron Man (2008) UHD BDRemux 2160p',
        size: EQ_NEW,
      }),
    ]);
    assert.deepEqual(
      results.map((r) => [r.addon, r.cached, r.infoHash]),
      [['Comet', true, 'aaa']]
    );
  });
});
