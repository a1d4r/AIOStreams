import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import '../index.js';
import { TorznabPreset } from './torznab.js';
import { KnabenPreset } from './knaben.js';
import type { UserData } from '../db/schemas.js';
import { settingsStore } from '../config/index.js';
import { SettingsRepository } from '../db/repositories/settings.js';

const options = {
  name: 'JacRed',
  api: {
    url: 'https://jacred.example/api/v2.0/indexers/all/results/torznab/api',
  },
  searchMode: 'auto',
};

function manifestConfig(manifestUrl: string) {
  const config = manifestUrl.split('/').at(-2)!;
  return JSON.parse(Buffer.from(config, 'base64url').toString());
}

describe('Torznab preset', () => {
  before(async () => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
  });

  it('creates a P2P addon without a service', async () => {
    const addons = await TorznabPreset.generateAddons(
      { services: [] } as unknown as UserData,
      options
    );
    assert.equal(addons.length, 1);
    assert.equal(addons[0].identifier, 'p2p');
    assert.equal(addons[0].displayIdentifier, 'P2P');
    assert.deepEqual(manifestConfig(addons[0].manifestUrl).services, []);
  });

  it('creates a P2P addon per search mode', async () => {
    const addons = await TorznabPreset.generateAddons({} as UserData, {
      ...options,
      searchMode: 'both',
    });
    assert.deepEqual(
      addons.map((addon) => addon.identifier),
      ['p2p_Q', 'p2p']
    );
  });

  it('still requires a service from a preset without P2P', async () => {
    await assert.rejects(
      KnabenPreset.generateAddons({ services: [] } as unknown as UserData, {
        name: 'Knaben',
      }),
      /Knaben requires at least one usable service/
    );
  });

  it('still uses an enabled service', async () => {
    const addons = await TorznabPreset.generateAddons(
      {
        services: [
          { id: 'torbox', enabled: true, credentials: { apiKey: 'key' } },
        ],
      } as unknown as UserData,
      options
    );
    assert.equal(addons.length, 1);
    assert.equal(addons[0].identifier, 'TB');
    assert.deepEqual(
      manifestConfig(addons[0].manifestUrl).services.map(
        (s: { id: string }) => s.id
      ),
      ['torbox']
    );
  });
});
