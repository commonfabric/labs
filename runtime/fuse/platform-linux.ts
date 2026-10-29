// platform-linux.ts — Linux FUSE v3 low-level API implementation.
//
// The offsets here are confirmed by compiling and running verify-structs.c,
// which reads the headers of the architecture it is built on.

import {
  COMMON_SYMBOLS,
  createFuseArgs,
  type FileInfo,
  type FuseLib,
  type FusePlatform,
  makeWriteEntryParam,
  type MountHandle,
  msToTimespec,
  type StatOpts,
} from "./platform.ts";

//
// Library paths
//

const LIBFUSE_PATHS = [
  "/usr/lib/x86_64-linux-gnu/libfuse3.so", // Debian/Ubuntu x86_64
  "/usr/lib/aarch64-linux-gnu/libfuse3.so", // Debian/Ubuntu aarch64
  "/usr/lib/libfuse3.so", // Arch, Fedora
  "/usr/lib64/libfuse3.so", // RHEL/CentOS
  "/usr/lib64/libfuse3.so.3", // Fedora
  "/usr/lib64/libfuse3.so.4", // Fedora
];

// Linux-specific FFI symbols (FUSE v3)
//
// Key differences from v2:
//   - fuse_session_new replaces fuse_lowlevel_new (same signature)
//   - fuse_session_mount(session, mountpoint) replaces fuse_mount(mountpoint, args)
//   - fuse_session_unmount(session) replaces fuse_unmount(mountpoint, chan)
//   - No channel concept — session manages mount directly

const LINUX_SYMBOLS = {
  ...COMMON_SYMBOLS,
  fuse_session_new: {
    parameters: ["pointer", "pointer", "usize", "pointer"],
    result: "pointer",
  },
  fuse_session_mount: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  fuse_session_unmount: {
    parameters: ["pointer"],
    result: "void",
  },
} as const;

type LinuxLib = Deno.DynamicLibrary<typeof LINUX_SYMBOLS>;

// struct stat (Linux):
//   dev_t st_dev       @ 0   (u64)
//   ino_t st_ino       @ 8   (u64)
//   ...the block below, which moves...
//   off_t st_size      @ 48  (i64)
//   st_atim @ 72, st_mtim @ 88, st_ctim @ 104 (struct timespec, 16 each)
//
// glibc gives `st_nlink` eight bytes on x86_64 and four on arm64, which moves
// `st_mode`, `st_uid` and `st_gid` and makes the whole struct shorter.
// Everything from `st_size` on sits in the same place on both.

/** Where the members that move sit, and how long the struct is. */
export const STAT_BY_ARCH = {
  x86_64: { size: 144, nlink: 16, nlinkBytes: 8, mode: 24, uid: 28, gid: 32 },
  aarch64: { size: 128, nlink: 20, nlinkBytes: 4, mode: 16, uid: 24, gid: 28 },
} as const;

/**
 * The layout for the architecture this is running on. verify-structs.c reads
 * the headers of whichever architecture it is compiled on, so the harness
 * confirms this table wherever it runs.
 */
export const STAT_LAYOUT = STAT_BY_ARCH[Deno.build.arch];

const STAT_SIZE = STAT_LAYOUT.size;
const STAT_ST_SIZE_OFFSET = 48;
const STAT_ST_MTIM_OFFSET = 88;

/** Fill a `struct stat` as `stat` places the members that move. */
export function writeStatWith(
  stat: typeof STAT_LAYOUT,
  buf: ArrayBuffer,
  opts: StatOpts,
): void {
  const view = new DataView(buf);
  new Uint8Array(buf).fill(0);
  view.setBigUint64(8, opts.ino, true); // st_ino @ 8
  if (stat.nlinkBytes === 8) {
    view.setBigUint64(stat.nlink, BigInt(opts.nlink), true);
  } else {
    view.setUint32(stat.nlink, opts.nlink, true);
  }
  view.setUint32(stat.mode, opts.mode, true);
  view.setUint32(stat.uid, opts.uid ?? 0, true);
  view.setUint32(stat.gid, opts.gid ?? 0, true);
  view.setBigInt64(STAT_ST_SIZE_OFFSET, BigInt(opts.size), true);
  const { sec, nsec } = msToTimespec(opts.mtime);
  for (const secOffset of [72, 88, 104]) { // st_atim/st_mtim/st_ctim
    view.setBigInt64(secOffset, sec, true);
    view.setBigInt64(secOffset + 8, nsec, true);
  }
}

function writeStat(buf: ArrayBuffer, opts: StatOpts): void {
  writeStatWith(STAT_LAYOUT, buf, opts);
}

//
// fuse_entry_param
//
// Layout: ino(u64) + generation(u64) + stat + attr_timeout(f64) +
// entry_timeout(f64), so its size follows the architecture's struct stat.
//

