import { describe, test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { config, settingsStore } from '../../../config/index.js';
import { SettingsRepository } from '../../../db/repositories/settings.js';
import type { ProviderContext, SegmentLookup } from '../types.js';
// Through the registry, which settles the import cycle with the core barrel.
import { theIntroDbProvider } from './index.js';
import { pauseFor } from './theintrodb.js';
import { Cache } from '../../../utils/cache.js';

const BASE = 'https://theintrodb.test';
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

const episode: SegmentLookup = {
  kind: 'episode',
  ids: { imdb: 'tt0903747', tmdb: '1396' },
  numberedBy: 'imdb',
  season: 1,
  episode: 1,
};

describe('theIntroDbProvider', () => {
  test('asks by the id the episode is numbered in', () => {
    assert.equal(theIntroDbProvider.supports(episode, ctx), true);
    assert.equal(
      theIntroDbProvider.supports(
        { ...episode, ids: { mal: '38524' }, numberedBy: 'mal' },
        ctx
      ),
      false
    );
    assert.equal(
      theIntroDbProvider.supports({ ...episode, episode: undefined }, ctx),
      false
    );
  });

  test('waits out a spent daily allowance even when its reset is unreadable', () => {
    const spent = (reset?: string) =>
      pauseFor(
        new Headers({
          'x-ratelimit-reset': '10',
          'x-usagelimit-remaining': '0',
          ...(reset !== undefined && { 'x-usagelimit-reset': reset }),
        })
      );
    assert.equal(spent(), 3600);
    assert.equal(spent('soon'), 3600);
    assert.equal(spent('7200'), 7200);
    // Spent, but the day comes back sooner than an hour: as named.
    assert.equal(spent('120'), 120);
    assert.equal(pauseFor(new Headers({ 'x-ratelimit-reset': '10' })), 10);
    assert.equal(pauseFor(new Headers()), 60);
  });

  test('reads lists, open bounds and drops "no segment" votes and credits from the start', async (t) => {
    const agent = await mockApi(t);
    agent
      .get(BASE)
      .intercept({
        path: '/v4/media?imdb_id=tt0903747&details=true&season=1&episode=1',
      })
      .reply(200, {
        group_duration_ms: 3500000,
        intro: [
          { start_ms: 100000, end_ms: 110000, confidence: 0.2 },
          { start_ms: null, end_ms: 31000, confidence: 0.9 },
        ],
        recap: [{ start_ms: 0, end_ms: 0 }],
        credits: [
          { start_ms: 3431000, end_ms: null },
          { start_ms: null, end_ms: 110000, confidence: 1 },
        ],
        preview: [{ start_ms: 3490000, end_ms: 3500000 }],
      });

    const segments = await theIntroDbProvider.fetch(episode, ctx);
    assert.deepEqual(
      segments.map((s) => [s.type, s.startMs, s.endMs]),
      [
        ['Intro', 0, 31000],
        ['Intro', 100000, 110000],
        ['Outro', 3431000, Number.POSITIVE_INFINITY],
      ]
    );
  });

  test('marks markers of the release closest to a measured length', async (t) => {
    const agent = await mockApi(t);
    const pool = agent.get(BASE);
    const body = (group: number) => ({
      group_duration_ms: group,
      intro: [{ start_ms: 228_000, end_ms: 246_000 }],
    });
    pool
      .intercept({
        path: (path: string) =>
          /imdb_id=tt6\b/.test(path) && /list_versions=true/.test(path),
      })
      .reply(200, {
        versions: [{ duration_ms: 3_494_000 }, { duration_ms: 0 }],
      });
    pool
      .intercept({
        path: (path: string) =>
          /imdb_id=tt6\b/.test(path) && /duration_ms=3494000(&|$)/.test(path),
      })
      .reply(200, body(3_494_000));
    // No release within five minutes: the most submitted one.
    pool
      .intercept({
        path: (path: string) =>
          /imdb_id=tt6\b/.test(path) && !/duration_ms|list_versions/.test(path),
      })
      .reply(200, body(3_500_000));

    const lookup = { ...episode, ids: { imdb: 'tt6' } };
    const [same] = await theIntroDbProvider.fetch(
      { ...lookup, durationMs: 3_495_000 },
      ctx
    );
    assert.equal(same.matchesFile, true);
    assert.equal(same.releaseMs, 3_494_000);
    const [other] = await theIntroDbProvider.fetch(
      { ...lookup, durationMs: 2_600_000 },
      ctx
    );
    assert.equal(other.matchesFile, undefined);
    assert.equal(other.releaseMs, 3_500_000);
  });

  test('treats 404 as a miss and other failures as errors', async (t) => {
    const agent = await mockApi(t);
    const pool = agent.get(BASE);
    pool
      .intercept({ path: /imdb_id=tt1\b/ })
      .reply(404, { code: 'no_submissions' });
    pool.intercept({ path: /imdb_id=tt2\b/ }).reply(500, {});

    assert.deepEqual(
      await theIntroDbProvider.fetch({ ...episode, ids: { imdb: 'tt1' } }, ctx),
      []
    );
    await assert.rejects(
      theIntroDbProvider.fetch({ ...episode, ids: { imdb: 'tt2' } }, ctx)
    );
  });

  test('takes only end credits for a movie', async (t) => {
    const agent = await mockApi(t);
    agent
      .get(BASE)
      .intercept({ path: '/v4/media?tmdb_id=27205&details=true' })
      .reply(200, {
        intro: [{ start_ms: null, end_ms: 38000 }],
        credits: [{ start_ms: 8400000, end_ms: 8880000 }],
      });
    const segments = await theIntroDbProvider.fetch(
      { kind: 'movie', ids: { tmdb: '27205', imdb: 'tt1375666' } },
      ctx
    );
    assert.deepEqual(
      segments.map((s) => s.type),
      ['Outro']
    );
  });

  test('asks once per release, however many lengths it is played at', async (t) => {
    const agent = await mockApi(t);
    const pool = agent.get(BASE);
    const asked: string[] = [];
    pool
      .intercept({ path: /imdb_id=tt0388629\b/ })
      .reply((req) => {
        const url = new URL(req.path, BASE);
        asked.push(url.search);
        if (url.searchParams.get('list_versions'))
          return {
            statusCode: 200,
            data: {
              versions: [
                { duration_ms: 0, submission_count: 2 },
                { duration_ms: 1476000, submission_count: 2 },
                { duration_ms: 1542000, submission_count: 1 },
              ],
            },
          };
        const release = Number(url.searchParams.get('duration_ms') ?? 1476000);
        return {
          statusCode: 200,
          data: {
            group_duration_ms: release,
            intro: [{ start_ms: release / 100, end_ms: release / 10 }],
          },
        };
      })
      .persist();

    const lengths = [1541, 1542.4, 1544, 1549, 1470, 1478, 1300, 900];
    const intros = [];
    for (const seconds of lengths) {
      const [intro] = await theIntroDbProvider.fetch(
        {
          ...episode,
          ids: { imdb: 'tt0388629' },
          durationMs: seconds * 1000,
        },
        ctx
      );
      intros.push(intro?.startMs);
    }
    // The list, then 1542 s, 1476 s and the most submitted (none within 5 min of 900 s).
    assert.equal(asked.length, 4);
    assert.deepEqual(
      intros,
      [15420, 15420, 15420, 15420, 14760, 14760, 14760, 14760]
    );
  });

  test('a release list miss is one request', async (t) => {
    const agent = await mockApi(t);
    let asked = 0;
    agent
      .get(BASE)
      .intercept({ path: /imdb_id=tt5\b/ })
      .reply(() => {
        asked++;
        return { statusCode: 404, data: { code: 'no_submissions' } };
      })
      .persist();
    const lookup = { ...episode, ids: { imdb: 'tt5' }, durationMs: 1400000 };
    assert.deepEqual(await theIntroDbProvider.fetch(lookup, ctx), []);
    assert.deepEqual(
      await theIntroDbProvider.fetch({ ...lookup, durationMs: 1500000 }, ctx),
      []
    );
    assert.equal(asked, 1);
  });

  test('keeps an empty release list only as long as a miss', async (t) => {
    const agent = await mockApi(t);
    agent
      .get(BASE)
      .intercept({ path: /imdb_id=tt7\b.*list_versions=true/ })
      .reply(200, { versions: [] });
    const set = t.mock.method(Cache.getInstance('theintrodb-versions'), 'set');
    const lookup = { ...episode, ids: { imdb: 'tt7' }, durationMs: 1400000 };
    assert.deepEqual(await theIntroDbProvider.fetch(lookup, ctx), []);
    assert.equal(set.mock.callCount(), 1);
    const [, list, ttl] = set.mock.calls[0].arguments;
    assert.deepEqual(list, []);
    assert.equal(ttl, config.jellyfin.segments.negativeTtl);
    assert.notEqual(ttl, config.jellyfin.segments.ttl);
  });

  // Last: the pause it sets holds for the rest of the process.
  test('stops asking after a rate limit until its reset', async (t) => {
    const agent = await mockApi(t);
    let asked = 0;
    agent
      .get(BASE)
      .intercept({ path: /imdb_id=tt3\b/ })
      .reply(() => {
        asked++;
        return {
          statusCode: 429,
          data: {},
          responseOptions: {
            headers: {
              'x-ratelimit-reset': '10',
              'x-usagelimit-remaining': '0',
              'x-usagelimit-reset': '7200',
            },
          },
        };
      })
      .persist();
    const lookup = { ...episode, ids: { imdb: 'tt3' } };
    await assert.rejects(theIntroDbProvider.fetch(lookup, ctx), /429/);
    await assert.rejects(theIntroDbProvider.fetch(lookup, ctx), /its reset/);
    await assert.rejects(
      theIntroDbProvider.fetch({ ...episode, ids: { imdb: 'tt4' } }, ctx),
      /its reset/
    );
    assert.equal(asked, 1);
  });
});
