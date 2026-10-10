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
// MediaFusion reports some sizes in GiB as GB, 1.0737 times too large.
const GIB_IN_GB = 1024 ** 3 / 1e9;
// Below this, a size reported for a much larger file is another file's.
const TINY_FILE = 50 * 1024 ** 2;
// A name with fewer letters numbers its file rather than names it: 00001.m2ts,
// VTS_01_1.VOB, E01.mkv, 1.2.mkv recur in every disc or season folder of a
// torrent, while release and title names have more.
const NAMING_LETTERS = 4;

/** Whether two sizes reported for a file are about the same. */
function sameFileSize(a: number, b: number): boolean {
  const ratio = Math.max(a, b) / Math.min(a, b);
  return ratio <= SAME_FILE_SIZE || Math.abs(ratio / GIB_IN_GB - 1) <= 0.01;
}

/** A copy's fileIdx, unless it is unknown: undefined, null or negative. */
function knownFileIdx(stream: ParsedStream): number | undefined {
  const fileIdx = stream.torrent?.fileIdx;
  return typeof fileIdx === 'number' && fileIdx >= 0 ? fileIdx : undefined;
}

interface VideoFile {
  /** The basename, as compared (see videoFile). */
  name: string;
  /** The folder path, if the copy gives one, compared like the name. */
  folder?: string;
  /** Whether the name numbers the file rather than names it. */
  numbered: boolean;
}

/**
 * The video file a copy names, if any, compared in lower case with only
 * letters and digits kept: addons differ in spacing and punctuation
 * (`Movie (2014).mkv` and `Movie(2014).mkv`) and in Unicode normalization.
 */
function videoFile(stream: ParsedStream): VideoFile | undefined {
  const path = stream.filename?.normalize('NFC').split(/[\\/]/);
  const basename = path?.pop()?.trim() ?? '';
  const extension = VIDEO_FILE.exec(basename);
  if (!path || !extension) return undefined;
  const compact = (part: string) =>
    part.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const stem = compact(basename.slice(0, extension.index));
  return {
    name: `${stem}.${extension[1].toLowerCase()}`,
    folder: path.map(compact).filter(Boolean).join('/') || undefined,
    numbered: (stem.match(/\p{L}/gu)?.length ?? 0) < NAMING_LETTERS,
  };
}

/**
 * Where in the torrent the copies giving one name put their file, as a suffix
 * to the name: copies with one suffix give one file the name (see
 * groupTorrents).
 */
function placeNamed(
  named: { copy: ParsedStream; file: VideoFile }[]
): Map<ParsedStream, string> {
  const places = new Map<ParsedStream, string>();
  const folders = new Set(named.map(({ file }) => file.folder));
  folders.delete(undefined);
  // Copies of a numbering name without a folder, linked by the same size to
  // the byte or the same fileIdx. DVD VOBs are cut at 1 GiB: their sizes
  // match across discs.
  let linked: { anchors: string[]; copies: ParsedStream[] }[] = [];
  for (const { copy, file } of named) {
    if (!file.numbered) {
      places.set(copy, folders.size > 1 ? `/${file.folder ?? ''}` : '');
    } else if (file.folder !== undefined) {
      places.set(copy, `/${file.folder}`);
    } else {
      const fileIdx = knownFileIdx(copy);
      const anchors = [
        ...(copy.size && !file.name.endsWith('.vob') ? [`=${copy.size}`] : []),
        ...(fileIdx !== undefined ? [`#${fileIdx}`] : []),
      ];
      const joined = linked.filter((group) =>
        group.anchors.some((anchor) => anchors.includes(anchor))
      );
      linked = linked.filter((group) => !joined.includes(group));
      linked.push({
        anchors: [...anchors, ...joined.flatMap((group) => group.anchors)],
        copies: [copy, ...joined.flatMap((group) => group.copies)],
      });
    }
  }
  for (const { anchors, copies } of linked) {
    // A size first: fetches that number files differently agree on it.
    anchors.sort();
    const place =
      anchors.find((anchor) => anchor.startsWith('=')) ??
      anchors[0] ??
      `@${copies[0].id}`;
    for (const copy of copies) places.set(copy, place);
  }
  return places;
}

/** The file a torrent copy plays, as stored on it by shareFileInfo. */
type TorrentFileId = NonNullable<ParsedStream['torrentFile']>;

interface TorrentFile extends TorrentFileId {
  size: number;
  /** The filename as the smallest copy agreeing on the size reports it. */
  filename: string;
  /** Every copy playing the file, missized included. */
  copies: ParsedStream[];
  /** Copies reporting another size for the file. */
  missized: ParsedStream[];
}

interface Torrent {
  copies: ParsedStream[];
  files: TorrentFile[];
  /** The key of the name each copy naming a video file has. */
  names: Map<ParsedStream, string>;
}

