// platform-darwin.ts — macOS FUSE v2 low-level API implementation.
//
// Supports FUSE-T (preferred, no kernel extension) and macFUSE (fallback).
// macOS lays these structs out the same way on both architectures it runs
// on, so one set of offsets covers them.

import {
  COMMON_SYMBOLS,
  createFuseArgs,
  type FileInfo,
  type FuseLib,
  type FusePlatform,
  type FuseProvider,
  makeWriteEntryParam,
  type MountHandle,
  msToTimespec,
  type StatOpts,
} from "./platform.ts";

//
// Library paths
//

/**
 * Candidate libfuse locations, in preference order. FUSE-T's installer
 * supports two layouts: the root install symlinks the library into
 * /usr/local/lib, and the per-user install (running the installer's
 * postinstall as a non-root user) places it under
 * ~/.fuse-t/usr/local/lib. macFUSE installs into /usr/local/lib only.
 */
export function libfusePaths(
  env: { get(name: string): string | undefined } = Deno.env,
): string[] {
  const paths = ["/usr/local/lib/libfuse-t.dylib"];
  const home = env.get("HOME");
  if (home) {
    paths.push(`${home}/.fuse-t/usr/local/lib/libfuse-t.dylib`);
  }
  paths.push("/usr/local/lib/libfuse.2.dylib"); // macFUSE (kernel extension)
  return paths;
}

//
// Darwin-specific FFI symbols (FUSE v2)
//

const DARWIN_SYMBOLS = {
  ...COMMON_SYMBOLS,
  fuse_mount: {
    parameters: ["buffer", "pointer"],
    result: "pointer",
  },
  fuse_unmount: {
    parameters: ["buffer", "pointer"],
    result: "void",
  },
  fuse_lowlevel_new: {
    parameters: ["pointer", "pointer", "usize", "pointer"],
    result: "pointer",
  },
  fuse_session_add_chan: {
    parameters: ["pointer", "pointer"],
    result: "void",
  },
  fuse_session_remove_chan: {
    parameters: ["pointer"],
    result: "void",
  },
} as const;

type DarwinLib = Deno.DynamicLibrary<typeof DARWIN_SYMBOLS>;

// struct stat (macOS, 144 bytes):
//   dev_t st_dev      @ 0   (i32)
//   mode_t st_mode    @ 4   (u16)
//   nlink_t st_nlink  @ 6   (u16)
//   ino_t st_ino      @ 8   (u64)
//   uid_t st_uid      @ 16  (u32)
//   gid_t st_gid      @ 20  (u32)
//   ...
//   off_t st_size     @ 96  (i64)

const STAT_SIZE = 144;
const STAT_ST_SIZE_OFFSET = 96;
const STAT_ST_MTIM_OFFSET = 48;

// macOS struct stat timespec offsets (64-bit inode layout):
//   st_atimespec @ 32 (tv_sec @ 32, tv_nsec @ 40)
//   st_mtimespec @ 48 (tv_sec @ 48, tv_nsec @ 56)
//   st_ctimespec @ 64 (tv_sec @ 64, tv_nsec @ 72)
function writeTimespecs(view: DataView, mtime?: number): void {
  const { sec, nsec } = msToTimespec(mtime);
  for (const secOffset of [32, 48, 64]) {
    view.setBigInt64(secOffset, sec, true);
    view.setBigInt64(secOffset + 8, nsec, true);
  }
}

function writeStat(buf: ArrayBuffer, opts: StatOpts): void {
  const view = new DataView(buf);
  new Uint8Array(buf).fill(0);
  view.setUint16(4, opts.mode, true); // st_mode
  view.setUint16(6, opts.nlink, true); // st_nlink
  view.setBigUint64(8, opts.ino, true); // st_ino
  view.setUint32(16, opts.uid ?? 0, true); // st_uid
  view.setUint32(20, opts.gid ?? 0, true); // st_gid
  writeTimespecs(view, opts.mtime); // st_atimespec/st_mtimespec/st_ctimespec
  view.setBigInt64(96, BigInt(opts.size), true); // st_size
}

