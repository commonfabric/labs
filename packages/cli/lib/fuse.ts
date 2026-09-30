import { encodeHex } from "@std/encoding/hex";
import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { cliName } from "./cli-name.ts";
import {
  type FuseMountFlags,
  type FuseSupervisorFlags,
  mountFlagArgs,
  supervisorFlagArgs,
} from "./fuse-mount-flags.ts";

export interface MountStateEntry {
  pid: number;
  childPid?: number;
  childStatusPath?: string;
  mountpoint: string;
  apiUrl: string;
  identity: string;
  startedAt: string;
  logFile?: string;
}

export interface FuseChildDenoArgsOptions extends FuseMountFlags {
  modPath: string;
}

export interface BackgroundSupervisorDenoArgsOptions
  extends FuseSupervisorFlags {
  cliModPath: string;
}

export interface FuseBinaryArgsOptions extends FuseSupervisorFlags {
  subcommand: "fuse-daemon" | "fuse-supervisor";
}

export async function canonicalizeMountLookupPath(
  path: string,
): Promise<string> {
  const resolved = resolve(path);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const real = await Deno.realPath(probe);
      return suffix.length === 0 ? real : join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}

function normalizeMountStateEntry(entry: MountStateEntry): MountStateEntry {
  return {
    ...entry,
    mountpoint: resolve(entry.mountpoint),
    identity: entry.identity
      ? (isAbsolute(entry.identity) ? entry.identity : resolve(entry.identity))
      : "",
  };
}

function isMountStateEntry(value: unknown): value is MountStateEntry {
  if (!isObjectOrArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.pid === "number" &&
    typeof entry.mountpoint === "string" &&
    typeof entry.apiUrl === "string" &&
    typeof entry.identity === "string" &&
    typeof entry.startedAt === "string" &&
    (entry.childPid === undefined || typeof entry.childPid === "number") &&
    (entry.childStatusPath === undefined ||
      typeof entry.childStatusPath === "string") &&
    (entry.logFile === undefined || typeof entry.logFile === "string");
}

function isWithinMountpoint(path: string, mountpoint: string): boolean {
  return path === mountpoint || path.startsWith(`${mountpoint}${SEPARATOR}`);
}

function cliMod(importMetaUrl: string): string {
  const cliLibDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliLibDir, "../mod.ts");
}

function repoRoot(importMetaUrl: string): string {
  const cliLibDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliLibDir, "../../..");
}

function isFsWriteError(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    error instanceof Deno.errors.NotSupported;
}

function isCompiledBinary(): boolean {
  const exec = Deno.execPath();
  const base = basename(exec);
  return base !== "deno" && base !== "deno.exe";
}

async function hashMountLookupKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash)).slice(0, 16);
}

async function legacyMountpointHash(mountpoint: string): Promise<string> {
  return await hashMountLookupKey(resolve(mountpoint));
}

/** Hex hash of absolute mountpoint path, used as state filename. */
export async function mountpointHash(mountpoint: string): Promise<string> {
  return await hashMountLookupKey(
    await canonicalizeMountLookupPath(mountpoint),
  );
}

/**
 * Creates the state directory, drops any state file left at the mountpoint's
 * previous hash, and returns the path this mountpoint's state file belongs at.
 * Callers that hold write access to the directory run this before a writer that
 * only holds write access to the single file.
 */
export async function prepareMountStatePath(
  stateDir: string,
  mountpoint: string,
): Promise<string> {
  await Deno.mkdir(stateDir, { recursive: true });
  const hash = await mountpointHash(mountpoint);
  const legacyHash = await legacyMountpointHash(mountpoint);
  if (legacyHash !== hash) {
    await Deno.remove(resolve(stateDir, `${legacyHash}.json`)).catch(() =>
      undefined
    );
  }
  return resolve(stateDir, `${hash}.json`);
}

/** Writes an entry to an already-prepared state file path. */
export async function writeMountStateFile(
  path: string,
  entry: MountStateEntry,
): Promise<void> {
  await Deno.writeTextFile(
    path,
    JSON.stringify(normalizeMountStateEntry(entry), null, 2),
  );
}

