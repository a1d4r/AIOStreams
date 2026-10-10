import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import StreamDeduplicator from './deduplicator.js';
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

  it('does not group different torrents', async () => {
    const results = await dedupByInfoHash([
      makeTorrentStream(HASH, 12),
      makeTorrentStream(HASH + '1', 2),
      makeTorrentStream('b'.repeat(40), undefined),
    ]);
    assert.equal(results.length, 3);
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
