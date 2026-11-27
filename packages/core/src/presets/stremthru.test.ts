import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { StremThruStreamParser } from './stremthru.js';
import type { Addon, ParsedStream, Stream } from '../db/schemas.js';

const addon = {
  name: 'StremThru Torz',
  instanceId: 'torz',
  manifestUrl: 'https://torz.example/manifest.json',
  enabled: true,
  preset: { id: 'torz', type: 'stremthruTorz', options: {} },
} as unknown as Addon;

function parse(description: string) {
  const parsed = new StremThruStreamParser(addon).parse({
    name: 'Torz 2160p',
    description: `${description}\n📄 Movie.2001.2160p.Remux.mkv`,
    infoHash: 'a'.repeat(40),
    behaviorHints: { filename: 'Movie.2001.2160p.Remux.mkv' },
  } as unknown as Stream);
  return (parsed as ParsedStream).parsedFile;
}

describe('StremThru probed audio languages', () => {
  it('are the languages after 🎙️', () => {
    const parsedFile = parse('📦 209 GB 〽️ 16.3 MB/s\n🎙️ 🇷🇺 🇬🇧\n💬 🇷🇺');
    assert.deepEqual(parsedFile?.probedAudioLanguages, ['Russian', 'English']);
    assert.deepEqual(parsedFile?.languages, ['Russian', 'English']);
    assert.equal(parsedFile?.mediaInfoQuality, 'probe');
  });

  it('are not the languages after 🌐, probed bitrate or not', () => {
    const parsedFile = parse('📦 209 GB 〽️ 16.3 MB/s\n🌐 🇷🇺 🇬🇧');
    assert.deepEqual(parsedFile?.languages, ['Russian', 'English']);
    assert.equal(parsedFile?.mediaInfoQuality, 'probe');
    assert.equal(parsedFile?.probedAudioLanguages, undefined);
  });

  it('are absent when 🎙️ has no known language or only subtitles are probed', () => {
    assert.equal(parse('🎙️ 🇦🇶')?.probedAudioLanguages, undefined);
    assert.equal(parse('💬 🇷🇺 🇬🇧')?.probedAudioLanguages, undefined);
  });
});
