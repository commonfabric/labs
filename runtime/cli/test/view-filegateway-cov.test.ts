/**
 * The real {@link realFileGateway}: a thin port over Deno's filesystem used by
 * the `cf view` file picker. These tests drive it against a temp directory on
 * the actual disk so every branch — successful reads, the catch arms when a
 * path does not exist, and the symlink-resolving directory check — runs.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { realFileGateway } from "../lib/view/filegateway.ts";
import { MAX_BINARY_VIEW_BYTES } from "../lib/view/languages/binary/binary.ts";
import { pythonLanguage } from "../lib/view/languages/python/language.ts";

// These cases color Python through its synchronous entry points, which show
// plain text until its parser has loaded.
await pythonLanguage.prepare!();

/** Make a fresh temp directory and ensure it is removed after `fn` runs. */
async function withTempDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cf-filegateway-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function removeIfPresent(path: string): void {
  try {
    Deno.removeSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

Deno.test("realFileGateway.cwd: returns Deno's working directory", () => {
  const gw = realFileGateway();
  assertEquals(gw.cwd(), Deno.cwd());
});

Deno.test("realFileGateway.cwd: falls back to '.' when Deno.cwd throws", () => {
  // The gateway calls Deno.cwd() at invocation time. Swapping it for a throwing
  // stub drives the catch arm, which yields the relative "." as a last resort.
  const gw = realFileGateway();
  const original = Deno.cwd;
  try {
    (Deno as { cwd: () => string }).cwd = () => {
      throw new Deno.errors.NotCapable("read access denied");
    };
    assertEquals(gw.cwd(), ".");
  } finally {
    (Deno as { cwd: () => string }).cwd = original;
  }
});

Deno.test("realFileGateway.list: reads a directory's entries with isDir flags", async () => {
  await withTempDir((dir) => {
    Deno.mkdirSync(join(dir, "sub"));
    Deno.writeTextFileSync(join(dir, "a.ts"), "const a = 1;\n");

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null, "directory should be readable");
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(byName.get("sub"), true, "plain directory is a dir");
    assertEquals(byName.get("a.ts"), false, "plain file is not a dir");
  });
});

Deno.test("realFileGateway.list: returns null when the directory cannot be read", () => {
  const gw = realFileGateway();
  const missing = join(Deno.cwd(), "definitely-not-a-real-dir-xyz-12345");
  assertEquals(gw.list(missing), null);
});

Deno.test("realFileGateway.list: a symlink to a directory is reported as a dir", async () => {
  await withTempDir((dir) => {
    Deno.mkdirSync(join(dir, "realdir"));
    Deno.symlinkSync(join(dir, "realdir"), join(dir, "dirlink"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("dirlink"),
      true,
      "symlink resolving to a directory is offered as a directory",
    );
  });
});

Deno.test("realFileGateway.list: a symlink to a file is not a dir", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(join(dir, "target.ts"), "const x = 1;\n");
    Deno.symlinkSync(join(dir, "target.ts"), join(dir, "filelink"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("filelink"),
      false,
      "symlink resolving to a file is not a directory",
    );
  });
});

Deno.test("realFileGateway.list: a broken symlink is not a dir", async () => {
  await withTempDir((dir) => {
    // Point at a path that does not exist so statSync throws and the
    // isDir helper's catch arm returns false.
    Deno.symlinkSync(join(dir, "nonexistent-target"), join(dir, "broken"));

    const gw = realFileGateway();
    const entries = gw.list(dir);
    assert(entries !== null);
    const byName = new Map(entries!.map((e) => [e.name, e.isDir]));
    assertEquals(
      byName.get("broken"),
      false,
      "a dangling symlink cannot be a directory",
    );
  });
});

Deno.test("realFileGateway.open: reads a file into an editable source and its text", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "doc.ts");
    const contents = "export const greeting = 'hi';\n";
    Deno.writeTextFileSync(path, contents);

    const gw = realFileGateway();
    const opened = gw.open(path);
    assert(opened !== null, "an existing file opens");
    assertEquals(opened!.text, contents);
    assertEquals(opened!.source.editable, true);
    assertEquals(opened!.source.path, path);
    assertEquals(opened!.source.label, "doc.ts");
  });
});

Deno.test("realFileGateway.open: keeps shebang selection in the editable source", async () => {
  await withTempDir((dir) => {
    const path = join(dir, "greet");
    const contents = "#!/usr/bin/env python3\ndef greet():\n    return 'hi'\n";
    Deno.writeTextFileSync(path, contents);

    const opened = realFileGateway().open(path);
    assert(opened !== null);
    assert(
      opened.source.parse(contents).lines.flatMap((line) => line.spans).some(
        (span) => span.cls === "storageKeyword" && span.text === "def",
      ),
      "the editable source retains Python selection",
    );
  });
});

