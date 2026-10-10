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

// The extensions the deduplicator strips from filenames.
const VIDEO_FILE =
  /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|3gp|3g2|m2ts|ts|vob|ogv|ogm|divx|xvid|rm|rmvb|asf|mxf|mka|mks|mk3d|f4v|f4p|f4a|f4b)$/i;

// Sizes addons report for one file differ by up to a few percent: some round
// them to a GB or to two digits.
const SAME_FILE_SIZE = 1.05;
// Below this, a size reported for a much larger file is another file's.
const TINY_FILE = 50 * 1024 ** 2;

/** A copy's fileIdx, unless it is unknown: undefined, null or negative. */
function knownFileIdx(stream: ParsedStream): number | undefined {
  const fileIdx = stream.torrent?.fileIdx;
  return typeof fileIdx === 'number' && fileIdx >= 0 ? fileIdx : undefined;
}

/**
 * The video file a copy names, if any, compared by its basename in lower case
 * with only letters and digits kept: addons differ in spacing and punctuation
 * (`Movie (2014).mkv` and `Movie(2014).mkv`).
 */
function videoFileName(stream: ParsedStream): string | undefined {
  const name = stream.filename?.split(/[\\/]/).pop()?.trim();
  return name && VIDEO_FILE.test(name)
    ? name.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
    : undefined;
}

interface TorrentFile {
  /** The name copies give it, as compared (see videoFileName). */
  name: string;
  /** The filename as the smallest copy agreeing on the size reports it. */
  filename: string;
  /** The smallest size the copies agreeing on it report. */
  size: number;
  /** Every copy playing the file, missized included. */
  copies: ParsedStream[];
  /** Copies reporting another size for the file. */
  missized: ParsedStream[];
}

interface Torrent {
  copies: ParsedStream[];
  files: TorrentFile[];
}

/**
 * Group torrent copies (usenet aside) by lower-cased infoHash and tell which
 * file each copy plays by the video file it names, not by fileIdx: addons and
 * debrid services number a torrent's files differently. Copies naming the
 * same file at about the same size (within 5%) play one file; same-named
 * files of other sizes, such as two discs' 00001.m2ts, are different files.
 * Some copies report another size for their file: a large one (within 5% of
 * the largest size the torrent's copies report, as MediaFusion reports the
 * torrent's or a folder's size) or a tiny one (under 50 MB and 1% of the
 * largest size of the name, as Comet does). When the other copies of the name
 * agree on one size, such a copy plays their file. A copy naming a file
 * without a size plays the file of that name if there is just one. Copies
 * naming no video file are in no file.
 */
function groupTorrents(streams: ParsedStream[]): Map<string, Torrent> {
  const torrents = new Map<string, Torrent>();
  for (const stream of streams) {
    const hash = stream.torrent?.infoHash?.toLowerCase();
    if (!hash || stream.type === 'usenet' || stream.type === 'stremio-usenet') {
      continue;
    }
    let torrent = torrents.get(hash);
    if (!torrent) torrents.set(hash, (torrent = { copies: [], files: [] }));
    torrent.copies.push(stream);
  }

  for (const torrent of torrents.values()) {
    // Folder sizes are left out: addons report them for a season folder or
    // even double.
    const largestSize = Math.max(
      ...torrent.copies.map((copy) => copy.size ?? 0)
    );
    const copiesByName = new Map<string, ParsedStream[]>();
    for (const copy of torrent.copies) {
      const name = videoFileName(copy);
      if (!name) continue;
      let named = copiesByName.get(name);
      if (!named) copiesByName.set(name, (named = []));
      named.push(copy);
    }

    for (const [name, named] of copiesByName) {
      const sized = named
        .filter((copy) => copy.size)
        .sort((a, b) => a.size! - b.size!);
      const sizes: ParsedStream[][] = [];
      for (const copy of sized) {
        const last = sizes[sizes.length - 1];
        if (last && copy.size! <= last[0].size! * SAME_FILE_SIZE) {
          last.push(copy);
        } else {
          sizes.push([copy]);
        }
      }
      // A tiny size is another file's, such as a sample's. The largest size
      // is the torrent's or a folder's when smaller sizes are reported too.
      const top = sizes.length ? sizes[sizes.length - 1][0].size! : 0;
      const notTiny = sizes.filter((copies) => {
        const size = copies[copies.length - 1].size!;
        return size >= top * 0.01 || size >= TINY_FILE;
      });
      const agreed =
        notTiny.length > 1
          ? notTiny.filter(([smallest]) => smallest.size! < largestSize * 0.95)
          : notTiny;
      const files: TorrentFile[] =
        sizes.length > 1 && agreed.length === 1
          ? [
              {
                name,
                filename: agreed[0][0].filename!,
                size: agreed[0][0].size!,
                copies: sized,
                missized: sized.filter((copy) => !agreed[0].includes(copy)),
              },
            ]
          : sizes.map((copies) => ({
              name,
              filename: copies[0].filename!,
              size: copies[0].size!,
              copies,
              missized: [],
            }));
      if (files.length === 1) {
        files[0].copies.push(...named.filter((copy) => !copy.size));
      }
      torrent.files.push(...files);
    }
  }
  return torrents;
}