export async function writeMountState(
  stateDir: string,
  entry: MountStateEntry,
): Promise<string> {
  const normalized = normalizeMountStateEntry(entry);
  const path = await prepareMountStatePath(stateDir, normalized.mountpoint);
  await writeMountStateFile(path, normalized);
  return path;
}

export async function readMountState(
  stateDir: string,
  mountpoint: string,
): Promise<{ entry: MountStateEntry; path: string } | null> {
  const candidatePaths = [
    resolve(stateDir, `${await mountpointHash(mountpoint)}.json`),
  ];
  const legacyPath = resolve(
    stateDir,
    `${await legacyMountpointHash(mountpoint)}.json`,
  );
  if (!candidatePaths.includes(legacyPath)) {
    candidatePaths.push(legacyPath);
  }

  const matches: { entry: MountStateEntry; path: string }[] = [];
  for (const path of candidatePaths) {
    try {
      const text = await Deno.readTextFile(path);
      const parsed = JSON.parse(text) as unknown;
      if (!isMountStateEntry(parsed)) continue;
      matches.push({
        entry: normalizeMountStateEntry(parsed),
        path,
      });
    } catch {
      // Try the next compatible state filename.
    }
  }

  return matches.find(({ entry }) => isMountStateAlive(entry)) ?? matches[0] ??
    null;
}

export async function readAllMountStates(
  stateDir: string,
): Promise<{ entry: MountStateEntry; path: string }[]> {
  const results: { entry: MountStateEntry; path: string }[] = [];
  try {
    for await (const file of Deno.readDir(stateDir)) {
      if (
        !file.isFile || !file.name.endsWith(".json") ||
        file.name.endsWith(".child-status.json")
      ) continue;
      const path = resolve(stateDir, file.name);
      try {
        const text = await Deno.readTextFile(path);
        const parsed = JSON.parse(text) as unknown;
        if (!isMountStateEntry(parsed)) continue;
        results.push({
          entry: normalizeMountStateEntry(parsed),
          path,
        });
      } catch {
        // Skip corrupt entries.
      }
    }
  } catch {
    // State dir does not exist yet.
  }
  return results;
}

export async function findMountForPath(
  absPath: string,
  stateDir = defaultStateDir(),
): Promise<{ entry: MountStateEntry; path: string } | null> {
  const normalizedPath = await canonicalizeMountLookupPath(absPath);
  const entries = await readAllMountStates(stateDir);

  let bestMatch: { entry: MountStateEntry; path: string } | null = null;
  let bestMatchMountpoint: string | null = null;
  for (const candidate of entries) {
    if (!isMountStateAlive(candidate.entry)) {
      try {
        await Deno.remove(candidate.path);
      } catch {
        // Ignore cleanup failures.
      }
      continue;
    }

    const candidateMountpoint = await canonicalizeMountLookupPath(
      candidate.entry.mountpoint,
    );
    if (!isWithinMountpoint(normalizedPath, candidateMountpoint)) {
      continue;
    }

    if (
      !bestMatch ||
      candidateMountpoint.length > (bestMatchMountpoint?.length ?? -1)
    ) {
      bestMatch = candidate;
      bestMatchMountpoint = candidateMountpoint;
    }
  }

  return bestMatch;
}

export function removeMountStateFile(path: string): Promise<void> {
  return Deno.remove(path).catch(() => undefined);
}

export function isAlive(pid: number): boolean {
  try {
    // SIGURG is benign (no default handler) — unlike SIGCONT which resumes
    // stopped processes. We just need to check if the process exists.
    Deno.kill(pid, "SIGURG");
    return true;
  } catch {
    return false;
  }
}

export function isMountStateAlive(entry: MountStateEntry): boolean {
  return isAlive(entry.pid) ||
    (entry.childPid !== undefined && isAlive(entry.childPid));
}

/** Whether the OS mount table lists a mountpoint. */
export type MountTableState = "present" | "absent" | "unknown";

/**
 * Whether this OS reads the mount table via the macOS `getfsstat` FFI below.
 * darwin ONLY: the struct offsets here are Apple's `struct statfs` layout; the
 * BSDs export a `getfsstat` too but with a different struct, so they must not
 * take this path (they fall through to the `/proc/mounts` attempt → "unknown").
 */
function usesGetfsstat(os: string): boolean {
  return os === "darwin";
}

