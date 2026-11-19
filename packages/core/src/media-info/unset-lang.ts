import FileParser from '../parser/file.js';
import type { ParsedMediaInfo } from '../utils/index.js';

const SUBS = String.raw`(?:(?:hard|soft)?sub(?:s|bed|titles?)?|forced|sdh|hc|(?:субт|саб)\p{Script=Cyrillic}{0,12})`;
const RUS = String.raw`rus(?:sian)?`;
// "Sub Rus", "Rus.HardSub", "Rus субтитры": Russian subtitles, which the
// parser takes for audio.
const RUSSIAN_SUBS = new RegExp(
  String.raw`(?<![a-z])${SUBS}[\W_]{0,3}${RUS}(?![a-z])|(?<![a-z])${RUS}[\W_]{0,3}${SUBS}(?![a-z])`,
  'giu'
);
// Russian audio in files beside the video, not in it: "RUS(ext)", "Rus (внешняя)".
const EXTERNAL_RUSSIAN =
  /(?<![a-z])rus[\W_]{0,3}(?:ext(?:ernal)?(?![a-z])|внешн)/iu;
// The original audio, English for the releases this is about.
const ORIGINAL =
  /(?<![a-z])orig(?:inal)?(?![a-z])|(?<!\p{L})оригинал(?!\p{L})/iu;
// To the parser any Cyrillic means Russian, and a Russian site names an
// English-only release in Cyrillic too.
const CYRILLIC = /\p{Script=Cyrillic}+/gu;
// A release name is a few hundred characters; a longer one comes from an addon.
const MAX_NAME_LENGTH = 1000;

function nameSaysOnlyRussian(names: (string | undefined)[]): boolean {
  const langs = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    if (name.length > MAX_NAME_LENGTH) return false;
    if (EXTERNAL_RUSSIAN.test(name) || ORIGINAL.test(name)) return false;
    const latin = name
      .replace(RUSSIAN_SUBS, ' ')
      .replace(CYRILLIC, ' ')
      // Left gaps keep the parser from finding the title, whose words
      // ("Russian Doll") it would then read as languages.
      .replace(/\s+/g, ' ');
    for (const lang of FileParser.parse(latin).languages) langs.add(lang);
  }
  return langs.size === 1 && langs.has('Russian');
}

/**
 * A container with no language set reads as English in Matroska and `und`
 * in MP4, so a lone untitled audio track tagged either says little. When the
 * release name writes out Russian and no other language, the track's language
 * is dropped and the stream's languages come from the name, as without a probe.
 * The info stays `mediaInfoQuality: probe` for its other fields.
 */
export function dropUnsetAudioLang(
  info: ParsedMediaInfo | undefined,
  ...names: (string | undefined)[]
): ParsedMediaInfo | undefined {
  const track = info?.audioTracks?.length === 1 ? info.audioTracks[0] : null;
  if (!info || !track || track.title) return info;
  if (track.lang && track.lang !== 'English') return info;
  if (!nameSaysOnlyRussian(names)) return info;
  const { lang: _, ...rest } = track;
  return { ...info, languages: undefined, audioTracks: [rest] };
}
