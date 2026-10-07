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
});
