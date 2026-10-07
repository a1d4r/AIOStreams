import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { PresetManager } from './presetManager.js';
import type { Addon, ParsedStream, Stream } from '../db/schemas.js';

// Call the protected hooks directly: a full parse() needs the app config.
function parser() {
  const Parser = PresetManager.fromId('dmm-cast').getParser();
  return new Parser({} as Addon) as unknown as {
    getInfoHash: (stream: Stream, parsed: ParsedStream) => string | undefined;
    getFilename: (stream: Stream, parsed: ParsedStream) => string | undefined;
  };
}

function infoHash(stream: Stream): string | undefined {
  return parser().getInfoHash(stream, {} as ParsedStream);
}

function filename(title: string): string | undefined {
  return parser().getFilename({ ...stream, title }, {} as ParsedStream);
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

  it('joins a filename DMM split in half', () => {
    assert.equal(
      filename(
        'Kung.Fu.Panda.4.2024.2160p.UHD.B-\nDREMUX.HDR.DV.HEVC-Нечипорук.mkv\nDD 5.1 • 🇷🇺 🇺🇦 🇬🇪 🇬🇧\n🎬 DMM Cast RD'
      ),
      'Kung.Fu.Panda.4.2024.2160p.UHD.BDREMUX.HDR.DV.HEVC-Нечипорук.mkv'
    );
    assert.equal(
      filename(
        'Kung.Fu.Panda.4.2024.UHD.BluRay.2160p.Tru-\neHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv\nTrueHD 7.1 • 🇬🇧\n🎬 DMM Cast RD'
      ),
      'Kung.Fu.Panda.4.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv'
    );
  });

  it('keeps a short filename as is', () => {
    assert.equal(
      filename(
        'Kung.Fu.Panda.4.2024.2160p.UHDRemux.HDR.DV-TheEqualizer.mkv\n🎬 DMM Cast RD'
      ),
      'Kung.Fu.Panda.4.2024.2160p.UHDRemux.HDR.DV-TheEqualizer.mkv'
    );
  });

  it('does not join a line that only ends with a hyphen', () => {
    assert.equal(
      filename('Movie.2024-\nDD 5.1\n🎬 DMM Cast RD'),
      'Movie.2024-'
    );
  });
});
