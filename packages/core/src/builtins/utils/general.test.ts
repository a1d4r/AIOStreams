import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../utils/index.js';
import { ageInHoursSince, parseIndexerInfoUrl } from './general.js';

describe('ageInHoursSince', () => {
  it('rounds up to the next full hour', () => {
    const date = new Date(Date.now() - 47.5 * 60 * 60 * 1000).toISOString();
    assert.equal(ageInHoursSince(date), 48);
  });

  it('returns undefined for an unparsable date', () => {
    assert.equal(ageInHoursSince('not-a-date'), undefined);
  });

  it('returns undefined for a date in the future', () => {
    const date = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.equal(ageInHoursSince(date), undefined);
  });
});

describe('parseIndexerInfoUrl', () => {
  it('keeps an http(s) URL', () => {
    const url = 'http://rutor.info/torrent/669136/venom_venom-2018-hdrip';
    assert.equal(parseIndexerInfoUrl(url), url);
    assert.equal(
      parseIndexerInfoUrl(' https://example.org/details/1 '),
      'https://example.org/details/1'
    );
  });

  it('drops the #comments anchor', () => {
    assert.equal(
      parseIndexerInfoUrl('https://example.org/details/1#comments'),
      'https://example.org/details/1'
    );
  });

  it('keeps the URL as given, without re-encoding it', () => {
    const url = 'https://rutracker.org/forum/viewtopic.php?t=1&q=Веном%20';
    assert.equal(parseIndexerInfoUrl(url), url);
  });

  it('rejects anything but a well-formed http(s) URL', () => {
    for (const value of [
      undefined,
      '',
      'javascript:alert(1)',
      'magnet:?xt=urn:btih:abc',
      '/details/1',
      'ftp://example.org/details/1',
      'https://example.org/a b',
      'http://a\u0000b/x',
      'http://example.org/\u001b[31m',
      'http://example.org/\u007f',
      'http://example.org/a\tb',
      'http:///',
      'http://[::1',
      'http://user:pass@example.org/details/1',
      'http://user@example.org/details/1',
      `https://example.org/${'a'.repeat(100_000)}`,
    ]) {
      assert.equal(
        parseIndexerInfoUrl(value),
        undefined,
        JSON.stringify(value)?.slice(0, 80)
      );
    }
  });
});
