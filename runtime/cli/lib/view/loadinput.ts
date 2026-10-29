import type { Language, RenderInputExtent } from "./languages/language.ts";
import {
  byteInputFor,
  createByteLanguageDetector,
  languageForFile,
} from "./languages/language.ts";
import { binaryPreviewExtent } from "./languages/binary/binary.ts";

const MAX_RETAINED_INPUT_BYTES = 256 * 1024;

export interface BufferedViewInput {
  readonly kind: "bytes";
  readonly bytes: Uint8Array;

  /** A raw-byte language established before the retained preview was decoded. */
  readonly language?: Language;

  /** The streamed detector consumed all bytes without selecting a byte
   * language. Later decoding can proceed directly as text. */
  readonly byteLanguageDetectionComplete?: boolean;

  readonly extent: RenderInputExtent;
}

export interface RenderedStreamInput {
  readonly kind: "rendered-stream";
  readonly language: Language;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly lineCount: number | undefined;
  readonly dispose: () => void | Promise<void>;
}

export type LoadedViewInput = BufferedViewInput | RenderedStreamInput;

/** Load source bytes while bounding binary previews and streaming full dumps. */
export async function loadViewInput(
  path: string | undefined,
  fileName: string | undefined,
  explicitLanguage: Language | undefined,
  interactive: boolean,
  streamRendered = true,
): Promise<LoadedViewInput> {
  const filenameLanguage = explicitLanguage ?? languageForFile(fileName);
  const knownByteLanguage = byteInputFor(filenameLanguage) !== undefined
    ? filenameLanguage
    : undefined;
  const source = path === undefined
    ? openStdinChunkSource()
    : await openFileChunkSource(path);

  if (
    knownByteLanguage !== undefined &&
    !interactive && streamRendered
  ) {
    return directRenderedStream(source, knownByteLanguage);
  }
  return await loadViewInputFromSource(source, {
    knownByteLanguage,
    detectByteLanguage: explicitLanguage === undefined,
    interactive,
    streamRendered,
  });
}

interface ChunkSourceBase {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly dispose: () => void | Promise<void>;
}

interface RegularFileChunkSource extends ChunkSourceBase {
  readonly kind: "regular-file";
  readonly snapshotBytes: number | undefined;
  readonly byteCount: () => number | undefined | Promise<number | undefined>;
}

interface StreamChunkSource extends ChunkSourceBase {
  readonly kind: "stream";
}

type ChunkSource = RegularFileChunkSource | StreamChunkSource;

function directRenderedStream(
  source: ChunkSource,
  language: Language,
): RenderedStreamInput {
  const input = byteInputFor(language)!;
  const byteLength = source.kind === "regular-file"
    ? source.snapshotBytes
    : undefined;
  return {
    kind: "rendered-stream",
    language,
    chunks: source.chunks,
    lineCount: byteLength === undefined
      ? undefined
      : input.renderedByteLineCount(byteLength),
    dispose: source.dispose,
  };
}

async function openFileChunkSource(
  path: string,
): Promise<ChunkSource> {
  const file = await Deno.open(path, { read: true });
  try {
    const stat = await file.stat();
    const snapshotBytes = stat.isFile && stat.size > 0 ? stat.size : undefined;
    return fileChunkSource(file, snapshotBytes, stat.isFile);
  } catch (error) {
    file.close();
    throw error;
  }
}

function fileChunkSource(
  file: Deno.FsFile,
  snapshotBytes: number | undefined,
  regularFile: boolean,
): ChunkSource {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    file.close();
  };
  const chunks = (async function* () {
    try {
      yield* readOpenFileChunks(file, snapshotBytes);
    } finally {
      dispose();
    }
  })();
  if (!regularFile) return { kind: "stream", chunks, dispose };
  return {
    kind: "regular-file",
    chunks,
    dispose,
    snapshotBytes,
    async byteCount(): Promise<number | undefined> {
      const stat = await file.stat();
      return stat.isFile && stat.size > 0 ? stat.size : undefined;
    },
  };
}

function openStdinChunkSource(): StreamChunkSource {
  if (Deno.stdin.isTerminal()) {
    return {
      kind: "stream",
      chunks: (async function* () {})(),
      dispose: () => {},
    };
  }
  return readableChunkSource(Deno.stdin.readable);
}

function readableChunkSource(
  readable: ReadableStream<Uint8Array>,
): StreamChunkSource {
  const reader = readable.getReader();
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal;
    disposal = reader.cancel().finally(() => reader.releaseLock());
    return disposal;
  };
  const chunks = (async function* () {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value !== undefined && value.length > 0) yield value;
      }
    } finally {
      await dispose();
    }
  })();
  return { kind: "stream", chunks, dispose };
}

