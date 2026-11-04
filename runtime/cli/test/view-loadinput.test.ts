import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { _internal, loadViewInput } from "../lib/view/loadinput.ts";
import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";

type LoadFromSource = typeof _internal.loadViewInputFromSource;
type ChunkSource = Parameters<LoadFromSource>[0];
type LoadOptions = Parameters<LoadFromSource>[1];

function loadFromSource(
  source: ChunkSource,
  options: Partial<LoadOptions> = {},
) {
  return _internal.loadViewInputFromSource(source, {
    knownByteLanguage: undefined,
    detectByteLanguage: true,
    interactive: true,
    streamRendered: true,
    ...options,
  });
}

function streamSource(
  values: readonly Uint8Array[],
  onDispose: () => void = () => {},
): ChunkSource {
  return {
    kind: "stream",
    chunks: (async function* () {
      for (const value of values) yield value;
    })(),
    dispose: onDispose,
  };
}

function regularSource(
  values: readonly Uint8Array[],
  snapshotBytes: number | undefined,
  currentBytes: number | undefined = snapshotBytes,
): ChunkSource {
  return {
    kind: "regular-file",
    chunks: (async function* () {
      for (const value of values) yield value;
    })(),
    snapshotBytes,
    byteCount: () => currentBytes,
    dispose: () => {},
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let length = 0;
  for await (const value of chunks) {
    values.push(value.slice());
    length += value.length;
  }
  const collected = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    collected.set(value, offset);
    offset += value.length;
  }
  return collected;
}

function ascii(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x41);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

