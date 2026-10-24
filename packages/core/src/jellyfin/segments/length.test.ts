import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { askedLength, lengthOf } from './length.js';
import type { SegmentLookup } from './types.js';

const episode: SegmentLookup = { kind: 'episode', ids: { imdb: 'tt1' } };

describe('askedLength', () => {
  test('rounds a file length to 10 s and marks it exact', () => {
    assert.deepEqual(askedLength({ ...episode, durationMs: 1_424_999 }), {
      ms: 1_420_000,
      exact: true,
    });
    assert.deepEqual(askedLength({ ...episode, durationMs: 1_425_000 }), {
      ms: 1_430_000,
      exact: true,
    });
  });

  test('prefers the file length over a listed runtime', () => {
    const lookup = { ...episode, runtimeMs: 1_440_000, durationMs: 1_421_000 };
    assert.deepEqual(askedLength(lookup), { ms: 1_420_000, exact: true });
    assert.equal(lengthOf(lookup), 1_421_000);
  });

  test('falls back to the runtime, not exact', () => {
    assert.deepEqual(askedLength({ ...episode, runtimeMs: 1_440_000 }), {
      ms: 1_440_000,
      exact: false,
    });
  });

  test('has nothing without a usable length', () => {
    assert.equal(askedLength(episode), undefined);
    assert.equal(askedLength({ ...episode, durationMs: -5 }), undefined);
    assert.equal(lengthOf(episode), undefined);
  });
});
