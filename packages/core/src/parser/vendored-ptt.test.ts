import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTorrentTitle } from '@viren070/parse-torrent-title';

// Canary for the pnpm override in pnpm-workspace.yaml that swaps the npm
// release of @viren070/parse-torrent-title for vendor/*.tgz, packed from the
// fork's main (upstream v0.9.2 plus open PRs). Both titles below parse wrong
// on the npm 0.9.2 release, so a failure here means the override stopped
// applying, not that the parser regressed.
//
// Upstream has since renamed the package to @aiostreams/release-parser
// (1.x). When AIOStreams switches to it, rewrite the override (and repack the
// fork under the new name), or these tests will start failing.
describe('vendored parse-torrent-title', () => {
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
});
