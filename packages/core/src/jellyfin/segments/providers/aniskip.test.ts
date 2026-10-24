import { describe, test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { settingsStore } from '../../../config/index.js';
import { SettingsRepository } from '../../../db/repositories/settings.js';
import type { ProviderContext, SegmentLookup } from '../types.js';
// Through the registry, which settles the import cycle with the core barrel.
import { aniSkipProvider } from './index.js';

const BASE = 'https://aniskip.test';
const TYPES = 'types=op&types=ed&types=recap&types=mixed-op&types=mixed-ed';
const ctx: ProviderContext = {
  baseUrl: BASE,
  timeoutMs: 1000,
  minConfidence: 0,
  minSubmissions: 0,
  animeSkipClientId: '',
  pmdbApiKey: '',
};

async function mockApi(t: TestContext): Promise<MockAgent> {
  mock.method(SettingsRepository, 'getAll', async () => []);
  mock.method(SettingsRepository, 'getVersion', async () => 0);
  await settingsStore.initialise();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  t.after(() => setGlobalDispatcher(previous));
  return agent;
}

function found(start: number, end: number, length: number) {
  return {
    found: true,
    results: [
      {
        interval: { startTime: start, endTime: end },
        skipType: 'op',
        episodeLength: length,
      },
    ],
  };
}

// Attack on Titan S3E13: MAL 38524, episode 1 of that entry.
const aot: SegmentLookup = {
  kind: 'episode',
  ids: { imdb: 'tt2560140', mal: '38524' },
  season: 3,
  episode: 13,
  animeEpisode: 1,
};

describe('aniSkipProvider', () => {
  test("asks for the entry's episode, never the stated one", () => {
    assert.equal(aniSkipProvider.supports(aot, ctx), true);
    assert.equal(
      aniSkipProvider.supports({ ...aot, animeEpisode: undefined }, ctx),
      false
    );
  });

  test('asks a measured length directly, once', async (t) => {
    const agent = await mockApi(t);
    agent
      .get(BASE)
      .intercept({
        path: `/v2/skip-times/38524/1?${TYPES}&episodeLength=1420`,
      })
      .reply(200, found(111, 205, 1419.5));

    const segments = await aniSkipProvider.fetch(
      { ...aot, durationMs: 1_421_300 },
      ctx
    );
    assert.deepEqual(
      segments.map((s) => [s.type, s.startMs, s.endMs]),
      [['Intro', 111_000, 205_000]]
    );
  });

  test('gives nothing when no submission fits the measured length', async (t) => {
    const agent = await mockApi(t);
    agent
      .get(BASE)
      .intercept({
        path: `/v2/skip-times/38524/1?${TYPES}&episodeLength=1300`,
      })
      .reply(404, { found: false, results: [] });
    // Any other request would fail on disableNetConnect.
    assert.deepEqual(
      await aniSkipProvider.fetch({ ...aot, durationMs: 1_300_000 }, ctx),
      []
    );
  });

  test('discovers releases with 0 when only a runtime is known', async (t) => {
    const agent = await mockApi(t);
    const pool = agent.get(BASE);
    pool
      .intercept({ path: `/v2/skip-times/38524/1?${TYPES}&episodeLength=0` })
      .reply(200, found(100, 190, 1440.2));
    pool
      .intercept({
        path: `/v2/skip-times/38524/1?${TYPES}&episodeLength=1440.2`,
      })
      .reply(200, found(101, 191, 1440.2));
    const segments = await aniSkipProvider.fetch(
      { ...aot, runtimeMs: 1_440_000 },
      ctx
    );
    assert.deepEqual(
      segments.map((s) => s.startMs),
      [101_000]
    );
  });
});