interface Spool {
  readonly file: Deno.FsFile;
  readonly path: string;
}

interface LoadViewInputFromSourceOptions {
  readonly knownByteLanguage: Language | undefined;
  readonly detectByteLanguage: boolean;
  readonly interactive: boolean;
  readonly streamRendered: boolean;
}

async function loadViewInputFromSource(
  source: ChunkSource,
  options: LoadViewInputFromSourceOptions,
): Promise<LoadedViewInput> {
  const {
    knownByteLanguage,
    detectByteLanguage,
    interactive,
    streamRendered,
  } = options;
  const snapshotBytes = source.kind === "regular-file"
    ? source.snapshotBytes
    : undefined;
  const iterator = source.chunks[Symbol.asyncIterator]();
  const detector = detectByteLanguage && knownByteLanguage === undefined
    ? createByteLanguageDetector()
    : undefined;
  const previewByteLimit = knownByteLanguage === undefined
    ? detector?.previewByteLimit ?? 0
    : byteInputFor(knownByteLanguage)!.previewByteLimit;
  const prefix = interactive && previewByteLimit > 0
    ? new Uint8Array(previewByteLimit)
    : undefined;
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let prefixLength = 0;
  let totalBytes = 0;
  let selectedByteLanguage = knownByteLanguage;
  let spool: Spool | undefined;
  let sourceTransferred = false;

  const takeSpool = (): Spool | undefined => {
    const taken = spool;
    spool = undefined;
    return taken;
  };
  const discardRetainedInput = async () => {
    chunks.length = 0;
    retainedBytes = 0;
    await disposeSpool(takeSpool());
  };
  const ensureSpool = async (): Promise<Deno.FsFile> => {
    if (spool !== undefined) return spool.file;
    const path = await Deno.makeTempFile({ prefix: "cf-view-input-" });
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, {
        read: true,
        write: true,
        truncate: true,
      });
    } catch (error) {
      await Deno.remove(path);
      throw error;
    }
    spool = { file, path };
    for (const chunk of chunks) await writeAll(file, chunk);
    chunks.length = 0;
    retainedBytes = 0;
    return file;
  };
  const retain = async (value: Uint8Array) => {
    if (
      spool === undefined &&
      retainedBytes + value.length <=
        Math.max(previewByteLimit, MAX_RETAINED_INPUT_BYTES)
    ) {
      chunks.push(value.slice());
      retainedBytes += value.length;
    } else {
      await writeAll(await ensureSpool(), value);
    }
  };
  const streamRetained = async (
    continuation: boolean,
    language: Language,
  ): Promise<RenderedStreamInput> => {
    const initialSpool = takeSpool();
    try {
      if (initialSpool !== undefined) {
        await initialSpool.file.seek(0, Deno.SeekMode.Start);
      }
      const initialChunks = chunks.splice(0);
      retainedBytes = 0;
      sourceTransferred = continuation;
      return renderedStreamFromRetained(
        initialChunks,
        initialSpool,
        continuation ? { iterator, source } : undefined,
        language,
        snapshotBytes,
      );
    } catch (error) {
      sourceTransferred = false;
      await disposeSpool(initialSpool);
      throw error;
    }
  };

  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value === undefined || value.length === 0) continue;

      if (prefix !== undefined) {
        const prefixTake = Math.min(
          value.length,
          prefix.length - prefixLength,
        );
        if (prefixTake > 0) {
          prefix.set(value.subarray(0, prefixTake), prefixLength);
          prefixLength += prefixTake;
        }
      }
      totalBytes += value.length;

      if (selectedByteLanguage === undefined) {
        selectedByteLanguage = detector?.write(value);
      }
      if (selectedByteLanguage !== undefined && interactive) {
        const selectedInput = byteInputFor(selectedByteLanguage)!;
        if (chunks.length > 0 || spool !== undefined) {
          await discardRetainedInput();
        }
        if (source.kind === "stream") {
          return bufferedByteInput(
            prefix!.subarray(
              0,
              Math.min(prefixLength, selectedInput.previewByteLimit),
            ),
            selectedByteLanguage,
            prefixLength,
            false,
          );
        }
        if (prefixLength >= selectedInput.previewByteLimit) {
          const currentBytes = await source.byteCount();
          const extent = binaryPreviewExtent(
            prefixLength,
            totalBytes,
            false,
            currentBytes,
          );
          return bufferedByteInput(
            prefix!.subarray(0, selectedInput.previewByteLimit),
            selectedByteLanguage,
            extent.byteLength,
            extent.complete,
          );
        }
        continue;
      }
      await retain(value);
      if (
        streamRendered && selectedByteLanguage !== undefined
      ) {
        return await streamRetained(true, selectedByteLanguage);
      }
    }

    if (selectedByteLanguage === undefined) {
      selectedByteLanguage = detector?.finish();
      if (selectedByteLanguage !== undefined && interactive) {
        await discardRetainedInput();
      }
    }
    if (selectedByteLanguage !== undefined) {
      if (interactive) {
        const selectedInput = byteInputFor(selectedByteLanguage)!;
        return bufferedByteInput(
          prefix!.subarray(
            0,
            Math.min(prefixLength, selectedInput.previewByteLimit),
          ),
          selectedByteLanguage,
          totalBytes,
          true,
        );
      }
      if (streamRendered) {
        return await streamRetained(false, selectedByteLanguage);
      }
    }

    let bytes: Uint8Array;
    if (spool !== undefined) {
      await spool.file.seek(0, Deno.SeekMode.Start);
      bytes = await readAllFromOpenFile(spool.file, totalBytes);
    } else {
      bytes = mergeChunks(chunks, totalBytes);
    }
    return {
      kind: "bytes",
      bytes,
      ...(selectedByteLanguage ? { language: selectedByteLanguage } : {}),
      ...(detector !== undefined && selectedByteLanguage === undefined
        ? { byteLanguageDetectionComplete: true }
        : {}),
      extent: { byteLength: bytes.length, complete: true },
    };
  } finally {
    try {
      if (!sourceTransferred) await stopChunkSource(iterator, source);
    } finally {
      await disposeSpool(takeSpool());
    }
  }
}

