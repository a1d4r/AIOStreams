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
