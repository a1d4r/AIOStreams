import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { PresetManager } from './presetManager.js';
import type { Addon, ParsedStream, Stream } from '../db/schemas.js';

// Call the protected hook directly: a full parse() needs the app config.
function infoHash(stream: Stream): string | undefined {
  const Parser = PresetManager.fromId('dmm-cast').getParser();
  const parser = new Parser({} as Addon) as unknown as {
    getInfoHash: (stream: Stream, parsed: ParsedStream) => string | undefined;
  };
  return parser.getInfoHash(stream, {} as ParsedStream);
}

const stream = {
  name: '87.07 GB',
  title: '00030.m2ts\n🎬 DMM Cast RD',
  url: 'https://debridmediamanager.com/api/stremio/x/play/y',
} as Stream;

describe('DMM Cast parser', () => {
  it('reads the infoHash from bingeGroup', () => {
    const hash = '33752b5d16d25f210adadf1d10c40dd957f49d9f';
    assert.equal(
      infoHash({ ...stream, behaviorHints: { bingeGroup: `dmm:${hash}` } }),
      hash
    );
  });

  it('leaves the infoHash empty without a dmm bingeGroup', () => {
    assert.equal(infoHash(stream), undefined);
  });
});