// struct statfs (64-bit inode) fields we read. getfsstat with MNT_NOWAIT reads
// the CACHED kernel mount table and never stats or contacts a backend, so it
// cannot block on a stale/wedged FUSE-T/NFS mount — no subprocess, no timeout.
const MNT_NOWAIT = 2;
// Exported for tests: the pure `parseStatfsMountpoints` parse loop can then be
// exercised with a hand-built buffer on any OS, without the darwin-only syscall.
export const STATFS_SIZE = 2168;
export const F_MNTONNAME_OFF = 88;
const F_MNTONNAME_LEN = 1024;

/**
 * Opens libSystem's getfsstat, selecting the symbol by ARCHITECTURE — never by
 * try-both, which is ABI-unsafe. On x86_64 the plain `getfsstat` symbol is the
 * LEGACY 32-bit-inode call whose struct differs from the 2168-byte layout we
 * parse, so we require `getfsstat$INODE64` there and never fall back to it. On
 * arm64 there is only one `getfsstat` (already the 64-bit-inode variant; the
 * `$INODE64` alias is not a dlsym symbol). Returns null if unavailable, so the
 * caller reports "unknown".
 */
function openGetfsstat():
  | {
    fn: (b: Deno.PointerValue, n: number, f: number) => number;
    close: () => void;
  }
  | null {
  const name = Deno.build.arch === "aarch64"
    ? "getfsstat"
    : "getfsstat$INODE64";
  try {
    const lib = Deno.dlopen("libSystem.B.dylib", {
      [name]: { parameters: ["pointer", "i32", "i32"], result: "i32" },
    });
    return {
      fn: lib.symbols[name] as (
        b: Deno.PointerValue,
        n: number,
        f: number,
      ) => number,
      close: () => lib.close(),
    };
  } catch {
    return null;
  }
}

/**
 * The libc getfsstat signature we depend on. Injectable so the error-mapping
 * path (native failure → null) is testable without a real syscall.
 */
export type GetfsstatFn = (
  buf: Deno.PointerValue,
  bytes: number,
  flags: number,
) => number;

/**
 * Reads the darwin kernel mount table via getfsstat(MNT_NOWAIT) and returns the
 * canonical f_mntonname of every mount. Returns null (→ caller reports
 * "unknown") if FFI is unavailable or the call fails — never a partial or empty
 * list masquerading as "no mounts" on error.
 */
export function readDarwinMountpoints(call?: GetfsstatFn): string[] | null {
  let fn = call;
  let close = () => {};
  if (!fn) {
    const g = openGetfsstat();
    if (!g) return null;
    fn = g.fn;
    close = g.close;
  }
  try {
    // getfsstat returns -1 on error. Map ANY negative to null → "unknown";
    // never to [] (which would read as "absent" and hide a real mount).
    const count = fn(null, 0, MNT_NOWAIT);
    if (count < 0) return null;
    if (count === 0) return [];
    const bytes = count * STATFS_SIZE;
    const buf = new Uint8Array(bytes);
    const n = fn(Deno.UnsafePointer.of(buf), bytes, MNT_NOWAIT);
    if (n < 0) return null;
    return parseStatfsMountpoints(buf, n);
  } catch {
    return null;
  } finally {
    close();
  }
}

/**
 * Parse the `f_mntonname` (canonical mountpoint) field out of each `struct
 * statfs` record packed into a getfsstat buffer. Pure and OS-independent: the
 * caller supplies the raw bytes and record count, so this FFI-free parse loop
 * is unit-testable on any platform — linux CI never runs the darwin syscall
 * that fills the buffer, but it can hand-build one and exercise this loop.
 */
export function parseStatfsMountpoints(
  buf: Uint8Array,
  count: number,
): string[] {
  const dec = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * STATFS_SIZE + F_MNTONNAME_OFF;
    const slice = buf.subarray(base, base + F_MNTONNAME_LEN);
    let end = slice.indexOf(0);
    if (end < 0) end = F_MNTONNAME_LEN;
    out.push(dec.decode(slice.subarray(0, end)));
  }
  return out;
}

