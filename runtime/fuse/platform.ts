// platform.ts — Shared types, constants, and platform dispatcher for FUSE FFI.
//
// Platform-specific implementations live in platform-darwin.ts (FUSE v2) and
// platform-linux.ts (FUSE v3). This module provides the shared interface,
// constants that are identical across platforms, and a runtime dispatcher.

//
// Shared types
//

export interface StatOpts {
  ino: bigint;
  mode: number;
  nlink: number;
  size: number;
  uid?: number;
  gid?: number;

  /** Modification time in milliseconds since the epoch. */
  mtime?: number;
}

export interface EntryParamOpts {
  ino: bigint;
  generation?: bigint;
  attr: StatOpts;
  attrTimeout?: number;
  entryTimeout?: number;
}

export interface FileInfo {
  flags: number;
  fh: bigint;
}

export interface MountHandle {
  session: Deno.PointerValue;

  /** Channel pointer on macOS (FUSE v2), session pointer on Linux (FUSE v3). */
  notifyTarget: Deno.PointerValue;
}

/**
 * Split a millisecond timestamp into the seconds and nanoseconds of a
 * `struct timespec`. An undefined timestamp maps to the epoch (all zero), which
 * is what an uninitialized stat buffer already holds.
 */
export function msToTimespec(ms?: number): { sec: bigint; nsec: bigint } {
  if (ms === undefined) return { sec: 0n, nsec: 0n };
  return {
    sec: BigInt(Math.floor(ms / 1000)),
    nsec: BigInt(Math.floor((ms % 1000) * 1_000_000)),
  };
}

//
// Common FFI symbols (identical between FUSE v2 and v3)
//

