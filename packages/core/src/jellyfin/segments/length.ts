import type { SegmentLookup } from './types.js';

/**
 * Lengths are asked about in steps this wide, and the step is what is sent, so
 * a cached answer is exactly the one its key would fetch. Encodes of one
 * release differ by a second or two while cuts that move the markers (a
 * recap, an ad-break edit) differ by half a minute or more; AniSkip matches
 * ±20 s around the length asked and TheIntroDB clusters within five minutes,
 * so being up to 5 s off still lands in the file's own release.
 */
const LENGTH_STEP_MS = 10_000;

export interface AskedLength {
  ms: number;
  /** Measured from the file rather than listed for the title. */
  exact: boolean;
}

/** The length to ask providers about: the file's if known, else the listed runtime. */
export function askedLength(lookup: SegmentLookup): AskedLength | undefined {
  const exact = !!lookup.durationMs;
  const raw = lookup.durationMs || lookup.runtimeMs;
  if (!raw || !Number.isFinite(raw) || raw <= 0) return undefined;
  return {
    ms: Math.max(
      LENGTH_STEP_MS,
      Math.round(raw / LENGTH_STEP_MS) * LENGTH_STEP_MS
    ),
    exact,
  };
}

/** What markers are checked and clamped against. */
export function lengthOf(lookup: SegmentLookup): number | undefined {
  return lookup.durationMs || lookup.runtimeMs || undefined;
}
