import { ParsedStream, PassthroughStage, UserData } from '../db/schemas.js';

/**
 * Check if a stream should passthrough a specific stage.
 * Returns true if:
 * - stream.addon.resultPassthrough is true
 * - stream.passthrough is true (passthrough all stages)
 * - stream.passthrough is an array that includes the specified stage
 */
export function shouldPassthroughStage(
  stream: ParsedStream,
  stage: PassthroughStage
): boolean {
  // Addon-level passthrough always bypasses all stages
  if (stream.addon.resultPassthrough) {
    return true;
  }

  // Check stream-level passthrough
  if (stream.passthrough === true) {
    // true = passthrough all stages
    return true;
  }

  if (Array.isArray(stream.passthrough)) {
    // Array = passthrough only specified stages
    return stream.passthrough.includes(stage);
  }

  return false;
}

/** Whether resolveServiceWrappedStreams will actually pick up this stream. */
export function isServiceWrapEligibleP2PStream(
  stream: ParsedStream,
  userData: UserData
): boolean {
  if (!userData.serviceWrap?.enabled || stream.type !== 'p2p') return false;
  if (stream.addon.serviceWrapped) return true;

  const serviceWrapPresets = userData.serviceWrap.presets;
  const isPresetInScope =
    !serviceWrapPresets?.length ||
    serviceWrapPresets.includes(stream.addon.preset.id);

  return !!stream.torrent?.infoHash && isPresetInScope;
}

/**
 * Addons check debrid cache availability in different ways, so copies of one
 * torrent on the same service can disagree. If any copy is cached on a service,
 * mark every copy of that infoHash on that service as cached. Runs before
 * filtering so uncached exclusion and dedup see the shared status. Copies
 * raised this way get `cacheShared` so they can be told apart from copies
 * whose own addon reported them cached.
 */
export function shareCacheStatus(streams: ParsedStream[]): void {
  const keyOf = (stream: ParsedStream) =>
    stream.type === 'debrid' && stream.service && stream.torrent?.infoHash
      ? `${stream.service.id}:${stream.torrent.infoHash.toLowerCase()}`
      : undefined;

  const cachedKeys = new Set<string>();
  for (const stream of streams) {
    const key = keyOf(stream);
    if (key && stream.service?.cached) cachedKeys.add(key);
  }
  if (cachedKeys.size === 0) return;

  for (const stream of streams) {
    const key = keyOf(stream);
    if (
      key &&
      stream.service &&
      !stream.service.cached &&
      cachedKeys.has(key)
    ) {
      stream.service.cached = true;
      stream.service.cacheShared = true;
    }
  }
}

/**
 * A debrid stream that doesn't know which file of the torrent it plays (no
 * fileIdx, or -1 as builtin addons report an unchecked torrent) carries the
 * whole torrent's name and size, which in a season pack misleads sorting and
 * size filters. When the other copies of the torrent agree on one file, take
 * that file's name, size and fileIdx, keeping the torrent's as the folder.
 * The playback URL is already built and picks the file itself, and parsedFile
 * stays as parsed from the torrent name, which usually says more. P2P streams
 * are left alone: their client plays the file their fileIdx points to.
 */
export function shareFileInfo(streams: ParsedStream[]): void {
  const hashOf = (stream: ParsedStream) =>
    stream.torrent?.infoHash?.toLowerCase();
  const knownFileIdx = (stream: ParsedStream) => {
    const fileIdx = stream.torrent?.fileIdx;
    return typeof fileIdx === 'number' && fileIdx >= 0 ? fileIdx : undefined;
  };

  const fileIdxsByHash = new Map<string, Set<number>>();
  const donorByHash = new Map<string, ParsedStream>();
  for (const stream of streams) {
    const hash = hashOf(stream);
    const fileIdx = knownFileIdx(stream);
    if (!hash || fileIdx === undefined) continue;
    let fileIdxs = fileIdxsByHash.get(hash);
    if (!fileIdxs) fileIdxsByHash.set(hash, (fileIdxs = new Set()));
    fileIdxs.add(fileIdx);
    if (!donorByHash.has(hash) && stream.filename && stream.size) {
      donorByHash.set(hash, stream);
    }
  }

  for (const stream of streams) {
    const hash = hashOf(stream);
    if (
      !hash ||
      !stream.torrent ||
      stream.type !== 'debrid' ||
      knownFileIdx(stream) !== undefined ||
      fileIdxsByHash.get(hash)?.size !== 1
    ) {
      continue;
    }
    const donor = donorByHash.get(hash);
    // A donor file about as large as the stream (within 5%, as the parser
    // drops such a folderSize) means a single-file torrent, where the stream
    // already shows the file.
    if (!donor || !stream.size || donor.size! >= stream.size * 0.95) continue;

    stream.folderSize ||= stream.size;
    stream.folderName ||= stream.filename;
    stream.filename = donor.filename;
    stream.size = donor.size;
    stream.torrent.fileIdx = donor.torrent!.fileIdx;
  }
}

class StreamUtils {
  public static createDownloadableStream(stream: ParsedStream): ParsedStream {
    const copy = structuredClone(stream);
    copy.url = undefined;
    copy.externalUrl = stream.url;
    copy.message = `Download the stream above via your browser`;
    copy.id = `${stream.id}-external-download`;
    copy.type = 'external';
    // remove uneccessary info that is already present in the original stream above
    copy.parsedFile = undefined;
    copy.size = undefined;
    copy.folderSize = undefined;
    copy.torrent = undefined;
    copy.indexer = undefined;
    copy.age = undefined;
    copy.duration = undefined;
    copy.folderName = undefined;
    copy.filename = undefined;
    copy.regexMatched = undefined;
    copy.addon.name = '';
    return copy;
  }

  // ensure we have a unique list of streams after merging
  public static mergeStreams(streams: ParsedStream[]): ParsedStream[] {
    const mergedStreams = new Map<string, ParsedStream>();
    for (const stream of streams) {
      mergedStreams.set(stream.id, stream);
    }
    return Array.from(mergedStreams.values());
  }
}

export default StreamUtils;
