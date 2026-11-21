import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';
import StreamFetcher from './fetcher.js';
import StreamFilterer from './filterer.js';
import FileParser from '../parser/file.js';
import { Wrapper } from '../main/wrapper.js';
import { IdParser } from '../utils/index.js';
import type { Addon, ParsedStream, UserData } from '../db/schemas.js';

function makeAddon(id: string): Addon {
  return {
    instanceId: id,
    name: id,
    manifestUrl: `https://${id}.example/manifest.json`,
    enabled: true,
    timeout: 1000,
    preset: { id, type: 'custom', options: {} },
  } as unknown as Addon;
}

const textSearch = makeAddon('text-search');
const byId = makeAddon('by-id');

function makeStream(addon: Addon, filename: string): ParsedStream {
  return {
    id: `${addon.preset.id}:${filename}`,
    type: 'p2p',
    filename,
    parsedFile: FileParser.parse(filename),
    addon,
  } as unknown as ParsedStream;
}

// Each addon's results; the text search one has another year.
function mockAddons() {
  mock.method(Wrapper.prototype, 'getStreams', async function (this: any) {
    return this.addon.preset.id === 'text-search'
      ? [makeStream(textSearch, 'Film (2006) WEB-DL 2160p')]
      : [makeStream(byId, 'Film (2011) WEB-DL 1080p')];
  });
}

const id = 'tt0000001';
const context: any = {
  type: 'movie',
  id,
  parsedId: IdParser.parse(id, 'movie'),
  isAnime: false,
  queryType: 'movie',
  startAllFetches: () => {},
  getPermittedPatterns: async () => ({
    permitted: new Set(),
    unrestricted: true,
  }),
  getMetadata: async () => ({
    title: 'Film',
    titles: [{ title: 'Film' }],
    year: 2011,
  }),
  getReleaseDates: async () => undefined,
  getEpisodeAirDate: async () => undefined,
  getEpisodeRuntime: async () => undefined,
  getSeaDex: async () => undefined,
  toExpressionContext: () => ({ type: 'movie', id }),
};

async function fetchWith(fetching: Partial<UserData>) {
  const userData = {
    uuid: 'test',
    presets: [],
    services: [],
    yearMatching: { enabled: true, addons: ['text-search'] },
    softMatching: { enabled: true },
    ...fetching,
  } as unknown as UserData;
  const precompute = {
    precomputeSeaDexOnly: async () => {},
    precomputePreferred: async () => {},
  } as any;
  const fetcher = new StreamFetcher(
    userData,
    new StreamFilterer(userData),
    precompute
  );
  const { streams } = await fetcher.fetch([textSearch, byId], context);
  return Object.fromEntries(
    streams.map((s) => [s.addon.preset.id, s.unconfirmed])
  );
}

describe('soft matching with addons fetched apart', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });
  afterEach(() => mock.restoreAll());

  it('marks the results of an addon group', async () => {
    mockAddons();
    const marks = await fetchWith({
      groups: {
        enabled: true,
        groupings: [
          { addons: ['by-id'], condition: 'true' },
          { addons: ['text-search'], condition: 'true' },
        ],
      },
    } as Partial<UserData>);
    assert.deepEqual(marks, {
      'by-id': undefined,
      'text-search': { reason: 'year', releaseYear: 2006, titleYear: 2011 },
    });
  });

  it('marks the results of dynamic fetching', async () => {
    mockAddons();
    const marks = await fetchWith({
      dynamicAddonFetching: { enabled: true, condition: 'false' },
    } as Partial<UserData>);
    assert.deepEqual(marks, {
      'by-id': undefined,
      'text-search': { reason: 'year', releaseYear: 2006, titleYear: 2011 },
    });
  });
});
