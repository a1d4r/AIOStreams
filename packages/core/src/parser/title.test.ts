import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTorrentTitleCached } from './title.js';
import FileParser from './file.js';

describe('parseTorrentTitleCached', () => {
  it('parses only the start of an overlong name', () => {
    const start = 'Show.S02E05.1080p.WEB-DL.x264-GRP ';
    const long = start + 'a'.repeat(1024 - start.length);
    const parsed = parseTorrentTitleCached(long + ' S09E09 2160p');
    assert.deepEqual(parsed, parseTorrentTitleCached(long));
    assert.deepEqual(parsed.seasons, [2]);
    assert.deepEqual(parsed.episodes, [5]);
    assert.equal(parsed.resolution, '1080p');
  });

  it('keeps a name of the longest size real indexers give whole', () => {
    const name = 'Show ' + 'tag '.repeat(140) + 'S02E05';
    assert.ok(name.length > 550 && name.length < 1024);
    assert.deepEqual(parseTorrentTitleCached(name).episodes, [5]);
  });

  it('survives names that used to stall or throw', () => {
    const started = Date.now();
    // Quadratic in the parser: 15 s whole.
    parseTorrentTitleCached('1080p ' + '1'.repeat(100_000) + '6x9');
    // "Regular expression too large" out of the parsed title.
    FileParser.parse('Movie ' + 'a'.repeat(200_000));
    // Quadratic in the quality patterns of FileParser: 4 s whole.
    FileParser.parse('Movie ' + 'dvd.'.repeat(25_000));
    assert.ok(Date.now() - started < 3000);
  });
});
