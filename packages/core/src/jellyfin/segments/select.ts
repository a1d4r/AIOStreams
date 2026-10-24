import { lengthOf } from './length.js';
import type { Segment, SegmentLookup } from './types.js';

/**
 * At or below this a marker is noise rather than a segment: IntroDB accepts
 * nothing shorter than 5 s, and what sits exactly at that floor ("intro"
 * 0–5 s) is a placeholder, not an opening. A client will not offer a skip
 * that short anyway.
 */
const MIN_SEGMENT_MS = 5000;

/**
 * Past a measured file length by more than this, a marker was timed on a
 * longer cut, so its start is off too. AniSkip's own release window is ±20 s
 * around the length asked, which is the file's rounded to 10 s (up to 5 s
 * off), so a marker of a release it matched can end 25 s past the file.
 */
const PAST_END_SLACK_MS = 25_000;

/**
 * Where an opening, a recap and end credits can sit, as a share of the
 * length: openings and recaps end in the first half, credits start in the
 * second. Databases carry credits timed at the start of an episode (One Piece
 * S1E1 0–110 s on TheIntroDB, Attack on Titan S1E1 11–101 s on AniSkip) and a
 * client that offers "next episode" on credits would cut the episode short.
 */
const HALF = 0.5;

/**
 * With no length at all, credits starting earlier than this are not credits:
 * the shortest common episodes run about 11 minutes, which by the rule above
 * puts their credits past 5.5 minutes.
 */
const MIN_OUTRO_START_MS = 5 * 60_000;

/**
 * Timestamps are submitted per title while a file is one particular release, and
 * clients decide for themselves whether to auto-skip, so rejecting what cannot
 * fit the file is the only guard there is. A listed runtime is minutes and
 * only bounds markers; a measured length also rejects ones that overrun it.
 */
export function sanitise(
  segments: Segment[],
  lookup: Pick<SegmentLookup, 'runtimeMs' | 'durationMs'>
): Segment[] {
  const lengthMs = lengthOf(lookup as SegmentLookup);
  const measured = !!lookup.durationMs;
  const out: Segment[] = [];
  for (const segment of segments) {
    const startMs = Math.round(segment.startMs);
    // An open end is Infinity, which the Redis and SQL caches store as null.
    let endMs = segment.endMs == null ? Infinity : Math.round(segment.endMs);
    if (!Number.isFinite(startMs) || startMs < 0) continue;
    if (!Number.isFinite(endMs)) {
      // An open end means it runs to the end of the file.
      if (!lengthMs) continue;
      endMs = lengthMs;
    }
    if (lengthMs) {
      if (startMs >= lengthMs) continue;
      if (measured && endMs > lengthMs + PAST_END_SLACK_MS) continue;
      endMs = Math.min(endMs, lengthMs);
    }
    // Also drops reversed and empty ranges, such as TheIntroDB's 0–0.
    if (endMs - startMs <= MIN_SEGMENT_MS) continue;
    out.push({ ...segment, startMs, endMs });
  }
  return out;
}

/**
 * Whether a marker sits where its type can: openings and recaps end by half
 * the length, credits start after half of it and after the opening chosen
 * (`introEndMs`). The length is the file's, else the one the provider timed
 * the marker on, else the listed runtime; with none, credits only need to
 * start after the opening and past MIN_OUTRO_START_MS.
 */
export function plausible(
  segment: Segment,
  lookup: Pick<SegmentLookup, 'runtimeMs' | 'durationMs'>,
  introEndMs?: number
): boolean {
  const lengthMs =
    lookup.durationMs || segment.releaseMs || lookup.runtimeMs || undefined;
  if (segment.type !== 'Outro')
    return !lengthMs || segment.endMs <= lengthMs * HALF;
  if (introEndMs !== undefined && segment.startMs < introEndMs) return false;
  return segment.startMs >= (lengthMs ? lengthMs * HALF : MIN_OUTRO_START_MS);
}