describe("realFileGateway.open() buffered input", () => {
  const portableIt = Deno.build.os === "windows" ? it.skip : it;

  it("reads an empty regular file", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "empty.txt");
      Deno.writeFileSync(path, new Uint8Array());

      const opened = realFileGateway().open(path);

      assert(opened !== null);
      expect(opened.text).toBe("");
      expect(opened.source.editable).toBe(true);
    });
  });

  it("preserves binary bytes in a read-only source", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "payload.data");
      const bytes = new Uint8Array([0x41, 0x00, 0xff]);
      Deno.writeFileSync(path, bytes);

      const opened = realFileGateway().open(path);
      assert(opened !== null);
      expect(
        [...opened.text].map((value) => value.charCodeAt(0)),
      ).toEqual([...bytes]);
      expect(opened.source.editable).toBe(false);
      expect(opened.source.defaultViewMode).toBe("rendered");
      const source = opened.source.parse(opened.text);
      assert(opened.source.render?.(source).lines[0].text.endsWith("|A␀␦|"));
    });
  });

  it("bounds a large binary preview", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "asset.png");
      Deno.writeFileSync(
        path,
        new Uint8Array(MAX_BINARY_VIEW_BYTES + 16).fill(0x41),
      );

      const opened = realFileGateway().open(path);
      assert(opened !== null);
      expect(opened.text.length).toBe(MAX_BINARY_VIEW_BYTES);
      const rendered = opened.source.render?.(opened.source.parse(opened.text));
      assert(rendered?.lines.at(-2)?.text.includes("16 bytes omitted"));
      expect(rendered?.lines.at(-1)?.text).toBe("00040010");
    });
  });

  it("spools and restores large text files", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "large.data");
      const bytes = new Uint8Array(
        MAX_BINARY_VIEW_BYTES + 2 * 64 * 1024,
      ).fill(0x41);
      Deno.writeFileSync(path, bytes);

      const makeTempFileSync = Deno.makeTempFileSync;
      const openSync = Deno.openSync;
      let spoolPath: string | undefined;
      try {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = (options) => {
            spoolPath = makeTempFileSync(options);
            return spoolPath;
          };
        (Deno as { openSync: typeof Deno.openSync }).openSync = (
          candidate,
          options,
        ) => {
          const file = openSync(candidate, options);
          if (candidate !== spoolPath) return file;
          return {
            writeSync: (data: Uint8Array) =>
              file.writeSync(
                data.subarray(0, Math.max(1, data.length - 1)),
              ),
            readSync: (data: Uint8Array) => file.readSync(data),
            seekSync: (offset: number, whence: Deno.SeekMode) =>
              file.seekSync(offset, whence),
            close: () => file.close(),
          } as unknown as Deno.FsFile;
        };

        const opened = realFileGateway().open(path);

        assert(opened !== null);
        expect(opened.text.length).toBe(bytes.length);
        expect(opened.text).toBe("A".repeat(bytes.length));
        expect(opened.source.editable).toBe(true);
        assert(spoolPath !== undefined);
        expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
      } finally {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = makeTempFileSync;
        (Deno as { openSync: typeof Deno.openSync }).openSync = openSync;
        if (spoolPath !== undefined) {
          removeIfPresent(spoolPath);
        }
      }
    });
  });

  it("detects truncated UTF-8 at EOF", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "truncated.data");
      const bytes = new Uint8Array([0x41, 0xe2]);
      Deno.writeFileSync(path, bytes);

      const opened = realFileGateway().open(path);

      assert(opened !== null);
      expect(opened.source.editable).toBe(false);
      expect(
        [...opened.text].map((value) => value.charCodeAt(0)),
      ).toEqual([...bytes]);
    });
  });

  it("removes a spool whose open fails", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "large.data");
      Deno.writeFileSync(
        path,
        new Uint8Array(MAX_BINARY_VIEW_BYTES + 1).fill(0x41),
      );
      const makeTempFileSync = Deno.makeTempFileSync;
      const openSync = Deno.openSync;
      let spoolPath: string | undefined;
      try {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = (options) => {
            spoolPath = makeTempFileSync(options);
            return spoolPath;
          };
        (Deno as { openSync: typeof Deno.openSync }).openSync = (
          candidate,
          options,
        ) => {
          if (candidate === spoolPath) throw new Error("spool open failed");
          return openSync(candidate, options);
        };

        expect(realFileGateway().open(path)).toBe(null);
        assert(spoolPath !== undefined);
        expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
      } finally {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = makeTempFileSync;
        (Deno as { openSync: typeof Deno.openSync }).openSync = openSync;
        if (spoolPath !== undefined) {
          removeIfPresent(spoolPath);
        }
      }
    });
  });

  it("rejects a spool writer that makes no progress", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "large.data");
      Deno.writeFileSync(
        path,
        new Uint8Array(MAX_BINARY_VIEW_BYTES + 1).fill(0x41),
      );
      const makeTempFileSync = Deno.makeTempFileSync;
      const openSync = Deno.openSync;
      let closeCalls = 0;
      let spoolPath: string | undefined;
      try {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = (options) => {
            spoolPath = makeTempFileSync(options);
            return spoolPath;
          };
        (Deno as { openSync: typeof Deno.openSync }).openSync = (
          candidate,
          options,
        ) => {
          const file = openSync(candidate, options);
          if (candidate !== spoolPath) return file;
          return {
            writeSync: () => 0,
            readSync: (data: Uint8Array) => file.readSync(data),
            seekSync: (offset: number, whence: Deno.SeekMode) =>
              file.seekSync(offset, whence),
            close: () => {
              closeCalls++;
              file.close();
            },
          } as unknown as Deno.FsFile;
        };

        expect(realFileGateway().open(path)).toBe(null);
        expect(closeCalls).toBe(1);
        assert(spoolPath !== undefined);
        expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
      } finally {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = makeTempFileSync;
        (Deno as { openSync: typeof Deno.openSync }).openSync = openSync;
        if (spoolPath !== undefined) {
          removeIfPresent(spoolPath);
        }
      }
    });
  });

  it("rejects a premature spool EOF", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "large.data");
      Deno.writeFileSync(
        path,
        new Uint8Array(MAX_BINARY_VIEW_BYTES + 1).fill(0x41),
      );
      const makeTempFileSync = Deno.makeTempFileSync;
      const openSync = Deno.openSync;
      let closeCalls = 0;
      let spoolPath: string | undefined;
      try {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = (options) => {
            spoolPath = makeTempFileSync(options);
            return spoolPath;
          };
        (Deno as { openSync: typeof Deno.openSync }).openSync = (
          candidate,
          options,
        ) => {
          const file = openSync(candidate, options);
          if (candidate !== spoolPath) return file;
          return {
            writeSync: (data: Uint8Array) => file.writeSync(data),
            readSync: () => null,
            seekSync: (offset: number, whence: Deno.SeekMode) =>
              file.seekSync(offset, whence),
            close: () => {
              closeCalls++;
              file.close();
            },
          } as unknown as Deno.FsFile;
        };

        expect(realFileGateway().open(path)).toBe(null);
        expect(closeCalls).toBe(1);
        assert(spoolPath !== undefined);
        expect(() => Deno.statSync(spoolPath!)).toThrow(Deno.errors.NotFound);
      } finally {
        (Deno as { makeTempFileSync: typeof Deno.makeTempFileSync })
          .makeTempFileSync = makeTempFileSync;
        (Deno as { openSync: typeof Deno.openSync }).openSync = openSync;
        if (spoolPath !== undefined) {
          removeIfPresent(spoolPath);
        }
      }
    });
  });

  portableIt("rejects a FIFO without waiting for a writer", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "events");
      const created = await new Deno.Command("mkfifo", { args: [path] })
        .output();
      expect(created.success).toBe(true);
      expect(realFileGateway().open(path)).toBe(null);
    });
  });
});

Deno.test("realFileGateway.open: returns null when the file cannot be read", () => {
  const gw = realFileGateway();
  const missing = join(Deno.cwd(), "definitely-not-a-real-file-xyz-12345.ts");
  assertEquals(gw.open(missing), null);
});

Deno.test("realFileGateway.join: joins and normalizes a directory and segment", () => {
  const gw = realFileGateway();
  assertEquals(gw.join("/work", "a.ts"), join("/work", "a.ts"));
  assertEquals(gw.join("/work/sub", ".."), join("/work/sub", ".."));
});

Deno.test("realFileGateway.parent: returns the parent directory", () => {
  const gw = realFileGateway();
  assertEquals(gw.parent("/work/sub/a.ts"), "/work/sub");
});

Deno.test("realFileGateway.base: returns the final path segment", () => {
  const gw = realFileGateway();
  assertEquals(gw.base("/work/sub/a.ts"), "a.ts");
});
