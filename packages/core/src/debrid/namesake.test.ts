import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstReleaseDate,
  hasLatinName,
  hasTranslationOfRussianOriginal,
  isOlderNamesake,
  isPublishedBeforeRelease,
} from './namesake.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const hoursSince = (date: string) => (NOW - Date.parse(date)) / 3_600_000;

describe('isPublishedBeforeRelease', () => {
  // «Красота» premiered on 30.10.2026; FX's «The Beauty» was out in January.
  const krasota = { titles: ['Красота', 'Beauty'], releaseDate: '2026-10-30' };

  it('drops a release published months before the premiere', () => {
    assert.ok(isPublishedBeforeRelease(hoursSince('2026-01-21'), krasota, NOW));
  });

  it('keeps a release of the premiere week', () => {
    assert.ok(
      !isPublishedBeforeRelease(hoursSince('2026-10-29'), krasota, NOW)
    );
  });

  it('keeps a release up to a month ahead (a screener, a date off in TMDB)', () => {
    assert.ok(
      !isPublishedBeforeRelease(hoursSince('2026-10-05'), krasota, NOW)
    );
    assert.ok(isPublishedBeforeRelease(hoursSince('2026-09-25'), krasota, NOW));
  });

  it('says nothing without a date or an age', () => {
    assert.ok(!isPublishedBeforeRelease(undefined, krasota, NOW));
    assert.ok(!isPublishedBeforeRelease(10_000, { titles: ['Лиля'] }, NOW));
    assert.ok(
      !isPublishedBeforeRelease(
        10_000,
        { titles: ['x'], releaseDate: '?' },
        NOW
      )
    );
    assert.ok(!isPublishedBeforeRelease(Number.NaN, krasota, NOW));
  });
});

describe('hasLatinName', () => {
  it('finds the Latin name a Russian tracker gives a foreign release', () => {
    for (const title of [
      'Красота / The Beauty / Сезон: 1 / Серии: 1-11 из 11 (Райан Мерфи / Ryan Murphy) [2026, США, Ужасы, WEB-DLRip] MVO',
      'Красота (1 сезон: 1-11 серии из 11) / The Beauty / 2026 / ПМ (LostFilm), СТ / WEB-DLRip | [LostFilm].rus',
      'Красота 1 сезон (1-11 из 11) / The Beauty (2026) WEB-DL | от Delta Dubbing | [Delta Dubbing].rus',
      'Красота / The Beauty [01х01-10 из 11] (2026) WEBRip | P2 | ViruseProject | [ViruseProject].rus',
      'Красота (The Beauty) Сезон 1 Серии 01-11 (HD1080p WEBRip) Полный 1 сезон',
      'Полярный / Polar / 2019 / 2 x ПМ, СТ / WEB-DL (1080p)',
      'Сестры / Irmã (2020) WEB-DL',
      'Свидетели / Eyewitness [S01] (2016) WEB-DL 720p от GeneralFilm | NewStudio',
      'Аванпост / Застава / The Outpost / Сезон: 2 / Серии: 1-13 из 13 (Джон Лойд) [2019, США, фэнтези]',
      'Одиссея / Odyssey (2025) HDRip | от monstryu',
      // a scene name, no Russian at all
      'The.Beauty.2026.S01E01.1080p.WEB.h264-ETHEL',
      'The Beauty S01E01 1080p WEB H264',
    ]) {
      assert.ok(hasLatinName(title), title);
    }
  });

  it('reads no name in the Russian release: the year, tags, format, groups', () => {
    for (const title of [
      'Империя (Петр I) (1-4 серии из 4) / 2022 / РУ, СТ / DVB',
      'Империя (Петр I) (1-4 серии из 4) / 2022 / РУ, СТ / WEBRip (1080p)',
      'Империя: Петр I (1-4 серии из 4) (Дарья Шумакова) [2022, документальный, история, биография, DVB] Sub Rus',
      'Балабол (Одинокий волк Саня) (1 сезон: 1-16 серии из 16) / 2013 / РУ / DVB',
      'Ищейка [S01] (2015) HDTV 1080i от MediaClub',
      'Последний день (2014) SATRip (4 серии из 4)',
      'Спутник (2020) WEB-DL | от ExKinoRay',
      'Спутник (2020) WEB-DL | AVC | DoMiNo @ iTunes',
      'Красный призрак / 2020 / РУ / WEB-DLRip (AVC)',
      'Красный призрак (2020) (Оригинал) [TS]',
      'Камера Мотор [01x01-05 из 16] (2024) WEB-DL 1080p от ExKinoRay',
      'Спутник (HD1080p WEBRip)',
      'Спутник (AVC) WEB-DL',
      'Последний день (SATRip) (4 серии из 4)',
      'Последний день / WEBRip 1080p',
      'Солдаты (2004-2013) DVDRip / SATRip',
      'Последний день (Full HD) (4 серии из 4)',
    ]) {
      assert.ok(!hasLatinName(title), title);
    }
  });
});

