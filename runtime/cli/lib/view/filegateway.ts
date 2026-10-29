/**
 * The filesystem the interactive file picker (C-x C-f) talks to. A port, so the
 * session stays pure and testable: the real implementation wraps Deno, and a
 * test injects a fake. Opening a file selects its language from raw bytes, then
 * yields an {@link EditableSource} plus the language-decoded buffer.
 */

import { basename, dirname, join } from "@std/path";
import { type EditableSource, fileSource } from "./editsource.ts";
import {
  byteInputFor,
  createByteLanguageDetector,
  decodeLanguageInput,
  languageForFile,
} from "./languages/language.ts";
import { binaryPreviewExtent } from "./languages/binary/binary.ts";
import {
  closeSync,
  fstatSync,
  nodeFsConstants,
  openSync,
  readSync,
} from "../deps.ts";

export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

export interface FileGateway {
  /** The working directory the picker opens at when there is no current file. */
  cwd(): string;

  /** A directory's entries, or null when it cannot be read. */
  list(absDir: string): DirEntry[] | null;

  /** Open a file: its source and decoded buffer, or null on failure. */
  open(absPath: string): { source: EditableSource; text: string } | null;

  /** Join a directory and a path segment, normalized. */
  join(dir: string, segment: string): string;

  /** The parent directory of a path. */
  parent(path: string): string;

  /** The final path segment (for display). */
  base(path: string): string;
}

export function realFileGateway(): FileGateway {
  return {
    cwd: () => {
      try {
        return Deno.cwd();
      } catch {
        return ".";
      }
    },
    list: (absDir) => {
      try {
        const out: DirEntry[] = [];
        for (const e of Deno.readDirSync(absDir)) {
          out.push({ name: e.name, isDir: isDir(absDir, e) });
        }
        return out;
      } catch {
        return null;
      }
    },
    open: (absPath) => {
      try {
        return openFileSync(absPath);
      } catch {
        return null;
      }
    },
    join: (dir, segment) => join(dir, segment),
    parent: (path) => dirname(path),
    base: (path) => basename(path),
  };
}