describe("view-loadinput", () => {
  it("closes a file when its initial stat fails", async () => {
    const open = Deno.open;
    let closeCalls = 0;
    const fakeFile = {
      stat: () => Promise.reject(new Error("stat failed")),
      close: () => closeCalls++,
    } as unknown as Deno.FsFile;
    try {
      (Deno as { open: typeof Deno.open }).open = () =>
        Promise.resolve(fakeFile);

      await expect(loadViewInput("unused", undefined, undefined, true))
        .rejects.toThrow("stat failed");
      expect(closeCalls).toBe(1);
    } finally {
      (Deno as { open: typeof Deno.open }).open = open;
    }
  });

  it("refreshes the byte count of regular file input", async () => {
    const open = Deno.open;
    try {
      for (const currentBytes of [MAX_BINARY_VIEW_BYTES - 1, 0]) {
        const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16);
        bytes[0] = 0;
        let offset = 0;
        let statCalls = 0;
        let closeCalls = 0;
        const file = {
          stat: () =>
            Promise.resolve({
              isFile: true,
              size: statCalls++ === 0 ? bytes.length : currentBytes,
            }),
          read: (target: Uint8Array) => {
            if (offset >= bytes.length) return Promise.resolve(null);
            const length = Math.min(target.length, bytes.length - offset);
            target.set(bytes.subarray(offset, offset + length));
            offset += length;
            return Promise.resolve(length);
          },
          close: () => closeCalls++,
        } as unknown as Deno.FsFile;
        (Deno as { open: typeof Deno.open }).open = () => Promise.resolve(file);

        const input = await loadViewInput("unused", undefined, undefined, true);

        assert(input.kind === "bytes");
        expect(input.extent).toEqual({
          byteLength: MAX_BINARY_VIEW_BYTES,
          complete: false,
        });
        expect(statCalls).toBe(2);
        expect(closeCalls).toBe(1);
      }
    } finally {
      (Deno as { open: typeof Deno.open }).open = open;
    }
  });

  it("discards text retained before binary detection in interactive streams", async () => {
    let disposeCalls = 0;
    const input = await loadFromSource(
      streamSource(
        [new TextEncoder().encode("text"), new Uint8Array([0])],
        () => disposeCalls++,
      ),
    );

    assert(input.kind === "bytes");
    expect(input.language?.id).toBe("binary");
    expect(input.bytes).toEqual(
      new Uint8Array([0x74, 0x65, 0x78, 0x74, 0]),
    );
    expect(input.extent).toEqual({ byteLength: 5, complete: false });
    expect(disposeCalls).toBe(1);
  });

  it("detects truncated UTF-8 when an interactive stream ends", async () => {
    const input = await loadFromSource(
      streamSource([new Uint8Array([0xe2])]),
    );

    assert(input.kind === "bytes");
    expect(input.language?.id).toBe("binary");
    expect(input.bytes).toEqual(new Uint8Array([0xe2]));
    expect(input.extent).toEqual({ byteLength: 1, complete: true });
  });

  it("skips empty stream chunks", async () => {
    const bytes = new TextEncoder().encode("after empty");
    const input = await loadFromSource(
      streamSource([new Uint8Array(), bytes]),
      { interactive: false, streamRendered: false },
    );

    assert(input.kind === "bytes");
    expect(input.bytes).toEqual(bytes);
    expect(input.language).toBe(undefined);
    expect(input.byteLanguageDetectionComplete).toBe(true);
    expect(input.extent).toEqual({
      byteLength: bytes.length,
      complete: true,
    });
  });

  it("keeps noninteractive binary input buffered when rendering is disabled", async () => {
    const bytes = new Uint8Array([0x41, 0, 0x42]);
    const input = await loadFromSource(
      streamSource([bytes]),
      { interactive: false, streamRendered: false },
    );

    assert(input.kind === "bytes");
    expect(input.bytes).toEqual(bytes);
    expect(input.language?.id).toBe("binary");
    expect(input.extent).toEqual({
      byteLength: bytes.length,
      complete: true,
    });
  });

  it("distinguishes stale and complete sizes for interactive regular files", async () => {
    const bytes = new Uint8Array(MAX_BINARY_VIEW_BYTES + 16);
    for (const currentBytes of [MAX_BINARY_VIEW_BYTES - 1, bytes.length]) {
      const input = await loadFromSource(
        regularSource([bytes], bytes.length, currentBytes),
      );

      assert(input.kind === "bytes");
      expect(input.language?.id).toBe("binary");
      expect(input.bytes.length).toBe(MAX_BINARY_VIEW_BYTES);
      expect(input.extent).toEqual(
        currentBytes < bytes.length
          ? { byteLength: MAX_BINARY_VIEW_BYTES, complete: false }
          : { byteLength: bytes.length, complete: true },
      );
    }
  });

  it("returns a rendered byte stream after noninteractive EOF detection", async () => {
    const input = await loadFromSource(
      streamSource([new Uint8Array([0xe2])]),
      { interactive: false },
    );

    assert(input.kind === "rendered-stream");
    expect(input.language.id).toBe("binary");
    expect(await collect(input.chunks)).toEqual(new Uint8Array([0xe2]));
  });

  it("restores large text input from its temporary spool", async () => {
    const makeTempFile = Deno.makeTempFile;
    const open = Deno.open;
    const values = [ascii(200 * 1024), ascii(100 * 1024), ascii(16 * 1024)];
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      (Deno as { open: typeof Deno.open }).open = async (path, options) => {
        const file = await open(path, options);
        if (path !== spoolPath) return file;
        return {
          write: (data: Uint8Array) =>
            file.write(
              data.subarray(0, Math.max(1, data.length - 1)),
            ),
          read: (data: Uint8Array) => file.read(data),
          seek: (offset: number, whence: Deno.SeekMode) =>
            file.seek(offset, whence),
          close: () => file.close(),
        } as unknown as Deno.FsFile;
      };

      const input = await loadFromSource(
        streamSource(values),
        { interactive: false, streamRendered: false },
      );

      assert(input.kind === "bytes");
      expect(input.language).toBe(undefined);
      expect(input.byteLanguageDetectionComplete).toBe(true);
      expect(input.bytes.length).toBe(316 * 1024);
      expect(input.bytes[0]).toBe(0x41);
      expect(input.bytes.at(-1)).toBe(0x41);
      assert(spoolPath !== undefined);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      (Deno as { open: typeof Deno.open }).open = open;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });

  it("streams the spool and remaining source after late binary detection", async () => {
    const makeTempFile = Deno.makeTempFile;
    const values = [
      ascii(200 * 1024),
      ascii(100 * 1024),
      new Uint8Array([0]),
      new Uint8Array([0x42]),
    ];
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      const input = await loadFromSource(
        streamSource(values),
        { interactive: false },
      );

      assert(input.kind === "rendered-stream");
      expect(input.language.id).toBe("binary");
      assert(spoolPath !== undefined);
      expect(Deno.statSync(spoolPath).isFile).toBe(true);
      const collected = await collect(input.chunks);
      expect(collected.length).toBe(300 * 1024 + 2);
      expect(collected[300 * 1024]).toBe(0);
      expect(collected.at(-1)).toBe(0x42);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });

  it("removes the temporary file after an asynchronous spool open fails", async () => {
    const makeTempFile = Deno.makeTempFile;
    const open = Deno.open;
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      (Deno as { open: typeof Deno.open }).open = (path, options) => {
        if (path === spoolPath) {
          return Promise.reject(new Error("spool open failed"));
        }
        return open(path, options);
      };

      await expect(
        loadFromSource(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          { interactive: false, streamRendered: false },
        ),
      ).rejects.toThrow("spool open failed");
      assert(spoolPath !== undefined);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      (Deno as { open: typeof Deno.open }).open = open;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });

  it("closes and removes the spool after rewind fails", async () => {
    const makeTempFile = Deno.makeTempFile;
    const open = Deno.open;
    let closeCalls = 0;
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      (Deno as { open: typeof Deno.open }).open = (path, options) => {
        if (path !== spoolPath) return open(path, options);
        return Promise.resolve({
          write: (data: Uint8Array) => Promise.resolve(data.length),
          seek: () => Promise.reject(new Error("seek failed")),
          close: () => closeCalls++,
        } as unknown as Deno.FsFile);
      };

      await expect(
        loadFromSource(
          streamSource([
            ascii(MAX_BINARY_VIEW_BYTES + 1),
            new Uint8Array([0]),
          ]),
          { interactive: false },
        ),
      ).rejects.toThrow("seek failed");
      expect(closeCalls).toBe(1);
      assert(spoolPath !== undefined);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      (Deno as { open: typeof Deno.open }).open = open;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });

  it("rejects an asynchronous spool writer that makes no progress", async () => {
    const makeTempFile = Deno.makeTempFile;
    const open = Deno.open;
    let closeCalls = 0;
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      (Deno as { open: typeof Deno.open }).open = (path, options) => {
        if (path !== spoolPath) return open(path, options);
        return Promise.resolve({
          write: () => Promise.resolve(0),
          close: () => closeCalls++,
        } as unknown as Deno.FsFile);
      };

      await expect(
        loadFromSource(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          { interactive: false, streamRendered: false },
        ),
      ).rejects.toThrow("temporary file accepted no bytes");
      expect(closeCalls).toBe(1);
      assert(spoolPath !== undefined);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      (Deno as { open: typeof Deno.open }).open = open;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });

  it("rejects a premature EOF from an asynchronous spool", async () => {
    const makeTempFile = Deno.makeTempFile;
    const open = Deno.open;
    let closeCalls = 0;
    let spoolPath: string | undefined;
    try {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        async (
          options,
        ) => {
          spoolPath = await makeTempFile(options);
          return spoolPath;
        };
      (Deno as { open: typeof Deno.open }).open = async (path, options) => {
        const file = await open(path, options);
        if (path !== spoolPath) return file;
        return {
          write: (data: Uint8Array) => file.write(data),
          read: () => Promise.resolve(null),
          seek: (offset: number, whence: Deno.SeekMode) =>
            file.seek(offset, whence),
          close: () => {
            closeCalls++;
            file.close();
          },
        } as unknown as Deno.FsFile;
      };

      await expect(
        loadFromSource(
          streamSource([ascii(MAX_BINARY_VIEW_BYTES + 1)]),
          { interactive: false, streamRendered: false },
        ),
      ).rejects.toThrow(
        "temporary file ended before all input bytes were read",
      );
      expect(closeCalls).toBe(1);
      assert(spoolPath !== undefined);
      expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
    } finally {
      (Deno as { makeTempFile: typeof Deno.makeTempFile }).makeTempFile =
        makeTempFile;
      (Deno as { open: typeof Deno.open }).open = open;
      if (spoolPath !== undefined) {
        await removeIfPresent(spoolPath);
      }
    }
  });
});
