import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layerMediaInfo } from './apply.js';
import { parseMediaInfo } from '../utils/media-info.js';
import type { ParsedFile } from '../db/schemas.js';

function makeParsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    languages: [],
    subtitles: [],
    audioTags: [],
    audioChannels: [],
    visualTags: [],
    ...overrides,
  };
}

describe('layerMediaInfo', () => {
  it('lets a confirmed-empty probe overwrite a stale guessed value', () => {
    const stale = makeParsedFile({ languages: ['Turkish', 'German'] });
    const probe = parseMediaInfo({ audio: [{ codec: 'aac' }] }); // no lang tag
    const applied = layerMediaInfo(stale, probe);
    assert.deepEqual(applied?.languages, []);
  });

  it("replaces an addon's probed audio languages only with audio of its own", () => {
    const torz = makeParsedFile({
      languages: ['English'],
      probedAudioLanguages: ['English'],
    });
    const audio = parseMediaInfo({ audio: [{ codec: 'aac', lang: 'rus' }] });
    assert.equal(layerMediaInfo(torz, audio)?.probedAudioLanguages, undefined);
    const video = parseMediaInfo({
      video: { codec: 'hevc', w: 3840, h: 2160 },
    });
    assert.deepEqual(layerMediaInfo(torz, video)?.probedAudioLanguages, [
      'English',
    ]);
  });

  it('leaves the existing value alone when the probe has no opinion at all', () => {
    const stale = makeParsedFile({ languages: ['English'] });
    const applied = layerMediaInfo(stale, parseMediaInfo({}));
    assert.deepEqual(applied?.languages, ['English']);
  });

  it('merges a typical real probe over an existing file', () => {
    const existing = makeParsedFile({ languages: ['English'] });
    const probe = parseMediaInfo({
      audio: [{ codec: 'aac', lang: 'eng' }],
      subtitle: [{ lang: 'fre' }],
    });
    const applied = layerMediaInfo(existing, probe);
    assert.deepEqual(applied?.languages, ['English']);
    assert.deepEqual(applied?.subtitles, ['French']);
    assert.equal(applied?.mediaInfoQuality, 'probe');
  });
});