const ENTRY_PARAM_SIZE = 16 + STAT_SIZE + 16;
const writeEntryParam = makeWriteEntryParam(
  writeStat,
  STAT_SIZE,
  ENTRY_PARAM_SIZE,
);

// fuse_file_info (FUSE v3)
// v3 removed the deprecated fh_old field.
//   int flags             @  0  (i32)
//   bitfield (32 bits)    @  4  (u32)
//   bitfield (32 bits)    @  8  (u32)
//   padding to align fh   @ 12  (u32)
//   uint64_t fh           @ 16  (u64)
//   uint64_t lock_owner   @ 24  (u64)
//   uint32_t poll_events  @ 32  (u32)
//   Total: 40 bytes (with trailing padding)
//
// NOTE: fh offset is a best-guess. Verify with verify-structs.c.

const FUSE_FILE_INFO_SIZE = 40;
const FH_OFFSET = 16;

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
  fiArr[FH_OFFSET / 8] = fh; // offset 16 = index 2
}

//
// O_* flags (Linux)
//

const O_CREAT = 0x40;
const O_TRUNC = 0x200;
const O_APPEND = 0x400;

//
// Errno constants (Linux)
//

const ENOTEMPTY = 39;
const ENOSYS = 38;
const ENODATA = 61; // Linux equivalent of macOS ENOATTR
const ENOTSUP = 95;

// fuse_lowlevel_ops offsets
// v3 keeps the same order for existing ops and adds new ones at the end.
// The offsets below should match v2 for all ops we use.
// Verify with verify-structs.c.

const OPS_SIZE = 352; // v3 has more ops than v2 (verified by verify-structs.c)
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

let fullLib: LinuxLib | null = null;

//
// Platform implementation
//

const linuxPlatform: FusePlatform = {
  provider() {
    return fullLib ? "linux-libfuse" : "unknown";
  },

  openFuse(): FuseLib {
    if (fullLib) return fullLib as unknown as FuseLib;

    const errors: string[] = [];
    for (const path of LIBFUSE_PATHS) {
      try {
        fullLib = Deno.dlopen(path, LINUX_SYMBOLS);
        console.log(`Loaded ${path}`);
        return fullLib as unknown as FuseLib;
      } catch (e) {
        errors.push(`  ${path}: ${e}`);
      }
    }

    throw new Error(
      `Could not open libfuse3. Install it with:\n` +
        `  sudo apt-get install libfuse3-dev fuse3   # Debian/Ubuntu\n` +
        `  sudo dnf install fuse3-devel fuse3         # Fedora/RHEL\n` +
        `  sudo pacman -S fuse3                       # Arch\n` +
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

  // Linux getxattr: no `position` parameter
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
        parameters: ["pointer", "u64", "pointer", "usize"],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        ino: number | bigint,
        namePtr: Deno.PointerValue,
        size: number | bigint,
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
        parameters: ["pointer", "u64", "pointer", "pointer", "usize", "i32"],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        ino: number | bigint,
        namePtr: Deno.PointerValue,
        valuePtr: Deno.PointerValue,
        size: number | bigint,
        flags: number,
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

  // Linux v3 rename: extra `flags` parameter (uint32_t)
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
        parameters: ["pointer", "u64", "pointer", "u64", "pointer", "u32"],
        result: "void",
      } as const,
      (
        req: Deno.PointerValue,
        parentIno: number | bigint,
        namePtr: Deno.PointerValue,
        newParentIno: number | bigint,
        newNamePtr: Deno.PointerValue,
        _flags: number,
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

    // FUSE v3: create session first, then mount
    const session = lib.symbols.fuse_session_new(
      Deno.UnsafePointer.of(new Uint8Array(argsBuf)),
      Deno.UnsafePointer.of(new Uint8Array(opsBuf)),
      opsSize,
      null,
    );
    if (!session) {
      throw new Error("fuse_session_new failed");
    }

    const mp = mountpoint as unknown as BufferSource;
    const rc = lib.symbols.fuse_session_mount(session, mp);
    if (rc !== 0) {
      lib.symbols.fuse_session_destroy(session);
      throw new Error(
        `fuse_session_mount failed (rc=${rc}). Is the mountpoint valid? Is FUSE available?`,
      );
    }

    // v3: notify target is the session itself (no channel concept)
    return { session, notifyTarget: session };
  },

  unmount(
    _lib: FuseLib,
    handle: MountHandle,
    _mountpoint: Uint8Array,
  ): void {
    fullLib!.symbols.fuse_session_unmount(handle.session);
  },

  cleanup(
    lib: FuseLib,
    handle: MountHandle,
    _mountpoint: Uint8Array,
    alreadyUnmounted: boolean,
  ): void {
    if (!alreadyUnmounted) {
      fullLib!.symbols.fuse_session_unmount(handle.session);
    }
    lib.symbols.fuse_session_destroy(handle.session);
  },
};

export default linuxPlatform;
