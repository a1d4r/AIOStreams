import type { ParsedFile, ParsedStream } from '../db/schemas.js';
import {
  type ParsedMediaInfo,
  mergeParsedMediaInfos,
  mergeVisualTags,
  parseMediaInfo,
} from '../utils/index.js';
import { dropUnsetAudioLang } from './unset-lang.js';
import type { MediaInfoRecord } from './record.js';
import { toWireMediaInfo } from './wire.js';

/** Lay probed media info over a parsed file, keeping what it left out. */
export function layerMediaInfo(
  parsedFile: ParsedFile | undefined,
  info: ParsedMediaInfo | undefined
): ParsedFile | undefined {
  const merged = mergeParsedMediaInfos(parsedFile, info);
  if (!merged) return parsedFile;

  return {
    ...parsedFile,
    ...merged,
    languages: merged.languages ?? parsedFile?.languages ?? [],
    // The info's audio replaces the languages an addon read from the file.
    probedAudioLanguages: info?.languages
      ? undefined
      : parsedFile?.probedAudioLanguages,
    subtitles: merged.subtitles ?? parsedFile?.subtitles ?? [],
    audioChannels: merged.audioChannels ?? parsedFile?.audioChannels ?? [],
    visualTags: mergeVisualTags(parsedFile?.visualTags, info?.visualTags),
    audioTags: merged.audioTags ?? parsedFile?.audioTags ?? [],
    hasChapters: merged.hasChapters ?? parsedFile?.hasChapters,
    videoIndex: merged.videoIndex,
  };
}

export function applyMediaInfo(
  stream: Pick<ParsedStream, 'parsedFile' | 'duration' | 'bitrate'> &
    Partial<Pick<ParsedStream, 'filename' | 'folderName'>>,
  record: MediaInfoRecord
): void {
  stream.parsedFile = layerMediaInfo(
    stream.parsedFile,
    dropUnsetAudioLang(
      parseMediaInfo(toWireMediaInfo(record)),
      stream.filename,
      stream.folderName
    )
  );
  if (record.duration && !stream.duration) {
    stream.duration = Math.round(record.duration * 1000);
  }
  if (record.bitrate && !stream.bitrate) {
    stream.bitrate = record.bitrate;
  }
}
