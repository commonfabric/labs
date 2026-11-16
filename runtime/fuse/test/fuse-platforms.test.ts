import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { darwinLibfusePaths, LINUX_LIBFUSE_PATHS } from "../library-paths.ts";
import darwinPlatform, {
  type DarwinLib,
  openDarwinFuse,
} from "../platform-darwin.ts";
import linuxPlatform, {
  type LinuxLib,
  openLinuxFuse,
} from "../platform-linux.ts";
import {
  type FuseLib,
  type FusePlatform,
  getPlatform,
  readCString,
} from "../platform.ts";

/** A pointer standing for the native object named `id`. */
function pointer(id: number): Deno.PointerObject {
  return Deno.UnsafePointer.create(BigInt(id))!;
}

function pointerId(value: Deno.PointerValue): number | null {
  return value === null ? null : Number(Deno.UnsafePointer.value(value));
}

/**
 * The functions every libfuse provides, none of which these cases call;
 * each throws if one is called.
 */
function unusedCommonSymbols(): FuseLib["symbols"] {
  const unused = (name: string) => () => {
    throw new Error(`${name} is not part of loading or mounting`);
  };
  return {
    fuse_session_loop: unused("fuse_session_loop"),
    fuse_session_destroy: unused("fuse_session_destroy"),
    fuse_opt_free_args: unused("fuse_opt_free_args"),
    fuse_reply_err: unused("fuse_reply_err"),
    fuse_reply_entry: unused("fuse_reply_entry"),
    fuse_reply_attr: unused("fuse_reply_attr"),
    fuse_reply_buf: unused("fuse_reply_buf"),
    fuse_reply_open: unused("fuse_reply_open"),
    fuse_reply_readlink: unused("fuse_reply_readlink"),
    fuse_reply_write: unused("fuse_reply_write"),
    fuse_reply_create: unused("fuse_reply_create"),
    fuse_reply_xattr: unused("fuse_reply_xattr"),
    fuse_reply_none: unused("fuse_reply_none"),
    fuse_add_direntry: unused("fuse_add_direntry"),
    fuse_lowlevel_notify_inval_entry: unused(
      "fuse_lowlevel_notify_inval_entry",
    ),
    fuse_lowlevel_notify_inval_inode: unused(
      "fuse_lowlevel_notify_inval_inode",
    ),
  };
}

/** What a fake library reports its session calls returning. */
interface SessionResults {
  session?: Deno.PointerValue;
  mountResult?: number;
  channel?: Deno.PointerValue;
}

/** A libfuse3 whose session calls are recorded in `calls`. */
function fakeLinuxLib(calls: string[], results: SessionResults = {}): LinuxLib {
  return {
    symbols: {
      ...unusedCommonSymbols(),
      fuse_session_destroy: (session) => {
        calls.push(`destroy ${pointerId(session)}`);
      },
      fuse_session_new: (_args, _ops, size) => {
        calls.push(`new ops=${size}`);
        return results.session === undefined ? pointer(7) : results.session;
      },
      fuse_session_mount: (session, mountpoint) => {
        calls.push(
          `mount ${pointerId(session)} ${
            new TextDecoder().decode(mountpoint ?? undefined)
          }`,
        );
        return results.mountResult ?? 0;
      },
      fuse_session_unmount: (session) => {
        calls.push(`unmount ${pointerId(session)}`);
      },
    },
    close() {},
  };
}

/** A FUSE v2 library whose channel and session calls are recorded. */
function fakeDarwinLib(
  calls: string[],
  results: SessionResults = {},
): DarwinLib {
  return {
    symbols: {
      ...unusedCommonSymbols(),
      fuse_session_destroy: (session) => {
        calls.push(`destroy ${pointerId(session)}`);
      },
      fuse_mount: (mountpoint) => {
        calls.push(
          `mount ${new TextDecoder().decode(mountpoint ?? undefined)}`,
        );
        return results.channel === undefined ? pointer(3) : results.channel;
      },
      fuse_unmount: (_mountpoint, channel) => {
        calls.push(`unmount ${pointerId(channel)}`);
      },
      fuse_lowlevel_new: (_args, _ops, size) => {
        calls.push(`new ops=${size}`);
        return results.session === undefined ? pointer(7) : results.session;
      },
      fuse_session_add_chan: (session, channel) => {
        calls.push(`add ${pointerId(channel)} to ${pointerId(session)}`);
      },
      fuse_session_remove_chan: (channel) => {
        calls.push(`remove ${pointerId(channel)}`);
      },
    },
    close() {},
  };
}