/**
 * Group torrent copies (usenet aside) by lower-cased infoHash and tell which
 * file each copy plays by the video file it names, not by fileIdx: addons and
 * debrid services number a torrent's files differently.
 *
 * Copies give a file the same name if their names match and their folders,
 * when both give one, too. Where copies give a name in several folders, a
 * copy without one can't tell which and its name is its own. A name with few
 * letters (see NAMING_LETTERS) is the same only in the same folder or, when
 * the copy gives none, at the same size to the byte (but for VOBs) or else
 * at the same fileIdx; else it is the copy's own.
 *
 * Copies giving a file the same name at about the same size (within 5%, or
 * the GiB-as-GB ratio) play one file; same-named files of other sizes, such
 * as two discs' 00001.m2ts, are different files. Some copies report another
 * size for their file: a large one (within 5% of the largest size the
 * torrent's copies report, as MediaFusion reports the torrent's or a folder's
 * size) or a tiny one (under 50 MB and 1% of the largest size of the name, as
 * Comet does; not a sample's). When the other copies of the name agree on one
 * size, such a copy plays their file. A copy naming a file without a size
 * plays the file of that name if there is just one. Copies naming no video
 * file are in no file.
 */
function groupTorrents(streams: ParsedStream[]): Map<string, Torrent> {
  const torrents = new Map<string, Torrent>();
  for (const stream of streams) {
    const hash = stream.torrent?.infoHash?.toLowerCase();
    if (!hash || stream.type === 'usenet' || stream.type === 'stremio-usenet') {
      continue;
    }
    let torrent = torrents.get(hash);
    if (!torrent) {
      torrents.set(
        hash,
        (torrent = { copies: [], files: [], names: new Map() })
      );
    }
    torrent.copies.push(stream);
  }

  for (const [hash, torrent] of torrents) {
    // Folder sizes are left out: addons report them for a season folder or
    // even double.
    const largestSize = Math.max(
      ...torrent.copies.map((copy) => copy.size ?? 0)
    );
    const copiesByName = new Map<
      string,
      { copy: ParsedStream; file: VideoFile }[]
    >();
    for (const copy of torrent.copies) {
      const file = videoFile(copy);
      if (!file) continue;
      let named = copiesByName.get(file.name);
      if (!named) copiesByName.set(file.name, (named = []));
      named.push({ copy, file });
    }
    const copiesByKey = new Map<string, ParsedStream[]>();
    for (const [name, named] of copiesByName) {
      for (const [copy, place] of placeNamed(named)) {
        const key = `${hash}:${name}${place}`;
        torrent.names.set(copy, key);
        let keyed = copiesByKey.get(key);
        if (!keyed) copiesByKey.set(key, (keyed = []));
        keyed.push(copy);
      }
    }

    for (const [key, named] of copiesByKey) {
      const sized = named
        .filter((copy) => copy.size)
        .sort((a, b) => a.size! - b.size!);
      const sizes: ParsedStream[][] = [];
      for (const copy of sized) {
        const last = sizes[sizes.length - 1];
        if (last && sameFileSize(last[0].size!, copy.size!)) {
          last.push(copy);
        } else {
          sizes.push([copy]);
        }
      }
      // A sample is a file of its own, whatever its size. Else a tiny size
      // is another file's, such as a sample's, and the largest size is the
      // torrent's or a folder's when smaller sizes are reported too.
      let samples = sizes.filter((copies) =>
        copies.some((copy) => /sample/i.test(copy.filename!))
      );
      // Unless the name itself says so.
      if (samples.length === sizes.length) samples = [];
      const others = sizes.filter((copies) => !samples.includes(copies));
      const top = others.length ? others[others.length - 1][0].size! : 0;
      const notTiny = others.filter((copies) => {
        const size = copies[copies.length - 1].size!;
        return size >= top * 0.01 || size >= TINY_FILE;
      });
      const agreed =
        notTiny.length > 1
          ? notTiny.filter(([smallest]) => smallest.size! < largestSize * 0.95)
          : notTiny;
      const fileOf = (
        copies: ParsedStream[],
        missized: ParsedStream[] = []
      ) => ({
        key,
        filename: copies[0].filename!,
        size: copies[0].size!,
        copies: [...copies, ...missized],
        missized,
      });
      const files: TorrentFile[] = [
        ...(others.length > 1 && agreed.length === 1
          ? [
              fileOf(
                agreed[0],
                others.flat().filter((copy) => !agreed[0].includes(copy))
              ),
            ]
          : others.map((copies) => fileOf(copies))),
        ...samples.map((copies) => fileOf(copies)),
      ];
      if (files.length === 1) {
        files[0].copies.push(...named.filter((copy) => !copy.size));
      }
      torrent.files.push(...files);
    }
  }
  return torrents;
}

/**
 * The torrent's only file, if its copies name just one: a file of known size,
 * or a name given only without a size.
 */