//
// fuse_entry_param (176 bytes)
//

const ENTRY_PARAM_SIZE = 176;
const writeEntryParam = makeWriteEntryParam(
  writeStat,
  STAT_SIZE,
  ENTRY_PARAM_SIZE,
);

// fuse_file_info (macOS 64-bit, 40 bytes):
//   int flags            @  0  (i32)
//   unsigned long fh_old @  8  (u64, deprecated)
//   int writepage        @ 16  (i32)
//   bitfield             @ 20  (u32)
//   uint64_t fh          @ 24  (u64)
//   uint64_t lock_owner  @ 32  (u64)

const FUSE_FILE_INFO_SIZE = 40;
const FH_OFFSET = 24;

function readFileInfo(ptr: Deno.PointerValue): FileInfo {
  if (!ptr) return { flags: 0, fh: 0n };
  const view = new Deno.UnsafePointerView(ptr);
  return {
    flags: view.getInt32(0),
    fh: view.getBigUint64(FH_OFFSET),
  };
}

function writeFileInfo(ptr: Deno.PointerValue, fh: bigint): void {
  if (!ptr) return;
  const fiArr = new BigUint64Array(
    Deno.UnsafePointerView.getArrayBuffer(ptr, FUSE_FILE_INFO_SIZE),
  );
  fiArr[FH_OFFSET / 8] = fh; // offset 24 = index 3
}

//
// O_* flags (macOS)
//

const O_CREAT = 0x0200;
const O_TRUNC = 0x0400;
const O_APPEND = 0x0008;

//
// Errno constants (macOS)
//

const ENOTEMPTY = 66;
const ENOSYS = 78;
const ENODATA = 93; // macOS ENOATTR
const ENOTSUP = 45;

//
// fuse_lowlevel_ops offsets (v2)
//

const OPS_SIZE = 320;
const OPS_OFFSETS = {
  init: 0,
  destroy: 8,
  lookup: 16,
  forget: 24,
  getattr: 32,
  setattr: 40,
  readlink: 48,
  mknod: 56,
  mkdir: 64,
  unlink: 72,
  rmdir: 80,
  symlink: 88,
  rename: 96,
  link: 104,
  open: 112,
  read: 120,
  write: 128,
  flush: 136,
  release: 144,
  fsync: 152,
  opendir: 160,
  readdir: 168,
  releasedir: 176,
  fsyncdir: 184,
  statfs: 192,
  setxattr: 200,
  getxattr: 208,
  listxattr: 216,
  removexattr: 224,
  access: 232,
  create: 240,
} as const;

const FUSE_ARGS_STRUCT_SIZE = 24;

//
// Module state
//

let fullLib: DarwinLib | null = null;
let loadedProvider: FuseProvider = "unknown";

//
// Platform implementation
//

