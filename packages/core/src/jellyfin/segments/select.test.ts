import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { plausible, sanitise } from './select.js';
import type { Segment, SegmentType } from './types.js';

function seg(type: SegmentType, startMs: number, endMs: number): Segment {
  return { type, startMs, endMs, provider: 'introdb' };
}

const ranges = (segments: Segment[]) =>
  segments.map((s) => [s.type, s.startMs, s.endMs]);

describe('sanitise', () => {
  test('drops empty, reversed and placeholder-short ranges', () => {
    const out = sanitise(
      [
        seg('Recap', 0, 0), // TheIntroDB: "no recap"
        seg('Intro', 0, 5000), // IntroDB's floor, House of the Dragon S01E01
        seg('Intro', 90_000, 80_000),
        seg('Intro', 0, 31_000),
      ],
      {}
    );
    assert.deepEqual(ranges(out), [['Intro', 0, 31_000]]);
  });

  test('needs a length for an open end, and runs it to that length', () => {
    const credits = seg('Outro', 3_431_000, Number.POSITIVE_INFINITY);
    assert.deepEqual(sanitise([credits], {}), []);
    assert.deepEqual(ranges(sanitise([credits], { runtimeMs: 3_480_000 })), [
      ['Outro', 3_431_000, 3_480_000],
    ]);
  });

  test('reads a null end, as cached by Redis or SQL, as open', () => {
    const cached = {
      ...seg('Outro', 1_300_000, 0),
      endMs: null,
    } as unknown as Segment;
    assert.deepEqual(ranges(sanitise([cached], { durationMs: 1_420_000 })), [
      ['Outro', 1_300_000, 1_420_000],
    ]);
  });

  test('clamps to a listed runtime, which is only minutes', () => {
    const out = sanitise([seg('Outro', 2_700_000, 2_760_000)], {
      runtimeMs: 2_700_000 + 30_000,
    });
    assert.deepEqual(ranges(out), [['Outro', 2_700_000, 2_730_000]]);
  });

  test('rejects what overruns a measured length, beyond a little slack', () => {
    // Breaking Bad S01E01: credits of the 3500 s cut against a 2839 s file.
    const file = { durationMs: 2_839_000 };
    assert.deepEqual(sanitise([seg('Outro', 3_432_500, 3_493_290)], file), []);
    assert.deepEqual(sanitise([seg('Outro', 2_780_000, 2_900_000)], file), []);
    assert.deepEqual(
      ranges(sanitise([seg('Outro', 2_780_000, 2_850_000)], file)),
      [['Outro', 2_780_000, 2_839_000]]
    );
  });

  test('allows 25 s past the file for a length rounded to 10 s', () => {
    // File 1425 s asked as 1430 s; AniSkip's window reaches 1450 s.
    const file = { durationMs: 1_425_000 };
    assert.deepEqual(
      ranges(sanitise([seg('Outro', 1_330_000, 1_450_000)], file)),
      [['Outro', 1_330_000, 1_425_000]]
    );
    assert.deepEqual(sanitise([seg('Outro', 1_330_000, 1_451_000)], file), []);
  });
});

describe('plausible', () => {
  const outro = (startMs: number, endMs: number, releaseMs?: number) => ({
    ...seg('Outro', startMs, endMs),
    provider: 'theintrodb' as const,
    ...(releaseMs && { releaseMs }),
  });

  test('drops credits in the first half of the file', () => {
    // Breaking Bad S05E14, d=2847: TheIntroDB credits 291-307 s.
    assert.equal(
      plausible(outro(291_000, 307_000), { durationMs: 2_847_000 }),
      false
    );
    // One Piece S01E01, d=1542: TheIntroDB credits 0-110 s.
    assert.equal(
      plausible(outro(0, 110_026), { durationMs: 1_542_000 }),
      false
    );
    // Attack on Titan S01E01, d=1474: AniSkip 16498/1 "ed" 11-101 s.
    assert.equal(
      plausible(
        { ...seg('Outro', 11_000, 101_000), provider: 'aniskip' },
        { durationMs: 1_474_000 }
      ),
      false
    );
    // The right ones: IntroDB 2787-2846 s, One Piece S21E1 1393-1430 s.
    assert.equal(
      plausible(seg('Outro', 2_787_000, 2_846_000), { durationMs: 2_847_000 }),
      true
    );
    assert.equal(
      plausible(seg('Outro', 1_393_000, 1_430_000), { durationMs: 1_431_000 }),
      true
    );
  });

  test('falls back to the length the marker was timed on, then the runtime', () => {
    assert.equal(plausible(outro(291_000, 307_000, 2_847_000), {}), false);
    assert.equal(plausible(outro(2_787_000, 2_846_000, 2_847_000), {}), true);
    assert.equal(
      plausible(seg('Outro', 600_000, 700_000), { runtimeMs: 2_700_000 }),
      false
    );
  });

  test('with no length, wants credits after the opening and past 5 minutes', () => {
    assert.equal(plausible(seg('Outro', 291_000, 307_000), {}), false);
    assert.equal(plausible(seg('Outro', 3_431_000, 3_500_000), {}), true);
    assert.equal(plausible(seg('Outro', 400_000, 500_000), {}, 450_000), false);
  });

  test('wants openings and recaps over by half the length', () => {
    const file = { durationMs: 1_447_000 };
    assert.equal(plausible(seg('Intro', 111_300, 204_800), file), true);
    assert.equal(plausible(seg('Recap', 0, 100_000), file), true);
    assert.equal(plausible(seg('Intro', 1_300_000, 1_390_000), file), false);
    // Without a length an opening is taken where it is.
    assert.equal(plausible(seg('Intro', 1_300_000, 1_390_000), {}), true);
  });
});