const mountpoint = new TextEncoder().encode("/mnt/cf\0");

describe("fuse-platforms", () => {
  let logged: string[];
  const originalLog = console.log;

  beforeEach(() => {
    logged = [];
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
  });

  afterEach(() => {
    console.log = originalLog;
  });

  describe("openLinuxFuse()", () => {
    it("loads the first libfuse3 that opens and says which", () => {
      const tried: string[] = [];
      const lib = fakeLinuxLib([]);

      const fuse = openLinuxFuse((path) => {
        tried.push(path);
        if (tried.length < 3) throw new Error("not found");
        return lib;
      });

      expect(tried).toEqual(LINUX_LIBFUSE_PATHS.slice(0, 3));
      expect(fuse.provider).toBe("linux-libfuse");
      expect(fuse.symbols).toBe(lib.symbols);
      expect(logged).toEqual([`Loaded ${LINUX_LIBFUSE_PATHS[2]}`]);
    });

    it("throws how to install libfuse3 and why each location failed when none opens", () => {
      expect(() =>
        openLinuxFuse((path) => {
          throw new Error(`no ${path}`);
        })
      ).toThrow(
        new Error(
          "Could not open libfuse3. Install it with:\n" +
            "  sudo apt-get install libfuse3-dev fuse3   # Debian/Ubuntu\n" +
            "  sudo dnf install fuse3-devel fuse3         # Fedora/RHEL\n" +
            "  sudo pacman -S fuse3                       # Arch\n" +
            "Tried:\n" +
            LINUX_LIBFUSE_PATHS.map((path) => `  ${path}: Error: no ${path}`)
              .join("\n"),
        ),
      );
    });

    it("mounts a new session, notifies the kernel through it, and unmounts and destroys it", () => {
      const calls: string[] = [];
      const fuse = openLinuxFuse(() => fakeLinuxLib(calls));

      const handle = fuse.mount(
        mountpoint,
        new ArrayBuffer(24),
        new ArrayBuffer(8),
        352n,
      );
      fuse.unmount(handle, mountpoint);
      fuse.cleanup(handle, mountpoint, true);
      fuse.cleanup(handle, mountpoint, false);

      expect(pointerId(handle.session)).toBe(7);
      expect(handle.notifyTarget).toBe(handle.session);
      expect(calls).toEqual([
        "new ops=352",
        "mount 7 /mnt/cf\0",
        "unmount 7",
        "destroy 7",
        "unmount 7",
        "destroy 7",
      ]);
    });

    it("throws when no session can be made, and destroys a session it cannot mount", () => {
      const noSession: string[] = [];
      const unmountable: string[] = [];

      expect(() =>
        openLinuxFuse(() => fakeLinuxLib(noSession, { session: null })).mount(
          mountpoint,
          new ArrayBuffer(24),
          new ArrayBuffer(8),
          352n,
        )
      ).toThrow(new Error("fuse_session_new failed"));
      expect(() =>
        openLinuxFuse(() => fakeLinuxLib(unmountable, { mountResult: -1 }))
          .mount(mountpoint, new ArrayBuffer(24), new ArrayBuffer(8), 352n)
      ).toThrow(
        "fuse_session_mount failed (rc=-1). Is the mountpoint valid?",
      );

      expect(noSession).toEqual(["new ops=352"]);
      expect(unmountable.at(-1)).toBe("destroy 7");
    });
  });

  describe("openDarwinFuse()", () => {
    it("reports FUSE-T or macFUSE by the library that opened", () => {
      const fuseT = openDarwinFuse(
        () => fakeDarwinLib([]),
        ["/usr/local/lib/libfuse-t.dylib"],
      );
      const macFuse = openDarwinFuse((path) => {
        if (path.includes("libfuse-t")) throw new Error("not installed");
        return fakeDarwinLib([]);
      }, darwinLibfusePaths({ get: () => undefined }));

      expect(fuseT.provider).toBe("fuse-t");
      expect(macFuse.provider).toBe("macfuse");
      expect(logged).toEqual([
        "Loaded /usr/local/lib/libfuse-t.dylib",
        "Loaded /usr/local/lib/libfuse.2.dylib",
      ]);
    });

    it("throws how to install FUSE-T or macFUSE when no library opens", () => {
      expect(() =>
        openDarwinFuse(() => {
          throw new Error("missing");
        }, ["/a.dylib"])
      ).toThrow(
        new Error(
          "Could not open libfuse. Install FUSE-T (recommended) or macFUSE:\n" +
            "  brew install fuse-t\n" +
            "  brew install --cask macfuse\n" +
            "Tried:\n  /a.dylib: Error: missing",
        ),
      );
    });

    it("mounts a channel, makes a session over it, notifies the kernel through the channel, and takes both down", () => {
      const calls: string[] = [];
      const fuse = openDarwinFuse(() => fakeDarwinLib(calls), ["/f.dylib"]);

      const handle = fuse.mount(
        mountpoint,
        new ArrayBuffer(24),
        new ArrayBuffer(8),
        320n,
      );
      fuse.unmount(handle, mountpoint);
      fuse.cleanup(handle, mountpoint, true);
      fuse.cleanup(handle, mountpoint, false);

      expect(pointerId(handle.session)).toBe(7);
      expect(pointerId(handle.notifyTarget)).toBe(3);
      expect(calls).toEqual([
        "mount /mnt/cf\0",
        "new ops=320",
        "add 3 to 7",
        "unmount 3",
        "remove 3",
        "destroy 7",
        "remove 3",
        "destroy 7",
        "unmount 3",
      ]);
    });

    it("throws when the channel cannot be mounted, and unmounts a channel with no session", () => {
      const noChannel: string[] = [];
      const noSession: string[] = [];

      expect(() =>
        openDarwinFuse(
          () => fakeDarwinLib(noChannel, { channel: null }),
          ["/f.dylib"],
        ).mount(mountpoint, new ArrayBuffer(24), new ArrayBuffer(8), 320n)
      ).toThrow(
        new Error(
          "fuse_mount failed. Is the mountpoint valid? Is macFUSE installed?",
        ),
      );
      expect(() =>
        openDarwinFuse(
          () => fakeDarwinLib(noSession, { session: null }),
          ["/f.dylib"],
        ).mount(mountpoint, new ArrayBuffer(24), new ArrayBuffer(8), 320n)
      ).toThrow(new Error("fuse_lowlevel_new failed"));

      expect(noChannel).toEqual(["mount /mnt/cf\0"]);
      expect(noSession.at(-1)).toBe("unmount 3");
    });
  });

  for (
    const [name, platform] of [
      ["linux", linuxPlatform],
      ["darwin", darwinPlatform],
    ] as [string, FusePlatform][]
  ) {
    describe(`the ${name} struct helpers`, () => {
      it("write a file handle into a `fuse_file_info` and read it back with the open flags", () => {
        const info = new Uint8Array(platform.FUSE_FILE_INFO_SIZE);
        new DataView(info.buffer).setInt32(0, 0o2, true);
        const at = Deno.UnsafePointer.of(info);

        platform.writeFileInfo(at, 0x1234_5678_9abcn);

        expect(platform.readFileInfo(at)).toEqual({
          flags: 0o2,
          fh: 0x1234_5678_9abcn,
        });
        expect(
          new DataView(info.buffer).getBigUint64(platform.FH_OFFSET, true),
        ).toBe(0x1234_5678_9abcn);
      });

      it("read no file info from a null pointer and write nothing to one", () => {
        platform.writeFileInfo(null, 1n);

        expect(platform.readFileInfo(null)).toEqual({ flags: 0, fh: 0n });
      });

      it("lay out `fuse_args` as a count and an array of C strings", () => {
        const { argsBuf, argvBuf } = platform.createFuseArgs([
          "fuse",
          "-o",
          "allow_other",
        ]);
        const view = new DataView(argsBuf);

        expect(argsBuf.byteLength).toBe(platform.FUSE_ARGS_STRUCT_SIZE);
        expect(view.getInt32(0, true)).toBe(3);
        expect(view.getBigUint64(8, true)).toBe(
          BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(argvBuf))),
        );
        expect(view.getInt32(16, true)).toBe(0);
        expect(
          [...argvBuf].map((address) =>
            readCString(Deno.UnsafePointer.create(address))
          ),
        ).toEqual(["fuse", "-o", "allow_other"]);
      });
    });
  }

  describe("readCString()", () => {
    it("returns the empty string for a null pointer", () => {
      expect(readCString(null)).toBe("");
    });
  });

  describe("getPlatform()", () => {
    it("returns the bindings for macOS and for Linux", async () => {
      expect(await getPlatform("darwin")).toBe(darwinPlatform);
      expect(await getPlatform("linux")).toBe(linuxPlatform);
    });

    it("throws for an operating system with no bindings", async () => {
      await expect(getPlatform("windows")).rejects.toThrow(
        "Unsupported platform: windows",
      );
    });
  });
});