/**
 * Correct what debrid copies report about the file they play, before
 * filtering, so size filters, sorting and dedup see the file:
 * - a copy reporting another size for its file (the torrent's, as
 *   MediaFusion does) takes the size its file's other copies agree on;
 * - a copy named after the torrent rather than a video file carries the
 *   whole torrent's name and size, which in a season pack misleads sorting
 *   and size filters. When the other copies name exactly one file, it takes
 *   that file's name and size and, if it doesn't know its fileIdx (no
 *   fileIdx, or -1 as builtin addons report an unchecked torrent), the
 *   file's fileIdx if the file's copies report just one.
 * Either keeps the torrent's name and size as the folder. A file about as
 * large as the torrent (a single-file torrent) changes nothing. The playback
 * URL is already built and picks the file itself, and parsedFile stays as
 * parsed from the torrent name, which usually says more. P2P streams are left
 * alone: their client plays the file their fileIdx points to.
 */
export function shareFileInfo(streams: ParsedStream[]): void {
  for (const { copies, files } of groupTorrents(streams).values()) {
    for (const file of files) {
      for (const copy of file.missized) {
        if (copy.type !== 'debrid') continue;
        if (copy.size! > file.size) copy.folderSize ||= copy.size;
        copy.size = file.size;
      }
    }

    if (files.length !== 1) continue;
    const [file] = files;
    const fileIdxs = new Set(
      file.copies.map(knownFileIdx).filter((idx) => idx !== undefined)
    );
    for (const copy of copies) {
      if (
        copy.type !== 'debrid' ||
        !copy.torrent ||
        videoFileName(copy) ||
        !copy.size ||
        file.size >= copy.size * 0.95
      ) {
        continue;
      }
      copy.folderSize ||= copy.size;
      copy.folderName ||= copy.filename;
      copy.filename = file.filename;
      copy.size = file.size;
      if (knownFileIdx(copy) === undefined && fileIdxs.size === 1) {
        [copy.torrent.fileIdx] = fileIdxs;
      }
    }
  }
}

/**
 * Key each torrent copy by the file it plays, for dedup: copies naming a
 * video file by that file (see groupTorrents). A copy named after the torrent
 * or naming nothing plays the torrent's only file; when the torrent has
 * several, its fileIdx tells (undefined, null or -1 when unknown): its own,
 * or else the torrent's only known one, maps to the file whose copies report
 * it, if just one does. A copy that still can't tell its file groups only
 * with copies of the torrent that can't either. A copy naming a file without
 * a size never joins a file of another name.
 */
export function torrentFileKeys(
  streams: ParsedStream[]
): Map<ParsedStream, string> {
  const keys = new Map<ParsedStream, string>();
  for (const [hash, { copies, files }] of groupTorrents(streams)) {
    const fileKey = (i: number) => `${hash}:file:${i}`;
    files.forEach((file, i) => {
      for (const copy of file.copies) keys.set(copy, fileKey(i));
    });
    const fileIdxs = new Set(
      copies.map(knownFileIdx).filter((idx) => idx !== undefined)
    );
    for (const copy of copies) {
      if (keys.has(copy)) continue;
      const name = videoFileName(copy);
      if (name && files.some((file) => file.name === name)) {
        // No size to tell which of the files of its name it plays.
        keys.set(copy, `${hash}:name:${name}`);
        continue;
      }
      if (!name && files.length === 1) {
        keys.set(copy, fileKey(0));
        continue;
      }
      let fileIdx = knownFileIdx(copy);
      if (fileIdx === undefined && fileIdxs.size === 1) [fileIdx] = fileIdxs;
      if (fileIdx === undefined) {
        keys.set(copy, hash);
        continue;
      }
      // A copy naming a file the others don't name never takes theirs.
      const owners = name
        ? []
        : files.flatMap((file, i) =>
            file.copies.some((other) => knownFileIdx(other) === fileIdx)
              ? [i]
              : []
          );
      keys.set(
        copy,
        owners.length === 1 ? fileKey(owners[0]) : `${hash}:${fileIdx}`
      );
    }
  }
  return keys;
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