export const COMMON_SYMBOLS = {
  // Session lifecycle
  fuse_session_loop: {
    parameters: ["pointer"],
    result: "i32",
    nonblocking: true,
  },
  fuse_session_destroy: {
    parameters: ["pointer"],
    result: "void",
  },
  fuse_opt_free_args: {
    parameters: ["pointer"],
    result: "void",
  },

  // Reply functions (called from callbacks)
  fuse_reply_err: {
    parameters: ["pointer", "i32"],
    result: "i32",
  },
  fuse_reply_entry: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_attr: {
    parameters: ["pointer", "pointer", "f64"],
    result: "i32",
  },
  fuse_reply_buf: {
    parameters: ["pointer", "pointer", "usize"],
    result: "i32",
  },
  fuse_reply_open: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_readlink: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  fuse_reply_write: {
    parameters: ["pointer", "usize"],
    result: "i32",
  },
  fuse_reply_create: {
    parameters: ["pointer", "pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_xattr: {
    parameters: ["pointer", "usize"],
    result: "i32",
  },
  fuse_reply_none: {
    parameters: ["pointer"],
    result: "void",
  },

  // Directory entry helper
  fuse_add_direntry: {
    parameters: ["pointer", "pointer", "usize", "buffer", "pointer", "i64"],
    result: "usize",
  },

  // Kernel cache invalidation (FUSE 2.8+ / FUSE 3.x)
  // First param is channel (v2) or session (v3) — callers use MountHandle.notifyTarget.
  //
  // These run nonblocking, on an FFI thread rather than the isolate thread. On
  // Linux, notify_inval_entry enters the kernel and takes the parent
  // directory's inode lock for write; a concurrent lookup under that directory
  // holds the same lock for read until the daemon answers it. The daemon
  // answers requests on the isolate thread, so a synchronous notify would block
  // that thread inside the kernel behind a lookup only that thread can complete,
  // and the mount would stop serving. Running the notify off the isolate thread
  // keeps the request path free to answer the lookup, which releases the read
  // lock and lets the invalidation proceed. FUSE-T on macOS acts on neither
  // call, whether it returns success or an ENOTCONN error, so the thread
  // choice is immaterial there.
  fuse_lowlevel_notify_inval_entry: {
    parameters: ["pointer", "u64", "buffer", "usize"],
    result: "i32",
    nonblocking: true,
  },
  fuse_lowlevel_notify_inval_inode: {
    parameters: ["pointer", "u64", "i64", "i64"],
    result: "i32",
    nonblocking: true,
  },
} as const;

export type FuseLib = Deno.DynamicLibrary<typeof COMMON_SYMBOLS>;

//
// Platform interface
//

// deno-lint-ignore no-explicit-any
type AnyCallback = Deno.UnsafeCallback<any>;

/** Which FUSE implementation openFuse() loaded. */
export type FuseProvider = "fuse-t" | "macfuse" | "linux-libfuse" | "unknown";

export interface FusePlatform {
  /** Open the platform-appropriate libfuse and return a lib with common symbols. */
  openFuse(): FuseLib;

  /** The implementation loaded by openFuse(); "unknown" before it runs. */
  provider(): FuseProvider;

  // Struct sizes
  STAT_SIZE: number;
  ENTRY_PARAM_SIZE: number;
  FUSE_FILE_INFO_SIZE: number;
  OPS_SIZE: number;
  OPS_OFFSETS: Readonly<Record<string, number>>;
  FUSE_ARGS_STRUCT_SIZE: number;

  /** Byte offset of st_size within struct stat. */
  STAT_ST_SIZE_OFFSET: number;

  /** Byte offset of st_mtim(espec) within struct stat. */
  STAT_ST_MTIM_OFFSET: number;

  //
  // Struct helpers
  //

  writeStat(buf: ArrayBuffer, opts: StatOpts): void;
  writeEntryParam(buf: ArrayBuffer, opts: EntryParamOpts): void;
  readFileInfo(ptr: Deno.PointerValue): FileInfo;
  writeFileInfo(ptr: Deno.PointerValue, fh: bigint): void;
  createFuseArgs(args: string[]): {
    argsBuf: ArrayBuffer;
    argv: Deno.PointerValue;
    argvBuf: BigUint64Array;
    encodedArgs: Uint8Array[];
  };

  // Platform-varying constants
  O_CREAT: number;
  O_TRUNC: number;
  O_APPEND: number;
  ENOTEMPTY: number;
  ENOSYS: number;
  ENODATA: number;
  ENOTSUP: number;

  /** Byte offset of fh within fuse_file_info. */
  FH_OFFSET: number;

  // Callback factories for ops with platform-varying signatures.
  // macOS getxattr has extra `position` param; Linux rename has extra `flags` param.
  createGetxattrCallback(
    handler: (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      size: bigint,
    ) => void,
  ): AnyCallback;

  createSetxattrCallback(
    handler: (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      valuePtr: Deno.PointerValue,
      size: bigint,
      flags: number,
    ) => void,
  ): AnyCallback;

  createRenameCallback(
    handler: (
      req: Deno.PointerValue,
      parent: bigint,
      namePtr: Deno.PointerValue,
      newparent: bigint,
      newnamePtr: Deno.PointerValue,
    ) => void,
  ): AnyCallback;

  // Mount lifecycle
  mount(
    lib: FuseLib,
    mountpoint: Uint8Array,
    argsBuf: ArrayBuffer,
    opsBuf: ArrayBuffer,
    opsSize: bigint,
  ): MountHandle;

  unmount(
    lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
  ): void;

  cleanup(
    lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
    alreadyUnmounted: boolean,
  ): void;
}

//
// Shared constants (identical on macOS and Linux)
//

// Errno constants (POSIX-standard values)
export const ENOENT = 2;
export const EIO = 5;
export const EACCES = 13;
export const EEXIST = 17;
export const EXDEV = 18;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const EFBIG = 27;
export const ENOSPC = 28;
export const EROFS = 30;
export const ERANGE = 34;

// O_* flags (these three are POSIX-standard)
export const O_RDONLY = 0x0000;
export const O_WRONLY = 0x0001;
export const O_RDWR = 0x0002;

// setattr to_set flags.
// Values match fuse_lowlevel.h for libfuse 2.x and 3.x. Some names are
// platform/version-specific aliases for the same bit; keep all names explicit
// so CFC guardrails can distinguish caller intent without bypassing unknowns.
export const FUSE_SET_ATTR_MODE = 1 << 0;
export const FUSE_SET_ATTR_UID = 1 << 1;
export const FUSE_SET_ATTR_GID = 1 << 2;
export const FUSE_SET_ATTR_SIZE = 1 << 3;
export const FUSE_SET_ATTR_ATIME = 1 << 4;
export const FUSE_SET_ATTR_MTIME = 1 << 5;
export const FUSE_SET_ATTR_ATIME_NOW = 1 << 7;
export const FUSE_SET_ATTR_MTIME_NOW = 1 << 8;
export const FUSE_SET_ATTR_FORCE = 1 << 9;
export const FUSE_SET_ATTR_CTIME = 1 << 10;
export const FUSE_SET_ATTR_KILL_SUID = 1 << 11;
export const FUSE_SET_ATTR_KILL_SGID = 1 << 12;
export const FUSE_SET_ATTR_FILE = 1 << 13;
export const FUSE_SET_ATTR_KILL_PRIV = 1 << 14;
export const FUSE_SET_ATTR_OPEN = 1 << 15;
export const FUSE_SET_ATTR_TIMES_SET = 1 << 16;
export const FUSE_SET_ATTR_TOUCH = 1 << 17;
export const FUSE_SET_ATTR_CRTIME = 1 << 28;
export const FUSE_SET_ATTR_BTIME = 1 << 28;
export const FUSE_SET_ATTR_CHGTIME = 1 << 29;
export const FUSE_SET_ATTR_BKUPTIME = 1 << 30;
export const FUSE_SET_ATTR_FLAGS = 0x80000000;

export const FUSE_SET_ATTR_METADATA_KNOWN_MASK = FUSE_SET_ATTR_MODE |
  FUSE_SET_ATTR_UID |
  FUSE_SET_ATTR_GID |
  FUSE_SET_ATTR_ATIME |
  FUSE_SET_ATTR_MTIME |
  FUSE_SET_ATTR_ATIME_NOW |
  FUSE_SET_ATTR_MTIME_NOW |
  FUSE_SET_ATTR_FORCE |
  FUSE_SET_ATTR_CTIME |
  FUSE_SET_ATTR_KILL_SUID |
  FUSE_SET_ATTR_KILL_SGID |
  FUSE_SET_ATTR_FILE |
  FUSE_SET_ATTR_KILL_PRIV |
  FUSE_SET_ATTR_OPEN |
  FUSE_SET_ATTR_TIMES_SET |
  FUSE_SET_ATTR_TOUCH |
  FUSE_SET_ATTR_CRTIME |
  FUSE_SET_ATTR_CHGTIME |
  FUSE_SET_ATTR_BKUPTIME |
  FUSE_SET_ATTR_FLAGS;

//
// File mode constants
//

export const S_IFDIR = 0o40000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IRWXU = 0o700;
export const S_IRWXG = 0o070;
export const S_IRWXO = 0o007;

// Common modes
export const DIR_MODE = S_IFDIR | 0o555;
export const DIR_MODE_RW = S_IFDIR | 0o777;
export const FILE_MODE = S_IFREG | 0o444;
export const FILE_MODE_RW = S_IFREG | 0o666;
export const FILE_MODE_RX = S_IFREG | 0o555;
export const FILE_MODE_RWX = S_IFREG | 0o777;
export const FILE_MODE_WO = S_IFREG | 0o222;
export const SYMLINK_MODE = S_IFLNK | 0o777;

//
// Shared utility
//

export function readCString(ptr: Deno.PointerValue): string {
  if (!ptr) return "";
  const view = new Deno.UnsafePointerView(ptr);
  return view.getCString();
}

//
// Shared struct helpers
//

/**
 * Build a writeEntryParam function using the given platform's writeStat and STAT_SIZE.
 * Called by each platform module to avoid duplicating the entry_param layout logic
 * (which is the same on both platforms — only the embedded stat layout differs).
 */
export function makeWriteEntryParam(
  writeStat: (buf: ArrayBuffer, opts: StatOpts) => void,
  statSize: number,
  entryParamSize: number,
) {
  return function writeEntryParam(
    buf: ArrayBuffer,
    opts: EntryParamOpts,
  ): void {
    const view = new DataView(buf);
    new Uint8Array(buf).fill(0);

    // fuse_entry_param layout (same on both platforms):
    //   ino_t ino          @ 0   (u64)
    //   u64 generation     @ 8   (u64)
    //   struct stat attr   @ 16  (STAT_SIZE bytes)
    //   double attr_timeout  @ 16 + STAT_SIZE
    //   double entry_timeout @ 16 + STAT_SIZE + 8
    view.setBigUint64(0, opts.ino, true);
    view.setBigUint64(8, opts.generation ?? 0n, true);

    const statBuf = new ArrayBuffer(statSize);
    writeStat(statBuf, opts.attr);
    new Uint8Array(buf, 16, statSize).set(new Uint8Array(statBuf));

    const timeoutBase = 16 + statSize;
    view.setFloat64(timeoutBase, opts.attrTimeout ?? 1.0, true);
    view.setFloat64(timeoutBase + 8, opts.entryTimeout ?? 1.0, true);

    // Sanity: ensure we haven't overflowed
    if (timeoutBase + 16 > entryParamSize) {
      throw new Error(
        `writeEntryParam: timeouts overflow entry_param (${
          timeoutBase + 16
        } > ${entryParamSize})`,
      );
    }
  };
}

/**
 * Build a createFuseArgs function. The fuse_args struct layout is the same on
 * both platforms: { int argc; char **argv; int allocated; } with natural
 * alignment padding on 64-bit (total 24 bytes).
 */
export function createFuseArgs(
  args: string[],
  argsStructSize: number,
): {
  argsBuf: ArrayBuffer;
  argv: Deno.PointerValue;
  argvBuf: BigUint64Array;
  encodedArgs: Uint8Array[];
} {
  const encoder = new TextEncoder();
  const encodedArgs = args.map((a) => encoder.encode(a + "\0"));

  const argvBuf = new BigUint64Array(args.length);
  for (let i = 0; i < encodedArgs.length; i++) {
    argvBuf[i] = BigInt(
      Deno.UnsafePointer.value(Deno.UnsafePointer.of(encodedArgs[i])),
    );
  }

  const argv = Deno.UnsafePointer.of(argvBuf);

  const argsBuf = new ArrayBuffer(argsStructSize);
  const view = new DataView(argsBuf);
  view.setInt32(0, args.length, true); // argc
  view.setBigUint64(8, BigInt(Deno.UnsafePointer.value(argv)), true); // argv
  view.setInt32(16, 0, true); // allocated

  return { argsBuf, argv, argvBuf, encodedArgs };
}

//
// Platform dispatcher
//

let _platform: FusePlatform | null = null;

export async function getPlatform(): Promise<FusePlatform> {
  if (_platform) return _platform;
  if (Deno.build.os === "darwin") {
    // The Darwin bindings cannot load anywhere else.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const mod = await import("./platform-darwin.ts");
    _platform = mod.default;
    return _platform;
  }
  if (Deno.build.os === "linux") {
    // The Linux bindings cannot load anywhere else.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const mod = await import("./platform-linux.ts");
    _platform = mod.default;
    return _platform;
  }
  throw new Error(`Unsupported platform: ${Deno.build.os}`);
}
