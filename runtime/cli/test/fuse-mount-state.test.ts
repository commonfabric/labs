import { expect } from "@std/expect";
import { encodeHex } from "@std/encoding/hex";
import { join, resolve, toFileUrl } from "@std/path";

import {
  canonicalizeMountLookupPath,
  ensureExecShim,
  F_MNTONNAME_OFF,
  findMountForPath,
  type GetfsstatLibrary,
  isCompiledBinary,
  mountpointHash,
  type MountStateEntry,
  prepareMountStatePath,
  readAllMountStates,
  readDarwinMountpoints,
  readMountState,
  writeMountState,
} from "../lib/fuse.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

function entry(mountpoint: string): MountStateEntry {
  return {
    pid: Deno.pid,
    mountpoint,
    apiUrl: "",
    identity: "",
    startedAt: "2026-03-17T00:00:00.000Z",
  };
}

/** The state-file hash of `path` taken lexically, without resolving links. */
async function lexicalHash(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(resolve(path)),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 16);
}

describe("fuse-mount-state", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "fuse-mount-state-" }),
    );
  });

  afterEach(async () => {
    await Deno.remove(tmp, { recursive: true });
  });

  describe("canonicalizeMountLookupPath", () => {
    it("re-appends the unresolved tail to the nearest ancestor that resolves", async () => {
      const realPath = (path: string) =>
        path === "/a"
          ? Promise.resolve("/real-a")
          : Promise.reject(new Deno.errors.NotFound(path));
      expect(await canonicalizeMountLookupPath("/a/b/c", realPath)).toBe(
        "/real-a/b/c",
      );
    });

    it("returns the resolved path when no ancestor resolves, not even the root", async () => {
      const realPath = (path: string) =>
        Promise.reject(new Deno.errors.PermissionDenied(path));
      expect(await canonicalizeMountLookupPath("/a/../b/c", realPath)).toBe(
        "/b/c",
      );
    });
  });

  describe("prepareMountStatePath", () => {
    it("removes the state file at a symlinked mountpoint's lexical hash", async () => {
      const stateDir = join(tmp, "state");
      await Deno.mkdir(join(tmp, "real"));
      await Deno.symlink(join(tmp, "real"), join(tmp, "link"));
      const mountpoint = join(tmp, "link", "mnt");
      await Deno.mkdir(stateDir);
      const legacy = join(stateDir, `${await lexicalHash(mountpoint)}.json`);
      const unrelated = join(stateDir, "0123456789abcdef.json");
      await Deno.writeTextFile(legacy, "{}");
      await Deno.writeTextFile(unrelated, "{}");

      const path = await prepareMountStatePath(stateDir, mountpoint);

      expect(path).toBe(
        join(
          stateDir,
          `${await mountpointHash(join(tmp, "real", "mnt"))}.json`,
        ),
      );
      expect(path).not.toBe(legacy);
      await expect(Deno.stat(legacy)).rejects.toThrow(Deno.errors.NotFound);
      expect((await Deno.stat(unrelated)).isFile).toBe(true);

      // With no file at the lexical hash, preparing again still succeeds.
      expect(await prepareMountStatePath(stateDir, mountpoint)).toBe(path);
    });
  });

  describe("state file validation", () => {
    it("skips JSON values that are not mount state entries", async () => {
      const mountpoint = join(tmp, "mnt");
      const path = await prepareMountStatePath(tmp, mountpoint);
      await Deno.writeTextFile(path, "42");
      await Deno.writeTextFile(join(tmp, "other.json"), "null");
      await Deno.writeTextFile(join(tmp, "array.json"), "[1]");

      expect(await readMountState(tmp, mountpoint)).toBe(null);
      expect(await readAllMountStates(tmp)).toEqual([]);

      await writeMountState(tmp, entry(mountpoint));
      expect((await readMountState(tmp, mountpoint))?.entry.mountpoint).toBe(
        mountpoint,
      );
    });
  });

  describe("findMountForPath", () => {
    it("skips live mounts that do not contain the path", async () => {
      await writeMountState(tmp, entry(join(tmp, "a")));
      await writeMountState(tmp, entry(join(tmp, "b")));

      const found = await findMountForPath(join(tmp, "b", "space"), tmp);
      expect(found?.entry.mountpoint).toBe(join(tmp, "b"));
      expect(await findMountForPath(join(tmp, "c"), tmp)).toBe(null);
    });
  });

  describe("readDarwinMountpoints", () => {
    it("returns each mountpoint getfsstat fills in, and closes the library", () => {
      let closes = 0;
      let calls = 0;
      const lib: GetfsstatLibrary = {
        symbols: {
          getfsstat: (buf, bytes) => {
            if (calls++ === 0) return 1;
            const view = new Uint8Array(
              Deno.UnsafePointerView.getArrayBuffer(buf!, bytes),
            );
            view.set(new TextEncoder().encode("/mnt/fake"), F_MNTONNAME_OFF);
            return 1;
          },
        },
        close: () => {
          closes++;
        },
      };
      expect(readDarwinMountpoints(() => lib)).toEqual(["/mnt/fake"]);
      expect(closes).toBe(1);
    });

    it("returns null when libSystem cannot be opened", () => {
      expect(readDarwinMountpoints(() => null)).toBe(null);
    });
  });

  describe("isCompiledBinary", () => {
    it("returns false for the deno runtime and true for anything else", () => {
      expect(isCompiledBinary("/usr/local/bin/deno")).toBe(false);
      expect(isCompiledBinary("/opt/deno/deno.exe")).toBe(false);
      expect(isCompiledBinary("/opt/bin/cf")).toBe(true);
    });
  });

  describe("ensureExecShim", () => {
    let importMetaUrl: string;

    beforeEach(() => {
      importMetaUrl = toFileUrl(
        join(tmp, "repo", "runtime", "cli", "lib", "fuse.ts"),
      ).href;
    });

    it("writes a shim that runs a compiled binary directly, in the state directory", async () => {
      const stateDir = join(tmp, "state");
      const shim = await ensureExecShim(stateDir, importMetaUrl, "/opt/bin/cf");

      expect(shim.startsWith(`${stateDir}/cf-exec-`)).toBe(true);
      expect(shim.slice(`${stateDir}/cf-exec-`.length)).toMatch(
        /^[0-9a-f]{16}$/,
      );
      const script = await Deno.readTextFile(shim);
      expect(script).toContain('exec "/opt/bin/cf" "$@"');
      expect(script).not.toContain(" run ");
      expect((await Deno.stat(shim)).mode! & 0o111).toBe(0o111);
      await expect(Deno.stat(join(tmp, "repo"))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    });

    it("throws rather than falling back when the repo shim fails for a reason other than permission", async () => {
      const stateDir = join(tmp, "state");
      await Deno.mkdir(join(tmp, "repo", ".cf", "fuse", "cf-exec"), {
        recursive: true,
      });

      await expect(
        ensureExecShim(stateDir, importMetaUrl, "/usr/local/bin/deno"),
      ).rejects.toThrow(Deno.errors.IsADirectory);
      expect(
        [...Deno.readDirSync(stateDir)].map((file) => file.name),
      ).toEqual([]);
    });
  });
});
