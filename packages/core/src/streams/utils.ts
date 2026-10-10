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
 * size filters. Give it the file other copies of the torrent report, keeping
 * the torrent's name and size as the folder:
 * - when the copies that know their fileIdx agree on one, the smallest of
 *   them, with its fileIdx;
 * - when none of them reports a smaller file, the file copies without a
 *   fileIdx report, if they all name the same file at about the same size;
 *   the fileIdx stays unknown.
 * The playback URL is already built and picks the file itself, and parsedFile
 * stays as parsed from the torrent name, which usually says more. P2P streams
 * are left alone: their client plays the file their fileIdx points to.
 */
export function shareFileInfo(streams: ParsedStream[]): void {
  interface ReportedFile {
    filename: string;
    size: number;
    fileIdx?: number;
  }
  const hashOf = (stream: ParsedStream) =>
    stream.torrent?.infoHash?.toLowerCase();
  const knownFileIdx = (stream: ParsedStream) => {
    const fileIdx = stream.torrent?.fileIdx;
    return typeof fileIdx === 'number' && fileIdx >= 0 ? fileIdx : undefined;
  };
  const smallest = (files: ReportedFile[]) =>
    files.reduce((min, file) => (file.size < min.size ? file : min));
  const sameFile = (files: ReportedFile[]) => {
    const name = files[0].filename.trim().toLowerCase();
    const sizes = files.map((file) => file.size);
    return (
      files.every((file) => file.filename.trim().toLowerCase() === name) &&
      Math.max(...sizes) <= Math.min(...sizes) * 1.01
    );
  };

  // Taken before any copy changes, so a copy given a file doesn't donate it.
  const fileIdxsByHash = new Map<string, Set<number>>();
  const filesByHash = new Map<string, ReportedFile[]>();
  for (const stream of streams) {
    const hash = hashOf(stream);
    if (!hash) continue;
    const fileIdx = knownFileIdx(stream);
    if (fileIdx !== undefined) {
      let fileIdxs = fileIdxsByHash.get(hash);
      if (!fileIdxs) fileIdxsByHash.set(hash, (fileIdxs = new Set()));
      fileIdxs.add(fileIdx);
    }
    if (stream.filename?.trim() && stream.size) {
      let files = filesByHash.get(hash);
      if (!files) filesByHash.set(hash, (files = []));
      files.push({ filename: stream.filename, size: stream.size, fileIdx });
    }
  }

  for (const stream of streams) {
    const hash = hashOf(stream);
    if (
      !hash ||
      !stream.torrent ||
      stream.type !== 'debrid' ||
      knownFileIdx(stream) !== undefined ||
      !stream.size ||
      (fileIdxsByHash.get(hash)?.size ?? 0) > 1
    ) {
      continue;
    }
    // A file about as large as the stream (within 5%, as the parser drops
    // such a folderSize) is the whole torrent: a single-file torrent, or an
    // addon reporting the torrent's size for its file.
    const maxSize = stream.size * 0.95;
    const files = (filesByHash.get(hash) ?? []).filter(
      (file) => file.size < maxSize
    );
    const indexed = files.filter((file) => file.fileIdx !== undefined);
    const donor = indexed.length
      ? smallest(indexed)
      : files.length && sameFile(files)
        ? smallest(files)
        : undefined;
    if (!donor) continue;

    stream.folderSize ||= stream.size;
    stream.folderName ||= stream.filename;
    stream.filename = donor.filename;
    stream.size = donor.size;
    if (donor.fileIdx !== undefined) stream.torrent.fileIdx = donor.fileIdx;
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
