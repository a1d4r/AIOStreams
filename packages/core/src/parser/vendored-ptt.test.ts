import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTorrentTitle } from '@aiostreams/release-parser';

// Canary for the pnpm override in pnpm-workspace.yaml that swaps the npm
// release of @aiostreams/release-parser for vendor/*.tgz, packed from the
// fork's main (upstream 1.0.1 plus open PRs). Both titles below parse wrong
// on the npm 1.0.1 release, so a failure here means the override stopped
// applying, not that the parser regressed.
//
// When upstream bumps the dependency past the vendored version, repack the
// fork on that release and rename the tarball in the override.
describe('vendored release-parser', () => {
  it('is the version upstream asks for', () => {
    // The package exports no ./package.json, so read the installed copy as a file.
    const read = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const vendored = read(
      '../../node_modules/@aiostreams/release-parser/package.json'
    ).version;
    const asked =
      read('../../package.json').dependencies['@aiostreams/release-parser'];
    assert.equal(asked, `^${vendored}`);
  });

  it('reads a Russian ordinal season word', () => {
    const parsed = parseTorrentTitle(
      'Сериал / Show (второй сезон) [WEB-DL 1080p]'
    );
    assert.deepEqual(parsed.seasons, [2]);
  });

  it('reads a Russian episode count as an episode range', () => {
    const parsed = parseTorrentTitle(
      'Сериал / Show [S01] [24 серии из 24] [2020, WEB-DL]'
    );
    assert.deepEqual(
      parsed.episodes,
      Array.from({ length: 24 }, (_, i) => i + 1)
    );
  });

  it('does not read an aspect ratio as a season and an episode', () => {
    const parsed = parseTorrentTitle(
      'Сумерки. Сага. Рассвет: Часть 2 / The Twilight Saga: Breaking Dawn - Part 2 (2012) [BDRip 1080p, 16x9]'
    );
    assert.equal(parsed.seasons, undefined);
    assert.equal(parsed.episodes, undefined);
  });
});
