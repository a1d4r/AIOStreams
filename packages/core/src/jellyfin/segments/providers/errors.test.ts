import { describe, test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { settingsStore } from '../../../config/index.js';
import { SettingsRepository } from '../../../db/repositories/settings.js';
import type { ProviderContext, SegmentLookup } from '../types.js';
// Through the registry, which settles the import cycle with the core barrel.
import { aniSkipProvider, introDbProvider } from './index.js';
import { retryAfter } from './pause.js';
import { Cache } from '../../../utils/cache.js';

const ctx = (baseUrl: string): ProviderContext => ({
  baseUrl,
  timeoutMs: 1000,
  minConfidence: 0,
  minSubmissions: 0,
  animeSkipClientId: '',
  pmdbApiKey: '',
});

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

const episode: SegmentLookup = {
  kind: 'episode',
  ids: { imdb: 'tt2560140', mal: '38524' },
  season: 3,
  episode: 13,
  animeEpisode: 1,
};

describe('provider failures are thrown, not answered as misses', () => {
  for (const status of [429, 503]) {
    test(`AniSkip ${status}`, async (t) => {
      const agent = await mockApi(t);
      const base = `https://aniskip-${status}.test`;
      agent
        .get(base)
        .intercept({ path: /^\/v2\/skip-times\/38524\/1\?/ })
        .reply(status, {})
        .persist();
      await assert.rejects(aniSkipProvider.fetch(episode, ctx(base)));
    });

    test(`IntroDB ${status}`, async (t) => {
      const agent = await mockApi(t);
      const base = `https://introdb-${status}.test`;
      agent
        .get(base)
        .intercept({ path: /^\/segments\?/ })
        .reply(status, {});
      await assert.rejects(introDbProvider.fetch(episode, ctx(base)));
    });
  }

  test('AniSkip 404 is a miss', async (t) => {
    const agent = await mockApi(t);
    agent
      .get('https://aniskip.test')
      .intercept({ path: /^\/v2\/skip-times\/38524\/1\?/ })
      .reply(404, { found: false });
    assert.deepEqual(
      await aniSkipProvider.fetch(episode, ctx('https://aniskip.test')),
      []
    );
  });
});

describe('a 429 pauses the provider until its Retry-After', () => {
  test('reads Retry-After seconds, else waits a minute', () => {
    assert.equal(retryAfter(new Headers({ 'retry-after': '120' })), 120);
    assert.equal(retryAfter(new Headers({ 'retry-after': 'soon' })), 60);
    assert.equal(retryAfter(new Headers()), 60);
    assert.equal(retryAfter(new Headers({ 'retry-after': '9999999' })), 86_400);
  });

  const cases = [
    {
      name: 'AniSkip',
      cache: 'aniskip-pause',
      path: /^\/v2\/skip-times\/38524\/1\?/,
      fetch: aniSkipProvider.fetch,
    },
    {
      name: 'IntroDB',
      cache: 'introdb-pause',
      path: /^\/segments\?/,
      fetch: introDbProvider.fetch,
    },
  ];
  for (const { name, cache, path, fetch } of cases) {
    test(name, async (t) => {
      const agent = await mockApi(t);
      const base = `https://${name.toLowerCase()}-pause.test`;
      let asked = 0;
      agent
        .get(base)
        .intercept({ path })
        .reply(() => {
          asked++;
          return {
            statusCode: 429,
            data: {},
            responseOptions: { headers: { 'retry-after': '120' } },
          };
        })
        .persist();
      const set = t.mock.method(Cache.getInstance(cache), 'set');
      await assert.rejects(fetch(episode, ctx(base)), /429/);
      await assert.rejects(fetch(episode, ctx(base)), /its reset/);
      assert.equal(asked, 1);
      assert.equal(set.mock.calls[0].arguments[0], base);
      assert.equal(set.mock.calls[0].arguments[2], 120);
    });
  }
});