const darwinPlatform: FusePlatform = {
  provider() {
    return loadedProvider;
  },

  openFuse(): FuseLib {
    if (fullLib) return fullLib as unknown as FuseLib;

    const errors: string[] = [];
    for (const path of libfusePaths()) {
      try {
        fullLib = Deno.dlopen(path, DARWIN_SYMBOLS);
        loadedProvider = path.includes("libfuse-t") ? "fuse-t" : "macfuse";
        console.log(`Loaded ${path}`);
        return fullLib as unknown as FuseLib;
      } catch (e) {
        errors.push(`  ${path}: ${e}`);
      }
    }

    throw new Error(
      `Could not open libfuse. Install FUSE-T (recommended) or macFUSE:\n` +
        `  brew install fuse-t\n` +
        `  brew install --cask macfuse\n` +
        `Tried:\n${errors.join("\n")}`,
    );
  },

  STAT_SIZE,
  ENTRY_PARAM_SIZE,
  FUSE_FILE_INFO_SIZE,
  OPS_SIZE,
  OPS_OFFSETS,
  FUSE_ARGS_STRUCT_SIZE,
  STAT_ST_SIZE_OFFSET,
  STAT_ST_MTIM_OFFSET,

  writeStat,
  writeEntryParam,
  readFileInfo,
  writeFileInfo,
  createFuseArgs(args: string[]) {
    return createFuseArgs(args, FUSE_ARGS_STRUCT_SIZE);
  },

  O_CREAT,
  O_TRUNC,
  O_APPEND,
  ENOTEMPTY,
  ENOSYS,
  ENODATA,
  ENOTSUP,
  FH_OFFSET,

  // macOS getxattr has extra `position` parameter (uint32_t)
  createGetxattrCallback(
    handler: (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      size: bigint,
    ) => void,
  ) {
    return new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "u64", "pointer", "usize", "u32"],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        ino: number | bigint,
        namePtr: Deno.PointerValue,
        size: number | bigint,
        _position: number,
      ) => handler(req, BigInt(ino), namePtr, BigInt(size)),
    );
  },

  createSetxattrCallback(
    handler: (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      valuePtr: Deno.PointerValue,
      size: bigint,
      flags: number,
    ) => void,
  ) {
    return new Deno.UnsafeCallback(
      {
        parameters: [
          "pointer",
          "u64",
          "pointer",
          "pointer",
          "usize",
          "i32",
          "u32",
        ],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        ino: number | bigint,
        namePtr: Deno.PointerValue,
        valuePtr: Deno.PointerValue,
        size: number | bigint,
        flags: number,
        _position: number,
      ) =>
        handler(
          req,
          BigInt(ino),
          namePtr,
          valuePtr,
          BigInt(size),
          flags,
        ),
    );
  },

  // macOS rename: no flags parameter
  createRenameCallback(
    handler: (
      req: Deno.PointerValue,
      parent: bigint,
      namePtr: Deno.PointerValue,
      newparent: bigint,
      newnamePtr: Deno.PointerValue,
    ) => void,
  ) {
    return new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "u64", "pointer", "u64", "pointer"],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        parentIno: number | bigint,
        namePtr: Deno.PointerValue,
        newParentIno: number | bigint,
        newNamePtr: Deno.PointerValue,
      ) =>
        handler(
          req,
          BigInt(parentIno),
          namePtr,
          BigInt(newParentIno),
          newNamePtr,
        ),
    );
  },

  mount(
    _lib: FuseLib,
    mountpoint: Uint8Array,
    argsBuf: ArrayBuffer,
    opsBuf: ArrayBuffer,
    opsSize: bigint,
  ): MountHandle {
    const lib = fullLib!;

    // Cast Uint8Array to BufferSource for Deno FFI "buffer" params
    const mp = mountpoint as unknown as BufferSource;

    const chan = lib.symbols.fuse_mount(
      mp,
      Deno.UnsafePointer.of(new Uint8Array(argsBuf)),
    );
    if (!chan) {
      throw new Error(
        "fuse_mount failed. Is the mountpoint valid? Is macFUSE installed?",
      );
    }

    const session = lib.symbols.fuse_lowlevel_new(
      Deno.UnsafePointer.of(new Uint8Array(argsBuf)),
      Deno.UnsafePointer.of(new Uint8Array(opsBuf)),
      opsSize,
      null,
    );
    if (!session) {
      lib.symbols.fuse_unmount(mp, chan);
      throw new Error("fuse_lowlevel_new failed");
    }

    lib.symbols.fuse_session_add_chan(session, chan);

    return { session, notifyTarget: chan };
  },

  unmount(
    _lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
  ): void {
    const mp = mountpoint as unknown as BufferSource;
    fullLib!.symbols.fuse_unmount(mp, handle.notifyTarget);
  },

  cleanup(
    lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
    alreadyUnmounted: boolean,
  ): void {
    const mp = mountpoint as unknown as BufferSource;
    fullLib!.symbols.fuse_session_remove_chan(handle.notifyTarget);
    lib.symbols.fuse_session_destroy(handle.session);
    if (!alreadyUnmounted) {
      fullLib!.symbols.fuse_unmount(mp, handle.notifyTarget);
    }
  },
};

export default darwinPlatform;