function onlyFile({ files, names }: Torrent): TorrentFileId | undefined {
  const fileless = new Set(names.values());
  for (const file of files) fileless.delete(file.key);
  if (files.length + fileless.size !== 1) return undefined;
  return files.length
    ? { key: files[0].key, size: files[0].size }
    : { key: [...fileless][0] };
}

/**
 * The file each torrent copy plays (see groupTorrents), as a key and, for a
 * file of known size, the size its copies agree on. A copy naming a file
 * without a size, when its name has several files or none, has the name's
 * key without a size. A copy named after the torrent or naming nothing plays
 * the torrent's only file (see onlyFile); when the torrent has several, its
 * fileIdx tells
 * (undefined, null or -1 when unknown): its own, or else the torrent's only
 * known one, maps to the file whose copies report it, if just one does. A
 * copy that still can't tell its file has the torrent's key, or the
 * torrent's and its fileIdx.
 */
function identifyFiles(
  torrents: Map<string, Torrent>
): Map<ParsedStream, TorrentFileId> {
  const ids = new Map<ParsedStream, TorrentFileId>();
  for (const [hash, torrent] of torrents) {
    const { copies, files, names } = torrent;
    const only = onlyFile(torrent);
    for (const file of files) {
      for (const copy of file.copies) {
        ids.set(copy, { key: file.key, size: file.size });
      }
    }
    const fileIdxs = new Set(
      copies.map(knownFileIdx).filter((idx) => idx !== undefined)
    );
    for (const copy of copies) {
      if (ids.has(copy)) continue;
      const name = names.get(copy);
      if (name) {
        ids.set(copy, { key: name });
        continue;
      }
      if (only) {
        ids.set(copy, { ...only });
        continue;
      }
      let fileIdx = knownFileIdx(copy);
      if (fileIdx === undefined && fileIdxs.size === 1) [fileIdx] = fileIdxs;
      if (fileIdx === undefined) {
        ids.set(copy, { key: hash });
        continue;
      }
      const owners = files.filter((file) =>
        file.copies.some((other) => knownFileIdx(other) === fileIdx)
      );
      ids.set(
        copy,
        owners.length === 1
          ? { key: owners[0].key, size: owners[0].size }
          : { key: `${hash}#${fileIdx}` }
      );
    }
  }
  return ids;
}

/**
 * Tell which file each debrid copy plays and correct what it reports about
 * the file, before filtering, so size filters, sorting and dedup see the file
 * and dedup can still tell it once filters drop the copies that told it:
 * - every torrent copy stores the file it plays (see identifyFiles) for
 *   dedup;
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
 * alone: their client plays the file their fileIdx points to. Copies told
 * their file by an earlier call keep it and are left as they are.
 */
export function shareFileInfo(streams: ParsedStream[]): void {
  const torrents = groupTorrents(streams);
  const ids = identifyFiles(torrents);
  const isNew = (copy: ParsedStream) => !copy.torrentFile;
  for (const torrent of torrents.values()) {
    const { copies, files } = torrent;
    for (const file of files) {
      for (const copy of file.missized) {
        if (copy.type !== 'debrid' || !isNew(copy)) continue;
        if (copy.size! > file.size) copy.folderSize ||= copy.size;
        copy.size = file.size;
      }
    }

    if (files.length !== 1 || !onlyFile(torrent)) continue;
    const [file] = files;
    const fileIdxs = new Set(
      file.copies.map(knownFileIdx).filter((idx) => idx !== undefined)
    );
    for (const copy of copies) {
      if (
        copy.type !== 'debrid' ||
        !isNew(copy) ||
        !copy.torrent ||
        videoFile(copy) ||
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
  for (const [copy, id] of ids) copy.torrentFile ??= id;
}

/**
 * Key each torrent copy by the file it plays, for dedup: by the file
 * shareFileInfo stored on it, or else as it would tell it. Copies of one key
 * whose sizes are about the same play one file; copies of a key without a
 * size group only with each other.
 */
export function torrentFileKeys(
  streams: ParsedStream[]
): Map<ParsedStream, string> {
  const told = streams.some((stream) => !stream.torrentFile)
    ? identifyFiles(groupTorrents(streams))
    : undefined;
  const byKey = new Map<string, [ParsedStream, TorrentFileId][]>();
  for (const stream of streams) {
    const id = stream.torrentFile ?? told?.get(stream);
    if (!id) continue;
    let keyed = byKey.get(id.key);
    if (!keyed) byKey.set(id.key, (keyed = []));
    keyed.push([stream, id]);
  }

  const keys = new Map<ParsedStream, string>();
  for (const [key, keyed] of byKey) {
    let first: number | undefined;
    for (const [stream, { size }] of keyed.sort(
      ([, a], [, b]) => (a.size ?? 0) - (b.size ?? 0)
    )) {
      if (size && (first === undefined || !sameFileSize(first, size))) {
        first = size;
      }
      keys.set(stream, size ? `${key}@${first}` : key);
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