function openFileSync(
  path: string,
): { source: EditableSource; text: string } {
  const file = openSync(
    path,
    nodeFsConstants.O_RDONLY | (nodeFsConstants.O_NONBLOCK ?? 0),
  );
  let spool: SyncSpool | undefined;
  const takeSpool = (): SyncSpool | undefined => {
    const taken = spool;
    spool = undefined;
    return taken;
  };
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) {
      throw new TypeError("cf view: the file picker only opens regular files.");
    }
    const filenameLanguage = languageForFile(path);
    const knownByteLanguage = byteInputFor(filenameLanguage) !== undefined
      ? filenameLanguage
      : undefined;
    const detector = knownByteLanguage === undefined
      ? createByteLanguageDetector()
      : undefined;
    const previewByteLimit = knownByteLanguage === undefined
      ? detector!.previewByteLimit
      : byteInputFor(knownByteLanguage)!.previewByteLimit;
    const prefix = new Uint8Array(previewByteLimit);
    const buffer = new Uint8Array(64 * 1024);
    const chunks: Uint8Array[] = [];
    let retainedBytes = 0;
    let prefixLength = 0;
    let totalBytes = 0;
    let remaining = stat.size > 0 ? stat.size : undefined;
    let selectedByteLanguage = knownByteLanguage;
    let reachedEof = false;

    const discardRetained = () => {
      chunks.length = 0;
      retainedBytes = 0;
      disposeSyncSpool(takeSpool());
    };
    const ensureSpool = (): Deno.FsFile => {
      if (spool !== undefined) return spool.file;
      const spoolPath = Deno.makeTempFileSync({ prefix: "cf-view-input-" });
      let spoolFile: Deno.FsFile;
      try {
        spoolFile = Deno.openSync(spoolPath, {
          read: true,
          write: true,
          truncate: true,
        });
      } catch (error) {
        Deno.removeSync(spoolPath);
        throw error;
      }
      spool = { file: spoolFile, path: spoolPath };
      for (const chunk of chunks) writeAllSync(spoolFile, chunk);
      chunks.length = 0;
      retainedBytes = 0;
      return spoolFile;
    };
    const retain = (bytes: Uint8Array) => {
      if (
        spool === undefined && retainedBytes + bytes.length <= previewByteLimit
      ) {
        chunks.push(bytes.slice());
        retainedBytes += bytes.length;
      } else {
        writeAllSync(ensureSpool(), bytes);
      }
    };

    while (remaining === undefined || remaining > 0) {
      const read = readSync(
        file,
        remaining === undefined
          ? buffer
          : buffer.subarray(0, Math.min(buffer.length, remaining)),
      );
      if (read === 0) {
        reachedEof = true;
        break;
      }
      if (remaining !== undefined) remaining -= read;
      const bytes = buffer.subarray(0, read);
      const prefixTake = Math.min(
        bytes.length,
        prefix.length - prefixLength,
      );
      if (prefixTake > 0) {
        prefix.set(bytes.subarray(0, prefixTake), prefixLength);
        prefixLength += prefixTake;
      }
      totalBytes += bytes.length;

      if (selectedByteLanguage === undefined) {
        selectedByteLanguage = detector!.write(bytes);
        if (selectedByteLanguage !== undefined) discardRetained();
      }
      if (selectedByteLanguage !== undefined) {
        const selectedInput = byteInputFor(selectedByteLanguage)!;
        if (prefixLength >= selectedInput.previewByteLimit) break;
      } else {
        retain(bytes);
      }
    }
    if (selectedByteLanguage === undefined) {
      selectedByteLanguage = detector!.finish();
      if (selectedByteLanguage !== undefined) discardRetained();
    }
    if (selectedByteLanguage !== undefined) {
      const selectedInput = byteInputFor(selectedByteLanguage)!;
      const shownLength = Math.min(
        prefixLength,
        selectedInput.previewByteLimit,
      );
      const current = fstatSync(file);
      const reportedBytes = current.size > 0 ? current.size : undefined;
      const extent = binaryPreviewExtent(
        shownLength,
        totalBytes,
        reachedEof,
        reportedBytes,
      );
      const decoded = selectedInput.decoder.decode(
        prefix.subarray(0, shownLength),
      );
      return {
        source: fileSource(path, selectedByteLanguage, {
          encode: decoded.encode,
          renderExtent: extent,
        }),
        text: decoded.text,
      };
    }

    let bytes: Uint8Array;
    if (spool !== undefined) {
      spool.file.seekSync(0, Deno.SeekMode.Start);
      bytes = readAllSync(spool.file, totalBytes);
    } else {
      bytes = mergeChunks(chunks, totalBytes);
    }
    const decoded = decodeLanguageInput(path, bytes, {
      byteLanguageDetectionComplete: true,
    });
    return {
      source: fileSource(path, decoded.language, {
        encode: decoded.source.encode,
        renderExtent: { byteLength: bytes.length, complete: true },
      }),
      text: decoded.source.text,
    };
  } finally {
    try {
      closeSync(file);
    } finally {
      disposeSyncSpool(takeSpool());
    }
  }
}

interface SyncSpool {
  readonly file: Deno.FsFile;
  readonly path: string;
}

function readAllSync(file: Deno.FsFile, totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  while (offset < bytes.length) {
    const read = file.readSync(bytes.subarray(offset));
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

function writeAllSync(file: Deno.FsFile, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = file.writeSync(bytes.subarray(offset));
    if (written <= 0) {
      throw new Error("cf view: temporary file accepted no bytes.");
    }
    offset += written;
  }
}

function disposeSyncSpool(spool: SyncSpool | undefined): void {
  if (spool === undefined) return;
  try {
    spool.file.close();
  } finally {
    Deno.removeSync(spool.path);
  }
}

/** Resolve symlinks so a link to a directory is offered as one. */
function isDir(dir: string, e: Deno.DirEntry): boolean {
  if (e.isDirectory) return true;
  if (!e.isSymlink) return false;
  try {
    return Deno.statSync(join(dir, e.name)).isDirectory;
  } catch {
    return false;
  }
}
