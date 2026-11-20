import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstReleaseDate, isPublishedBeforeRelease } from './namesake.js';

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