/**
 * Decode the fstab octal escapes `/proc/mounts` uses for whitespace and
 * backslash in mountpoint fields: `\040`→space, `\011`→tab, `\012`→newline,
 * `\134`→backslash. Without this, a mountpoint containing a space is stored as
 * `/tmp/a\040b` and would never match the real candidate `/tmp/a b`, making a
 * live mount look "absent" — a dangerous false negative.
 */
function decodeProcMountsField(field: string): string {
  return field.replace(
    /\\([0-7]{3})/g,
    (_match, oct: string) => String.fromCharCode(parseInt(oct, 8)),
  );
}

/**
 * Canonicalize only the PARENT directory of the mountpoint and re-append the
 * basename. We never realPath the mountpoint leaf itself: resolving through a
 * wedged/stale FUSE-T or NFS mount root can block indefinitely, and the kernel
 * mount table records the mountpoint under its parent-resolved path anyway.
 *
 * Known false-negative: the leaf is DELIBERATELY not realPath'd for hang-safety,
 * so if the mountpoint's final component is itself a symlink, the kernel records
 * the mount under the symlink TARGET while these candidates carry the link path,
 * and the table lookup misses it. Realpathing the leaf to fix it reintroduces
 * the hang we removed; the correct fix normalizes the symlink at MOUNT time so
 * the recorded path and our candidates agree. Tracked in CT-1913.
 */
async function parentCanonicalizedMountpoint(
  mountpoint: string,
): Promise<string> {
  const resolved = resolve(mountpoint);
  const parent = dirname(resolved);
  try {
    const realParent = await Deno.realPath(parent);
    return join(realParent, basename(resolved));
  } catch {
    return resolved;
  }
}

async function mountpointMatchCandidates(
  mountpoint: string,
): Promise<string[]> {
  const resolved = resolve(mountpoint);
  const canonical = await parentCanonicalizedMountpoint(mountpoint);
  return canonical === resolved ? [resolved] : [resolved, canonical];
}

/**
 * Consults the OS mount table — the kernel's own ground truth of what is
 * mounted — rather than process existence. A wedged daemon still answers
 * `isAlive`'s SIGURG probe and its sidecar still says "mounted", so the mount
 * table is the only honest liveness signal for a severed mount.
 *
 * Hang-safety: on darwin this calls getfsstat(MNT_NOWAIT) over FFI; on linux
 * (and every other OS) it reads `/proc/mounts`. Both read the CACHED kernel
 * mount table only and never stat or contact the backend, so neither blocks on
 * a stale/wedged FUSE-T/NFS mount. The `mount(8)` subprocess was DELIBERATELY
 * removed: after getmntinfo it calls getattrlist() on every mountpoint — a
 * filesystem op on the stale leaf that can wedge in uninterruptible I/O, where
 * an AbortController (SIGTERM only) cannot rescue it. Do NOT swap in
 * `mount`/`df`/`ls`/`stat`/`getfsstat(MNT_WAIT)` — any of those can hang. The
 * mountpoint leaf is never realPath'd (only its parent is canonicalized), for
 * the same reason.
 *
 * Returns "present"/"absent" from the table, or "unknown" if the probe itself
 * is unavailable — never "absent" on error, which would be a false negative
 * that hides a real mount.
 */
export async function isMountpointInTable(
  mountpoint: string,
  deps: {
    os?: string;
    listDarwinMountpoints?: () => string[] | null;
    readProcMounts?: () => Promise<string>;
  } = {},
): Promise<MountTableState> {
  const os = deps.os ?? Deno.build.os;
  const candidates = await mountpointMatchCandidates(mountpoint);

  if (usesGetfsstat(os)) {
    const lister = deps.listDarwinMountpoints ?? readDarwinMountpoints;
    const mountpoints = lister();
    // null means the probe could not run (FFI unavailable / call failed). We
    // never downgrade that to "absent" — an unreadable table is "unknown".
    if (mountpoints === null) return "unknown";
    for (const candidate of candidates) {
      // f_mntonname is the canonical kernel path, so an exact compare suffices.
      if (mountpoints.includes(candidate)) return "present";
    }
    return "absent";
  }

  // linux (and any other OS): the virtual /proc/mounts file is non-blocking.
  let text: string;
  try {
    text = deps.readProcMounts
      ? await deps.readProcMounts()
      : await Deno.readTextFile("/proc/mounts");
  } catch {
    return "unknown";
  }
  for (const line of text.split("\n")) {
    const fields = line.split(/\s+/).filter((field) => field.length > 0);
    // The 2nd field is the mountpoint; decode its fstab octal escapes before
    // comparing so a space/tab in the path is not a false "absent".
    if (
      fields.length >= 2 &&
      candidates.includes(decodeProcMountsField(fields[1]))
    ) {
      return "present";
    }
  }
  return "absent";
}

