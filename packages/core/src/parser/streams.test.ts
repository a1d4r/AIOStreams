import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Use the normal core entry point to initialise the parser's dependency graph.
import '../index.js';
import StreamParser from './streams.js';
import { BuiltinStreamParser } from '../presets/builtin.js';
import type { Addon, ParsedStream, Stream } from '../db/schemas.js';

const parser = Object.create(StreamParser.prototype) as {
  convertISO6392ToLanguage: (code: string) => string | undefined;
};

describe('convertISO6392ToLanguage', () => {
  it('maps ISO 639-2/B codes to the same language as their T codes', () => {
    assert.equal(parser.convertISO6392ToLanguage('ger'), 'German');
    assert.equal(parser.convertISO6392ToLanguage('fre'), 'French');
    assert.equal(parser.convertISO6392ToLanguage('dut'), 'Dutch');
  });
});

describe('the unconfirmed mark of a stream', () => {
  const addon = {
    instanceId: 'builtin',
    name: 'Builtin',
    manifestUrl: 'https://builtin.example/manifest.json',
    enabled: true,
    preset: { id: 'builtin', type: 'torznab', options: {} },
  } as unknown as Addon;
  const stream = {
    name: 'P2P',
    description: 'Film (2006) WEB-DL 2160p',
    infoHash: 'a'.repeat(40),
    behaviorHints: { filename: 'Film (2006) WEB-DL 2160p.mkv' },
    unconfirmed: { reason: 'title' },
  } as unknown as Stream;

  it("is read from a built-in addon's stream", () => {
    const parsed = new BuiltinStreamParser(addon).parse({ ...stream });
    assert.deepEqual((parsed as ParsedStream).unconfirmed, {
      reason: 'title',
    });
  });

  it("is not taken from another addon's stream", () => {
    const parsed = new StreamParser(addon).parse({ ...stream });
    assert.equal((parsed as ParsedStream).unconfirmed, undefined);
  });
});