function bufferedByteInput(
  bytes: Uint8Array,
  language: Language,
  byteLength: number,
  complete: boolean,
): BufferedViewInput {
  return {
    kind: "bytes",
    bytes,
    language,
    extent: { byteLength, complete },
  };
}

async function stopChunkSource(
  iterator: AsyncIterator<Uint8Array>,
  source: ChunkSource,
): Promise<void> {
  const disposal = source.dispose();
  try {
    await iterator.return?.();
  } finally {
    await disposal;
  }
}

function renderedStreamFromRetained(
  initialChunks: Uint8Array[],
  initialSpool: Spool | undefined,
  continuation:
    | {
      readonly iterator: AsyncIterator<Uint8Array>;
      readonly source: ChunkSource;
    }
    | undefined,
  language: Language,
  byteLength: number | undefined,
): RenderedStreamInput {
  const input = byteInputFor(language)!;
  let spool = initialSpool;
  let disposed = false;
  const disposeInitial = async () => {
    const taken = spool;
    spool = undefined;
    await disposeSpool(taken);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (continuation !== undefined) {
        await stopChunkSource(continuation.iterator, continuation.source);
      }
    } finally {
      await disposeInitial();
    }
  };
  const chunks = (async function* () {
    try {
      if (spool !== undefined) {
        yield* readOpenFileChunks(spool.file);
      } else {
        for (const chunk of initialChunks) yield chunk;
      }
      initialChunks.length = 0;
      await disposeInitial();
      if (continuation !== undefined) {
        for (;;) {
          const { value, done } = await continuation.iterator.next();
          if (done) break;
          if (value !== undefined && value.length > 0) yield value;
        }
      }
    } finally {
      await dispose();
    }
  })();
  return {
    kind: "rendered-stream",
    language,
    chunks,
    lineCount: byteLength === undefined
      ? undefined
      : input.renderedByteLineCount(byteLength),
    dispose,
  };
}

async function disposeSpool(spool: Spool | undefined): Promise<void> {
  if (spool === undefined) return;
  try {
    spool.file.close();
  } finally {
    await Deno.remove(spool.path);
  }
}

async function readAllFromOpenFile(
  file: Deno.FsFile,
  totalBytes: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await file.read(bytes.subarray(offset));
    if (read === null || read === 0) {
      throw new Error(
        "cf view: temporary file ended before all input bytes were read.",
      );
    }
    offset += read;
  }
  return bytes;
}

function mergeChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

interface AsyncWriter {
  write(data: Uint8Array): Promise<number>;
}

async function writeAll(writer: AsyncWriter, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await writer.write(data.subarray(offset));
    if (written <= 0) {
      throw new Error("cf view: temporary file accepted no bytes.");
    }
    offset += written;
  }
}

async function* readOpenFileChunks(
  source: Deno.FsFile,
  maxBytes?: number,
): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(64 * 1024);
  let remaining = maxBytes;
  while (remaining === undefined || remaining > 0) {
    const target = remaining === undefined
      ? buffer
      : buffer.subarray(0, Math.min(buffer.length, remaining));
    const read = await source.read(target);
    if (read === null || read === 0) return;
    if (remaining !== undefined) remaining -= read;
    yield buffer.subarray(0, read);
  }
}

export const _internal = {
  loadViewInputFromSource,
};
