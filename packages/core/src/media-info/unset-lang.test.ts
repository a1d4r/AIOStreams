import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
// The normal core entry point initialises the parsers' dependency graph.
import '../index.js';
import { dropUnsetAudioLang } from './unset-lang.js';
import { applyMediaInfo, layerMediaInfo } from './apply.js';
import { parseMediaInfo } from '../utils/media-info.js';
import FileParser from '../parser/file.js';
import { BuiltinStreamParser } from '../presets/builtin.js';
import type { Addon, Stream } from '../db/schemas.js';
import type { MediaInfoRecord } from './record.js';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';

const ANIDUB_FILE =
  'Re.Zero.kara.Hajimeru.Isekai.Seikatsu.s04e07.HD1080p.WEBRip.Rus.AniDub.com.mp4';
const ANIDUB_FOLDER =
  'C НУЛЯ: пособие по выживанию в альтернативном мире ТВ-4 / RE:ZERO KARA HAJIMERU ISEKAI SEIKATSU TV-4 [19 из 19] | [AniDUB].rus';

const probe = (audio: Record<string, unknown>[]) =>
  parseMediaInfo({ audio, subtitle: [] });
const aac = { codec: 'aac', ch: 2, default: true };

describe('dropUnsetAudioLang', () => {
  it("drops the English of a lone untitled track a Russian release's name contradicts", () => {
    const info = dropUnsetAudioLang(
      probe([{ ...aac, lang: 'eng' }]),
      ANIDUB_FILE,
      ANIDUB_FOLDER
    );
    assert.deepEqual(info?.languages, ['Russian']);
    assert.equal(info?.audioTracks?.[0].lang, undefined);
    assert.equal(info?.audioTracks?.[0].codec, 'aac');
    assert.equal(info?.mediaInfoQuality, 'probe');
  });

  it('treats an untagged track the same way', () => {
    const info = dropUnsetAudioLang(probe([aac]), ANIDUB_FILE);
    assert.deepEqual(info?.languages, ['Russian']);
  });

  it('takes "Оригинальная" for a word, not the original audio', () => {
    const info = dropUnsetAudioLang(
      probe([{ ...aac, lang: 'eng' }]),
      'Movie.2020.1080p.WEB-DL.Rus.mkv',
      'Фильм (2020) WEB-DL 1080p | Rus (Оригинальная озвучка студии)'
    );
    assert.equal(info?.audioTracks?.[0].lang, undefined);
  });

  it('stays linear on a long run of Cyrillic', () => {
    const name = 'саб'.repeat(330);
    const started = performance.now();
    dropUnsetAudioLang(probe([aac]), name);
    assert.ok(performance.now() - started < 200);
  });

  it('reads a Matroska file the same as MP4', () => {
    const info = dropUnsetAudioLang(
      probe([{ ...aac, lang: 'eng' }]),
      'Show.S01E01.1080p.WEB-DL.RUS.mkv'
    );
    assert.equal(info?.audioTracks?.[0].lang, undefined);
  });

  for (const [why, names, audio] of [
    [
      'Cyrillic alone',
      ['Интерстеллар / Interstellar (2014) BDRip 1080p | Original'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian subtitles',
      ['Интерстеллар / Interstellar (2014) BDRip 1080p | Original + Sub Rus'],
      [{ ...aac, lang: 'eng' }],
    ],
    ['Russian subtitles, dotted', ['Movie.2020.1080p.Rus.Sub.mkv'], [aac]],
    [
      'Russian beside English',
      ['Movie.2020.1080p.RUS.ENG.mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian beside Japanese',
      ['Re:Zero [TV] [19 из 19] [RUS(int) JAP+Sub] [1080p]'],
      [{ ...aac, lang: 'eng' }],
    ],
    ['external Russian audio', ['Re Zero [BDRip 1080p] RUS(ext)'], [aac]],
    ['an overlong name', [`${ANIDUB_FILE} ${'x'.repeat(1000)}`], [aac]],
    [
      "a Russian site's header of an English title",
      [
        'Русская кукла / Russian Doll / Сезон: 1 / Серии: 1-8 из 8 (Лесли Хэдленд) [2019, США, драма, WEB-DL 1080p] Original + Sub Rus',
      ],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'the same header without Original',
      [
        'Русская кукла / Russian Doll / Сезон: 1 / Серии: 1-8 из 8 (Лесли Хэдленд) [2019, США, драма, WEB-DL 1080p] Sub (Rus)',
      ],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian subtitles named in Cyrillic',
      ['Movie (2020) WEB-DL 1080p | Субтитры Rus'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian hardsubs',
      ['Movie.2020.1080p.Rus.HardSub.mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian subtitles after an underscore',
      ['Movie_2020_1080p_Sub_Rus.mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'Russian SDH',
      ['Movie.2020.1080p.Rus.SDH.mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'external Russian audio, spelled out',
      ['Movie (2020) BDRip 1080p | Rus (внешняя)'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'external Russian audio in brackets',
      ['Movie.2020.1080p.Rus [ext].mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'the original audio',
      ['Movie.2020.1080p.Rus.Original.mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    [
      'a title word',
      ['russian.doll.s01e01.720p.webrip.x264-strife[eztv].mkv'],
      [{ ...aac, lang: 'eng' }],
    ],
    ['a titled track', [ANIDUB_FILE], [{ ...aac, lang: 'eng', title: 'Eng' }]],
    ['another language', [ANIDUB_FILE], [{ ...aac, lang: 'jpn' }]],
    [
      'two tracks',
      [ANIDUB_FILE],
      [
        { ...aac, lang: 'eng' },
        { ...aac, lang: 'eng' },
      ],
    ],
  ] as const) {
    it(`keeps the probe for ${why}`, () => {
      const info = probe([...audio]);
      assert.equal(dropUnsetAudioLang(info, ...names), info);
    });
  }
});

describe('the name takes over where a probe is laid over a stream', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  const named = FileParser.parse(ANIDUB_FILE);

  it('in layerMediaInfo', () => {
    const applied = layerMediaInfo(
      named,
      dropUnsetAudioLang(probe([{ ...aac, lang: 'eng' }]), ANIDUB_FILE)
    );
    assert.deepEqual(applied?.languages, ['Russian']);
    assert.deepEqual(applied?.audioChannels, ['2.0']);
    assert.equal(applied?.audioTracks?.length, 1);
  });

  it('over an indexer that names English too', () => {
    const applied = layerMediaInfo(
      { ...named, languages: ['Russian', 'English'] },
      dropUnsetAudioLang(probe([{ ...aac, lang: 'eng' }]), ANIDUB_FILE)
    );
    assert.deepEqual(applied?.languages, ['Russian']);
  });

  it('in applyMediaInfo', () => {
    const stream = {
      parsedFile: named,
      filename: ANIDUB_FILE,
      folderName: ANIDUB_FOLDER,
      duration: undefined,
      bitrate: undefined,
    };
    const record = {
      tracks: [
        { type: 'audio', index: 1, codec: 'aac', language: 'eng', channels: 2 },
      ],
    } as unknown as MediaInfoRecord;
    applyMediaInfo(stream, record);
    assert.deepEqual(stream.parsedFile?.languages, ['Russian']);
  });

  it('in a built-in addon stream', () => {
    const stream = {
      url: 'https://example.com/playback',
      description: ANIDUB_FOLDER,
      behaviorHints: { filename: ANIDUB_FILE },
      parsedMediaInfo: probe([{ ...aac, lang: 'eng' }]),
    } as unknown as Stream;
    const parsed = new BuiltinStreamParser({
      instanceId: 'torznab',
      name: 'Torznab',
      manifestUrl: 'https://example.com/manifest.json',
      enabled: true,
      timeout: 1000,
      preset: { id: 'torznab', type: 'torznab', options: {} },
    } as unknown as Addon).parse(stream);
    assert.ok(!('skip' in parsed));
    assert.deepEqual(parsed.parsedFile?.languages, ['Russian']);
    assert.equal(parsed.parsedFile?.mediaInfoQuality, 'probe');
    assert.equal(parsed.parsedFile?.audioTracks?.[0].lang, undefined);
  });
});
