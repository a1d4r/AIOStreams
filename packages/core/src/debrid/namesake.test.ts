import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstReleaseDate,
  hasTranslationOfRussianOriginal,
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
