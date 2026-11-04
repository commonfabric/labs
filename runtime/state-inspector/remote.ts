// Remote space-DB acquisition for `cf inspect --remote`.
//
// Downloads read-only SQLite snapshots from a toolshed dump endpoint
// (`/api/storage/memory/dump`) into a local cache, then hands the cached path to
// the ordinary offline inspector. The autopsy itself stays 100% offline — this
// is just the acquisition step that replaces "ssh in and scp the .sqlite".
//
// Dep-light by design: state-inspector deliberately avoids the runner/identity
// dependencies, so the caller injects a `signRequest` callback that applies CF1
// first-party auth headers (the CLI wires this to its loaded identity).

const DUMP_PATH = "/api/storage/memory/dump";

export interface RemoteSpace {
  /** Canonical space DID. */
  space: string;

  sizeBytes: number;
  mtimeMs: number;
}

/** Produce auth headers for an outgoing request (e.g. CF1 first-party auth). */
export type RequestSigner = (input: {
  url: string;
  method: string;
}) => Promise<HeadersInit> | HeadersInit;

export interface RemoteOptions {
  sign?: RequestSigner;
  cacheDir?: string;
}

export interface FetchOptions extends RemoteOptions {
  /** Re-download even when a cached copy already exists. */
  force?: boolean;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function hostSlug(baseUrl: string): string {
  let raw = baseUrl;
  try {
    raw = new URL(baseUrl).host;
  } catch { /* fall back to the raw string */ }
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Default cache dir for a remote, namespaced by host so hosts never collide. */
export function defaultCacheDir(baseUrl: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.cache/cf-inspect/${hostSlug(baseUrl)}`;
}

/** Root cache dir (all hosts) — added to local discovery so pulls are visible. */
export function rootCacheDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return `${home}/.cache/cf-inspect`;
}

async function authHeaders(
  url: string,
  method: string,
  sign?: RequestSigner,
): Promise<Headers> {
  const headers = new Headers();
  if (sign) {
    new Headers(await sign({ url, method })).forEach((v, k) =>
      headers.set(k, v)
    );
  }
  return headers;
}

async function describeError(res: Response, baseUrl: string): Promise<string> {
  let detail = "";
  try {
    const body = await res.json() as { error?: string };
    if (body?.error) detail = `: ${body.error}`;
  } catch { /* non-JSON body */ }
  if (res.status === 401) {
    return `${baseUrl}: unauthorized (401)${detail} — set CF_IDENTITY to a signing key`;
  }
  if (res.status === 403) {
    return `${baseUrl}: forbidden (403)${detail} — your DID is not on the dump allowlist`;
  }
  if (res.status === 404) {
    return `${baseUrl}: not found (404)${detail} — dump endpoint disabled or unknown space`;
  }
  return `${baseUrl}: request failed (${res.status} ${res.statusText})${detail}`;
}

/** List the spaces a remote toolshed will dump. */
export async function listRemoteSpaces(
  baseUrl: string,
  opts: RemoteOptions = {},
): Promise<RemoteSpace[]> {
  const url = `${trimBase(baseUrl)}${DUMP_PATH}`;
  const res = await fetch(url, {
    headers: await authHeaders(url, "GET", opts.sign),
  });
  if (!res.ok) throw new Error(await describeError(res, baseUrl));
  const body = await res.json() as { spaces?: RemoteSpace[] };
  return body.spaces ?? [];
}

/**
 * Download a space's SQLite snapshot into the cache and return its local path.
 * Cached by default; pass `force` to re-download. Streams to a temp file and
 * atomically renames, so an interrupted download never leaves a torn DB.
 */
export async function fetchSpaceDb(
  space: string,
  baseUrl: string,
  opts: FetchOptions = {},
): Promise<string> {
  // Reject ids that can't be a safe single filename (DIDs never contain these).
  if (space.includes("/") || space.includes("\\") || space.includes("\0")) {
    throw new Error(`invalid space id for cache filename: ${space}`);
  }
  const cacheDir = opts.cacheDir ?? defaultCacheDir(baseUrl);
  await Deno.mkdir(cacheDir, { recursive: true });
  // Cache with the LITERAL did filename — same convention the server/local
  // store uses (`did:key:….sqlite`), so local discovery reports the real DID
  // and `inspect <full-did>` resolves a pulled DB. (URL path segments below are
  // still percent-encoded; only the on-disk filename is literal.)
  const dest = `${cacheDir}/${space}.sqlite`;

  if (!opts.force) {
    try {
      if ((await Deno.stat(dest)).isFile) return dest;
    } catch { /* not cached yet */ }
  }

  const url = `${trimBase(baseUrl)}${DUMP_PATH}/${encodeURIComponent(space)}`;
  const res = await fetch(url, {
    headers: await authHeaders(url, "GET", opts.sign),
  });
  if (!res.ok || !res.body) throw new Error(await describeError(res, baseUrl));

  const tmp = `${dest}.partial-${crypto.randomUUID()}`;
  try {
    const file = await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
    });
    await res.body.pipeTo(file.writable); // closes the file on completion
    await Deno.rename(tmp, dest);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
  return dest;
}