/** Default state directory for FUSE mount state. */
export function defaultStateDir(): string {
  return resolve(Deno.env.get("HOME") ?? "/tmp", ".cf", "fuse");
}

/** Resolve path to packages/fuse/mod.ts relative to the CLI commands dir. */
export function fuseMod(importMetaUrl: string): string {
  const cliCommandsDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliCommandsDir, "../../fuse/mod.ts");
}

/** Resolve path to the minimal FUSE supervisor entrypoint. */
export function fuseSupervisorMod(importMetaUrl: string): string {
  const cliCommandsDir = dirname(fromFileUrl(importMetaUrl));
  return resolve(cliCommandsDir, "../lib/fuse-supervisor.ts");
}

export async function ensureExecShim(
  stateDir = defaultStateDir(),
  importMetaUrl = import.meta.url,
): Promise<string> {
  await Deno.mkdir(stateDir, { recursive: true });

  const compiled = isCompiledBinary();
  const displayCliName = cliName();
  const stateScopedShimPath = join(
    stateDir,
    `cf-exec-${await hashMountLookupKey(
      compiled ? Deno.execPath() : cliMod(importMetaUrl),
    )}`,
  );
  const preferredShimPath = compiled
    ? stateScopedShimPath
    : join(repoRoot(importMetaUrl), ".cf", "fuse", "cf-exec");
  const fallbackShimPath = stateScopedShimPath;

  const script = compiled
    ? `#!/usr/bin/env bash
export CF_EXEC_SHEBANG=1
export CF_CLI_NAME=${displayCliName}
exec "${Deno.execPath()}" "$@"
`
    : `#!/usr/bin/env bash
export CF_EXEC_SHEBANG=1
export CF_CLI_NAME=${displayCliName}
exec "${Deno.execPath()}" run --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run "${
      cliMod(importMetaUrl)
    }" "$@"
`;

  const writeShim = async (shimPath: string): Promise<void> => {
    await Deno.mkdir(dirname(shimPath), { recursive: true });
    await Deno.writeTextFile(shimPath, script);
    await Deno.chmod(shimPath, 0o755);
  };

  try {
    await writeShim(preferredShimPath);
    return preferredShimPath;
  } catch (error) {
    if (!isFsWriteError(error) || compiled) {
      throw error;
    }
    await writeShim(fallbackShimPath);
    return fallbackShimPath;
  }
}

/** Build the deno subprocess args for running the FUSE module. */
export function buildFuseChildDenoArgs(
  opts: FuseChildDenoArgsOptions,
): string[] {
  return [
    "run",
    "--unstable-ffi",
    "--allow-ffi",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-net",
    opts.modPath,
    opts.mountpoint,
    ...mountFlagArgs(opts),
  ];
}

/**
 * Build the args for the compiled cf binary's direct FUSE entry points. The
 * compiled binary takes the mountpoint and mount flags directly, where a
 * deno invocation needs a script path and permission flags first. Only the
 * supervisor entry point takes the mount state file; the daemon never sees it.
 */
export function buildFuseBinaryArgs(opts: FuseBinaryArgsOptions): string[] {
  return [
    opts.subcommand,
    opts.mountpoint,
    ...(opts.subcommand === "fuse-supervisor"
      ? supervisorFlagArgs(opts)
      : mountFlagArgs(opts)),
  ];
}

/** Build the deno subprocess args for running the non-FFI FUSE supervisor. */
export function buildBackgroundSupervisorDenoArgs(
  opts: BackgroundSupervisorDenoArgsOptions,
): string[] {
  const permissions = ["--allow-run"];
  if (opts.statePath) permissions.push(`--allow-write=${opts.statePath}`);

  return [
    "run",
    ...permissions,
    opts.cliModPath,
    opts.mountpoint,
    ...supervisorFlagArgs(opts),
  ];
}
