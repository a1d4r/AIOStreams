import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Addon } from '../db/schemas.js';
import type { AIOStreamsContext } from './types.js';

process.env.ALLOW_PRIVATE_URLS = 'true';
process.env.MANIFEST_INCREASED_TIMEOUT = '300';
await import('../index.js');
const { SettingsRepository } = await import('../db/index.js');
const { initialiseConfig } = await import('../config/index.js');
const { fetchManifests } = await import('./setup.js');

const MANIFEST = {
  id: 'test.addon',
  name: 'Test',
  version: '1.0.0',
  description: 'Test',
  resources: ['stream'],
  types: ['movie'],
  catalogs: [],
};

let server: Server;
let base: string;

// Each path answers as the addon it stands for; /hang never does.
before(async () => {
  mock.method(SettingsRepository, 'getAll', async () => []);
  mock.method(SettingsRepository, 'getVersion', async () => 0);
  await initialiseConfig();
  server = createServer((req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/hang')) return;
    const status = Number(path.split('/')[1]);
    res.statusCode = status || 200;
    res.end(status ? 'error code' : JSON.stringify(MANIFEST));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function addon(path: string, name: string): Addon {
  return {
    instanceId: name,
    name,
    manifestUrl: `${base}/${path}/manifest.json`,
    enabled: true,
    headers: {},
    preset: { id: name, type: 'custom', options: {} },
  } as unknown as Addon;
}

function context(
  addons: Addon[],
  options: AIOStreamsContext['options']
): AIOStreamsContext {
  return {
    addons,
    options,
    manifests: {},
    addonInitialisationErrors: [],
    userData: {},
  } as unknown as AIOStreamsContext;
}

const SAVE = {
  skipFailedAddons: false,
  skipUnavailableAddons: true,
  increasedManifestTimeout: true,
  bypassManifestCache: true,
};

async function assertSkipped(path: string, reason: RegExp) {
  const ctx = context([addon(path, 'skipped')], SAVE);
  await fetchManifests(ctx);
  assert.equal(ctx.manifests.skipped, null);
  assert.match(ctx.addonInitialisationErrors[0]?.error ?? '', reason);
}

describe('fetchManifests on a save', () => {
  for (const status of [500, 502, 408]) {
    it(`skips an addon answering ${status}`, async () => {
      await assertSkipped(`${status}`, new RegExp(`${status}`));
    });
  }

  it('skips an addon that never answers', async () => {
    await assertSkipped('hang', /timed out/);
  });

  it('skips an addon nobody listens at', async () => {
    const dead = addon('x', 'dead');
    dead.manifestUrl = 'http://127.0.0.1:9/manifest.json';
    const ctx = context([dead], SAVE);
    await fetchManifests(ctx);
    assert.equal(ctx.manifests.dead, null);
  });

  it('keeps the addons that answer next to a dead one', async () => {
    const ctx = context([addon('502', 'dead2'), addon('ok', 'live')], SAVE);
    await fetchManifests(ctx);
    assert.equal(ctx.manifests.dead2, null);
    assert.equal(ctx.manifests.live?.id, MANIFEST.id);
  });

  for (const status of [400, 401, 403, 404]) {
    it(`rejects an addon answering ${status}`, async () => {
      const ctx = context([addon(`${status}`, `r${status}`)], SAVE);
      await assert.rejects(fetchManifests(ctx), new RegExp(`${status}`));
    });
  }

  it('rejects an address that is not a URL', async () => {
    const invalid = addon('ok', 'invalid');
    invalid.manifestUrl = 'not a url';
    await assert.rejects(fetchManifests(context([invalid], SAVE)));
  });

  it('rejects everything without skipUnavailableAddons', async () => {
    const ctx = context([addon('502', 'strict')], {
      skipFailedAddons: false,
      bypassManifestCache: true,
    });
    await assert.rejects(fetchManifests(ctx), /502/);
  });

  // Last: a 429 puts the host on a cooldown that fails every later request to it.
  it('skips an addon answering 429', async () => {
    await assertSkipped('429', /429/);
  });
});
