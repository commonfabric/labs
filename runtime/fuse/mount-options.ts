// mount-options.ts — mount-argv construction and option validation shared
// by the FUSE daemon and the CLI mount command. Kept free of runtime
// imports so the CLI can validate options without loading the daemon
// module.

import type { FuseProvider } from "./platform.ts";

/**
 * Lowest `--attrcache-timeout` accepted: zero, which leaves the NFS client's
 * default caching untouched.
 */
export const ATTRCACHE_TIMEOUT_MIN_SECONDS = 0;

/** Highest `--attrcache-timeout` accepted: one day. */
export const ATTRCACHE_TIMEOUT_MAX_SECONDS = 86_400;

/**
 * The attrcache-timeout applied to FUSE-T mounts when neither cache flag is
 * given. The macOS NFS client's default attribute caching serves a stale
 * NotFound for up to a minute after a daemon-side ENOENT and serves stale
 * directory listings for seconds; a one-second bound removes both windows
 * while keeping reads within the window served from cache.
 */
export const DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS = 1;

/**
 * Parse the --attrcache-timeout value: a whole number of seconds. Zero
 * means no cache tuning (the NFS client keeps its age-based 5-60 second
 * defaults). Returns undefined for an empty value. The upper bound keeps
 * the value inside the integer range FUSE-T's attrcache-timeout=%d option
 * parse accepts.
 */
export function parseAttrcacheTimeoutSeconds(
  value: string,
): number | undefined {
  if (value === "") return undefined;
  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < ATTRCACHE_TIMEOUT_MIN_SECONDS ||
    seconds > ATTRCACHE_TIMEOUT_MAX_SECONDS
  ) {
    throw new Error(
      `Invalid --attrcache-timeout value: ${value} (expected a whole number of seconds between ${ATTRCACHE_TIMEOUT_MIN_SECONDS} and ${ATTRCACHE_TIMEOUT_MAX_SECONDS}; 0 means no cache tuning)`,
    );
  }
  return seconds;
}

/** The cache mount options a mount request resolves to. */
export interface MountCacheOptions {
  noattrcache: boolean;
  attrcacheTimeoutSeconds?: number;
}

/**
 * Resolve the cache options from their raw command-line spellings, rejecting
 * an out-of-range timeout or the mutually exclusive combination. Throws an
 * Error whose message names the offending flags.
 *
 * `attrcacheTimeoutGiven` reports whether the flag appeared in argv at all.
 * The daemon's argument parser does not read a leading-dash token as an
 * option value, so `--attrcache-timeout -1` parses as no value; the flag
 * present with no value is rejected.
 */
export function resolveMountCacheOptions(
  args: {
    noattrcache: boolean;
    attrcacheTimeout: string;
    attrcacheTimeoutGiven?: boolean;
  },
): MountCacheOptions {
  if (args.attrcacheTimeoutGiven && args.attrcacheTimeout === "") {
    throw new Error(
      `Missing value for --attrcache-timeout (expected a whole number of seconds between ${ATTRCACHE_TIMEOUT_MIN_SECONDS} and ${ATTRCACHE_TIMEOUT_MAX_SECONDS}; write a value that starts with "-" as --attrcache-timeout=<value>)`,
    );
  }
  const attrcacheTimeoutSeconds = parseAttrcacheTimeoutSeconds(
    args.attrcacheTimeout,
  );
  if (args.noattrcache && attrcacheTimeoutSeconds !== undefined) {
    throw new Error(
      "--noattrcache and --attrcache-timeout are mutually exclusive",
    );
  }
  return { noattrcache: args.noattrcache, attrcacheTimeoutSeconds };
}

/**
 * Build the argv handed to fuse_mount.
 *
 * allow_other and default_permissions are Linux mount options.
 *
 * noattrcache and attrcache-timeout are FUSE-T mount options controlling
 * the macOS NFS client's cache. Measured on FUSE-T 1.2.7: noattrcache
 * mounts with the NFS nonegnamecache option (negative name lookups are not
 * cached; positive attribute and directory caching keeps the age-based
 * 5-60 second defaults), and attrcache-timeout=N mounts with every
 * attribute-cache bound (the acreg and acdir minima and maxima) fixed at N
 * seconds, which caps how long stale attributes, negative name entries, and
 * directory listings are served. FUSE-T ignores the entry and attribute
 * timeouts the filesystem returns, and acts on neither notify_inval_entry
 * nor notify_inval_inode — the call has no effect whether it returns success
 * or an ENOTCONN error — so these mount options are the only cache controls
 * available on macOS.
 *
 * When neither flag is given, FUSE-T mounts default to attrcache-timeout=
 * DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS; an explicit value of 0 leaves
 * the NFS client defaults. macFUSE rejects both options, so the default
 * applies only when the loaded provider is FUSE-T.
 */
export function buildMountFuseArgs(opts: {
  os: string;
  provider: FuseProvider;
  allowOther: boolean;
  cfcWritebackXattrs: boolean;
  noattrcache: boolean;
  attrcacheTimeoutSeconds?: number;
}): string[] {
  const fuseArgs = ["fuse_ct"];
  if (opts.os === "linux" && opts.allowOther) {
    fuseArgs.push("-o", "allow_other");
    if (!opts.cfcWritebackXattrs) {
      fuseArgs.push("-o", "default_permissions");
    }
  }
  if (opts.os === "darwin" && opts.provider === "fuse-t") {
    if (opts.noattrcache) {
      fuseArgs.push("-o", "noattrcache");
    } else {
      const seconds = opts.attrcacheTimeoutSeconds ??
        DEFAULT_FUSE_T_ATTRCACHE_TIMEOUT_SECONDS;
      if (seconds !== 0) {
        fuseArgs.push("-o", `attrcache-timeout=${seconds}`);
      }
    }
  }
  return fuseArgs;
}
