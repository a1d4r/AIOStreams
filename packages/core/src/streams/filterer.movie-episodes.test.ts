import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import StreamFilterer from './filterer.js';
import FileParser from '../parser/file.js';
import { IdParser } from '../utils/index.js';
import type { ParsedStream, UserData } from '../db/schemas.js';

function makeStream(filename: string): ParsedStream {
  return {
    id: filename,
    type: 'p2p',
    filename,
    parsedFile: FileParser.parse(filename),
    addon: {
      instanceId: 'test-instance',
      resultPassthrough: false,
      preset: { id: 'test-preset' },
    },
  } as unknown as ParsedStream;
}

async function keptForMovie(filenames: string[]): Promise<string[]> {
  const filterer = new StreamFilterer({
    uuid: 'test',
    seasonEpisodeMatching: { enabled: true },
  } as unknown as UserData);
  const id = 'tt0120915';
  const kept = await filterer.filter(filenames.map(makeStream), {
    type: 'movie',
    id,
    parsedId: IdParser.parse(id, 'movie'),
    isAnime: false,
    queryType: 'movie',
    getPermittedPatterns: async () => ({
      permitted: new Set(),
      unrestricted: true,
    }),
    getMetadata: async () => undefined,
    getReleaseDates: async () => undefined,
    getEpisodeAirDate: async () => undefined,
    getEpisodeRuntime: async () => undefined,
    getSeaDex: async () => undefined,
    toExpressionContext: () => ({ type: 'movie', id }),
  } as any);
  return kept.map((s) => s.filename!);
}

describe('season/episode matching for a movie', () => {
  it("keeps a saga's numbered episode and a film's own parts", async () => {
    const titles = [
      'Звёздные войны: Эпизод 1 – Скрытая угроза / Star Wars: Episode I - The Phantom Menace (1999) BDRemux 1080p',
      'Star.Wars.Episode.1.The.Phantom.Menace.1999.1080p.BluRay.REMUX',
      'Ирония судьбы, или С лёгким паром! (2 серии из 2) (1975) BDRemux 1080p',
      'Kimi no Na wa (1 из 1) [2016, BDRip 1080p]',
    ];
    for (const title of titles) {
      assert.ok(
        FileParser.parse(title).episodes?.length,
        `parser no longer reads an episode in "${title}"`
      );
    }
    assert.deepEqual(await keptForMovie(titles), titles);
  });

  it('drops a season, a TV pack, an episode range and a duology', async () => {
    const titles = [
      'Kimetsu no Yaiba S01 1080p WEB-DL',
      'Клинок, рассекающий демонов [TV] [26 из 26] [2019, BDRip 1080p]',
      'Клинок, рассекающий демонов [TV] [03 из 26] [2019, WEB-DL 1080p]',
      'Звёздные войны (1-6 эпизоды) 1080p BDRip',
      'Джон Уик 1-2 / John Wick 1-2 (2014-2017) BDRip 1080p',
    ];
    assert.deepEqual(
      FileParser.parse(titles[4]).episodes,
      [1, 2],
      'the duology case no longer tests the year-span rule'
    );
    assert.deepEqual(await keptForMovie(titles), []);
  });
});
