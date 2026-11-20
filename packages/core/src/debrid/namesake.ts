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

// A Russian tracker names a foreign release in Latin script too: after « / »
// ("Красота / The Beauty / Сезон: 1", "Полярный / Polar / 2019 / ПМ"), or in
// parentheses right after the Russian name ("Красота (The Beauty) Сезон 1").
// What follows the names (the year, "РУ", the format) is not a name.
const NAMES_END = /^(?:\d|РУ(?!\p{L})|СТ(?!\p{L}))/u;
// as trackers write them: "WEB-DL", "WEBRip", "HDTVRip", "SATRip", "Full HD"
const NOT_A_NAME =
  /^(?:WEB|HDTV|HD|BD|DVD|SAT|IPTV|TV|DVB|AVC|HEVC|TS|CAM|UHD|MP4|Blu-?[Rr]ay|Remux|MVO|DVO|AVO|Sub|Rus|Original|Full HD)(?:-?DL)?(?:Rip)?(?!\p{L})/u;
const RUSSIAN_NAME_THEN_PARENS =
  /^[^([]*\p{Script=Cyrillic}[^([]*\(([^()]*)\)/u;

function isLatinName(part: string): boolean {
  const s = part.trim();
  const latin = s.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const cyrillic = s.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  if (latin < 2 || latin <= cyrillic) return false;
  // a format or a tag ("AVC", "HD1080p WEBRip"), not a name
  if (NAMES_END.test(s) || NOT_A_NAME.test(s) || /^\p{Lu}+$/u.test(s)) {
    return false;
  }
  return true;
}

/** Splits at « / » outside brackets: directors' and voices' lists keep theirs. */
function splitNames(head: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (depth === 0 && head.startsWith(' / ', i)) {
      parts.push(head.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  parts.push(head.slice(start));
  return parts;
}

/** The release carries a name in Latin script besides the Russian one. */
export function hasLatinName(rawTitle: string): boolean {
  const head = rawTitle.split(' | ')[0];
  // a scene name: no Russian at all ("The.Beauty.2026.S01E01.1080p.WEB")
  if (
    !/\p{Script=Cyrillic}/u.test(head) &&
    (head.match(/\p{Script=Latin}/gu)?.length ?? 0) >= 2
  ) {
    return true;
  }
  const [first, ...others] = splitNames(head);
  const inParens = first.match(RUSSIAN_NAME_THEN_PARENS)?.[1];
  if (inParens && isLatinName(inParens)) return true;
  for (const other of others) {
    const name = other.split(/\s*[([]/)[0].trim();
    if (NAMES_END.test(name)) break;
    if (isLatinName(name)) return true;
  }
  return false;
}

/**
 * A text result of another, older title: published more than a month before
 * this one came out. TMDB dates some Russian titles later than they came out
 * (a rerun on TV, a release abroad after the online premiere at home: «Балабол»
 * on TMDB is May 2014, its trackers' SATRip December 2013), so for a
 * Russian-language title the release must also name itself in Latin script,
 * as a foreign namesake on a Russian tracker does. A dubbed one without a
 * Latin name is dropped by hasTranslationOfRussianOriginal.
 */
export function isOlderNamesake(
  rawTitle: string | undefined,
  ageHours: number | undefined,
  metadata: TitleMetadata,
  now: number = Date.now()
): boolean {
  if (!isPublishedBeforeRelease(ageHours, metadata, now)) return false;
  if (metadata.originalLanguage !== 'ru') return true;
  return !!rawTitle && hasLatinName(rawTitle);
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
