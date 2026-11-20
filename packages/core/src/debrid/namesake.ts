import type { TitleMetadata } from './base.js';

/**
 * Tells a namesake of the same year from the title in a text search result,
 * where the release name alone passes the title check: "The Beauty" (FX, 2026)
 * for "Красота" (2026, TMDB en-US "Beauty"), the film "Trap" (2024) for the
 * series "Западня" (2024, en-US "Trap").
 */

const HOUR_MS = 3_600_000;
// A release a little ahead of the title's first date is a screener or a date
// off by a few days in TMDB; a month ahead it is another title's.
const RELEASE_SLACK_MS = 30 * 24 * HOUR_MS;

/** The earlier of the dates ('YYYY-MM-DD', or ISO with a time): a later one would drop releases. */
export function firstReleaseDate(
  ...dates: (string | undefined)[]
): string | undefined {
  return dates.filter((d): d is string => !!d).sort()[0];
}

/**
 * Published more than a month before the title first came out (a movie's
 * release, a series' first air date).
 */
export function isPublishedBeforeRelease(
  ageHours: number | undefined,
  metadata: TitleMetadata,
  now: number = Date.now()
): boolean {
  if (ageHours === undefined || !Number.isFinite(ageHours)) return false;
  if (!metadata.releaseDate) return false;
  const released = Date.parse(metadata.releaseDate);
  if (Number.isNaN(released)) return false;
  return now - ageHours * HOUR_MS < released - RELEASE_SLACK_MS;
}

// Translation tags of Russian trackers: voice-over kinds (ПМ, ДБ, MVO...) and
// the studios that only dub foreign content.
const TRANSLATION =
  /(?<!\p{L})(ПМ|ПД|ДБ|ЛМ|ЛО|АП|MVO|DVO|AVO|Дубляж|Дублированный|Многоголосый|Двухголосый|Одноголосый|Авторский|Профессиональный|LostFilm|HDrezka|Ukr)(?!\p{L})/iu;
// The tracker's own sign of Russian-original audio: kinozal's "/ РУ /",
// rutracker's "Original (Rus...)". Such a release may list a dub as well.
const RUSSIAN_ORIGINAL =
  /\/\s*РУ(?![\p{L}])|(?:Original|Оригинал)\s*\(?\s*(?:Rus|Рус)/iu;
// A subtitle list ("Sub (Rus, Ukr, Eng)", "Sub Ukr") names no translation.
const SUBTITLES = /(?<!\p{L})(?:Subs?|Субтитры)(?!\p{L})[^|+/\])]*\)?/giu;

/**
 * A Russian-language title needs no translation: a release that carries one,
 * and no sign of Russian-original audio, is of a foreign namesake. JacRed's
 * own voice list (" | [...].rus", TorznabXmlFormatter.ItemXml of jacred-fdb)
 * is left out, it is a guess of JacRed's.
 */
export function hasTranslationOfRussianOriginal(
  rawTitle: string | undefined,
  metadata: TitleMetadata
): boolean {
  if (metadata.originalLanguage !== 'ru' || !rawTitle) return false;
  const name = rawTitle.split(' | [')[0];
  if (RUSSIAN_ORIGINAL.test(name)) return false;
  return TRANSLATION.test(name.replace(SUBTITLES, ''));
}
