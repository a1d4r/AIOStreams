import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StremioTransformer } from './stremio.js';
import type { ParsedStream, UserData } from '../db/schemas.js';

function makeStream(overrides: Partial<ParsedStream>): ParsedStream {
  return {
    id: Math.random().toString(),
    type: 'debrid',
    url: 'https://example.com/play',
    addon: {
      instanceId: 'jacred',
      name: 'JacRed',
      manifestUrl: 'https://example.com/manifest.json',
      enabled: true,
      timeout: 1000,
      preset: { id: 'jacred', type: 'jacred', options: {} },
    },
    ...overrides,
  } as ParsedStream;
}

async function transform(streams: ParsedStream[]) {
  const userData = {
    formatter: { id: 'torrentio' },
    presets: [],
    services: [],
  } as unknown as UserData;
  const response = await new StremioTransformer(userData).transformStreams(
    { success: true, data: { streams, statistics: [] }, errors: [] },
    { userData },
    { provideStreamData: true, disableAutoplay: true }
  );
  // What the stream route sends with res.json().
  return JSON.parse(JSON.stringify(response));
}

describe('StremioTransformer streamData.sources', () => {
  it('outputs the sources without internal ids', async () => {
    const response = await transform([
      makeStream({
        torrent: { infoHash: 'abc' },
        service: { id: 'realdebrid', cached: true, cacheShared: true },
        dedupSources: [
          { instanceId: 'jacred', addon: 'JacRed', cached: [] },
          {
            instanceId: 'torrentio',
            addon: 'Torrentio',
            cached: ['realdebrid', 'torbox'],
          },
        ],
      }),
    ]);
    assert.deepEqual(response.streams[0].streamData.sources, [
      { addon: 'JacRed', cached: [] },
      { addon: 'Torrentio', cached: ['realdebrid', 'torbox'] },
    ]);
  });

  it('omits the field for streams without sources', async () => {
    const response = await transform([makeStream({ type: 'http' })]);
    assert.equal('sources' in response.streams[0].streamData, false);
  });
});