describe('isOlderNamesake', () => {
  const NOW_ = Date.parse('2026-11-20T12:00:00Z');
  const ago = (date: string) => (NOW_ - Date.parse(date)) / 3_600_000;
  // «Империя» (2022): TMDB dates it 04.11.2022, «Пётр I» was on air in June.
  const imperiya = {
    titles: ['Империя'],
    originalLanguage: 'ru',
    releaseDate: '2022-11-04',
  };
  const krasota = {
    titles: ['Красота', 'Beauty'],
    originalLanguage: 'ru',
    releaseDate: '2026-10-30',
  };

  it("keeps a Russian title's release older than TMDB's date", () => {
    for (const title of [
      'Империя (Петр I) (1-4 серии из 4) / 2022 / РУ, СТ / DVB',
      'Империя: Петр I (1-4 серии из 4) (Дарья Шумакова) [2022, документальный, история, биография, DVB] Sub Rus',
    ]) {
      assert.ok(
        !isOlderNamesake(title, ago('2022-06-12'), imperiya, NOW_),
        title
      );
    }
  });

  it('drops a foreign namesake of a Russian title by its Latin name', () => {
    assert.ok(
      isOlderNamesake(
        'Красота (The Beauty) Сезон 1 Серии 01-11 (HD1080p WEBRip) Полный 1 сезон',
        ago('2026-05-27'),
        krasota,
        NOW_
      )
    );
    // published after the premiere: kept whatever its names
    assert.ok(
      !isOlderNamesake(
        'Красота / The Beauty (2026)',
        ago('2026-10-29'),
        krasota,
        NOW_
      )
    );
  });

  it('reads the date alone for a title of another original language', () => {
    const odyssey = {
      titles: ['The Odyssey', 'Одиссея'],
      originalLanguage: 'en',
      releaseDate: '2026-07-15',
    };
    assert.ok(
      isOlderNamesake(
        'Одиссея / Odyssey (2025) HDRip | от monstryu',
        ago('2025-12-01'),
        odyssey,
        NOW_
      )
    );
    assert.ok(
      isOlderNamesake('Одиссея (2025) HDRip', ago('2025-12-01'), odyssey, NOW_)
    );
  });

  it('says nothing without a raw title for a Russian title', () => {
    assert.ok(!isOlderNamesake(undefined, ago('2022-06-12'), imperiya, NOW_));
  });
});

describe('firstReleaseDate', () => {
  it('takes the earlier date, of either format', () => {
    assert.equal(firstReleaseDate('2026-10-30', '2026-10-29'), '2026-10-29');
    assert.equal(
      firstReleaseDate('2011-04-17', '2011-04-17T21:00:00Z'),
      '2011-04-17'
    );
    assert.equal(firstReleaseDate(undefined, '2024-05-01'), '2024-05-01');
    assert.equal(firstReleaseDate(undefined, undefined), undefined);
  });
});

describe('hasTranslationOfRussianOriginal', () => {
  const zapadnya = { titles: ['Западня', 'Trap'], originalLanguage: 'ru' };

  it('drops a dubbed release of a foreign namesake', () => {
    for (const title of [
      'Ловушка / Trap / 2024 / ДБ, СТ / BDRip | Дубляж | [Дубляж].rus',
      'Ловушка / Trap / 2024 / ПМ, СТ / WEB-DLRip (AVC) | TVShows | [TVShows].rus',
      'Ловушка / Trap (2024) WEB-DL [H.264/1080p] [DVO] | [ViruseProject Д. Есарев].rus',
      'Западня / Trap (2024) WEB-DL 1080p | Ukr/Eng',
      'Враги (2025) (ПМ) WEB-DL 1080p',
    ]) {
      assert.ok(hasTranslationOfRussianOriginal(title, zapadnya), title);
    }
  });

  it("keeps the title's own releases", () => {
    for (const title of [
      'Западня (1 сезон: 1-4 серии из 04) (2024) WEB-DL 1080p | [Оригинал].rus',
      'Западня [01x01-04 из 04] (2024) WEB-DL 1080p',
      // JacRed's own voice list at the end is not read
      'Западня (2024) WEB-DL 1080p | [Дубляж].rus',
      'Брат 2 (2000) BDRip 1080p | Лицензия',
      // a Russian film that lists a dub too, with the tracker's sign of the original
      'Время первых / 2017 / РУ / ДБ / DVD-9',
      'Мастер и Маргарита / 2023 / РУ / GER Transfer / Blu-Ray (1080p) | Дубляж | [Дубляж].rus',
      'Сталинград / 2013 / РУ, СТ / EUR Transfer / BDRip (1080p) | Дубляж',
      'Серебряные коньки (Михаил Локшин) [2020, Россия, драма, WEB-DL 1080p] Original (Rus, Rus AD) + Sub (Rus, Ukr, Eng, Multi)',
      // a subtitle list names no translation
      'Брат (1997) BDRip 1080p + Sub Ukr, Eng',
    ]) {
      assert.ok(!hasTranslationOfRussianOriginal(title, zapadnya), title);
    }
  });

  it('reads a tag after a subtitle list', () => {
    assert.ok(
      hasTranslationOfRussianOriginal(
        'Ловушка / Trap (2024) WEB-DL 1080p Sub (Rus, Eng) MVO (HDRezka)',
        zapadnya
      )
    );
  });

  it('says nothing for a title of another original language', () => {
    assert.ok(
      !hasTranslationOfRussianOriginal(
        'Ловушка / Trap / 2024 / ДБ, СТ / BDRip',
        { titles: ['Trap'], originalLanguage: 'en' }
      )
    );
    assert.ok(
      !hasTranslationOfRussianOriginal('Trap ДБ', { titles: ['Trap'] })
    );
  });

  it('reads a tag as a word, not inside one', () => {
    assert.ok(
      !hasTranslationOfRussianOriginal('Апокалипсис (2024) WEB-DL', zapadnya)
    );
    assert.ok(!hasTranslationOfRussianOriginal('Пмж (2024) WEB-DL', zapadnya));
  });
});
