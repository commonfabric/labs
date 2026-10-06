/**
 * Where the shell's worker opens Memory: the memory URL of a deployment that
 * puts a memory router in front of its toolsheds, or none, which leaves
 * Memory on the API URL. Everything else stays on the API URL.
 */

import {
  type DeploymentMemoryUrl,
  MEMORY_URL_META_NAME,
  memoryUrlForDeployment,
} from "@commonfabric/runner/deployment-meta";
import { readMemoryUrl } from "@commonfabric/runner/space-host";

/**
 * What the page says about the memory URL.
 *
 * - `page`: the page states it. `memoryUrl` is what its element names, and
 *   `undefined` for an empty element, which is a deployment without a memory
 *   router.
 * - `deployment`: the page does not state it, and the shell reads the API
 *   URL's meta document instead.
 */
export type PageMemoryUrl =
  | { from: "page"; memoryUrl: URL | undefined }
  | { from: "deployment" };

/**
 * Reads the memory URL from the `<meta>` element a compiled toolshed puts in
 * the page it serves (`MEMORY_URL_META_NAME`).
 *
 * The element is taken only from a page served from the API URL's own
 * origin: it describes the deployment that served the page, and a page
 * served from elsewhere, such as a CDN copy with a built-in API URL, is not
 * that deployment. A page without the element (a CDN copy, or a development
 * shell that no compiled toolshed served) states nothing either. Nor does an
 * element whose value is not an HTTP or HTTPS origin: that is logged, and the
 * shell reads the deployment's meta document rather than failing its boot. A
 * toolshed refuses to start with such a value, so only a page it did not
 * write can carry one.
 */
export function memoryUrlFromPage(
  page: Pick<ParentNode, "querySelector"> | undefined,
  apiUrl: URL,
  pageOrigin: string | undefined,
): PageMemoryUrl {
  if (pageOrigin !== apiUrl.origin) return { from: "deployment" };
  const value = page?.querySelector?.(`meta[name="${MEMORY_URL_META_NAME}"]`)
    ?.getAttribute("content");
  if (value === null || value === undefined) return { from: "deployment" };
  const read = readMemoryUrl(value, apiUrl);
  if ("refused" in read) {
    console.error(
      `[shell] Ignoring the page's memory URL ${JSON.stringify(value)} ` +
        `(${read.refused}); reading the memory URL from ${apiUrl.origin} ` +
        `instead`,
    );
    return { from: "deployment" };
  }
  return { from: "page", memoryUrl: read.memoryUrl };
}

/**
 * The memory URL for a shell at `pageOrigin` whose API URL is `apiUrl`: the
 * page's where it states one ({@link memoryUrlFromPage}), which is not
 * transient, and otherwise the `memoryUrl` the API URL's meta document
 * publishes. That read retries a document it could not read for a transient
 * reason, and then warns and leaves Memory on `apiUrl`
 * (`memoryUrlForDeployment`).
 */
export function resolveMemoryUrl(
  page: Pick<ParentNode, "querySelector"> | undefined,
  apiUrl: URL,
  pageOrigin: string | undefined,
  fetch?: typeof globalThis.fetch,
): Promise<DeploymentMemoryUrl> {
  const fromPage = memoryUrlFromPage(page, apiUrl, pageOrigin);
  if (fromPage.from === "page") {
    return Promise.resolve({ memoryUrl: fromPage.memoryUrl, transient: false });
  }
  return memoryUrlForDeployment({
    apiUrl,
    ...(fetch !== undefined ? { fetch } : {}),
  });
}

/** The memory URL as the shell takes it: read early, used per runtime. */
export interface ShellMemoryUrl {
  /** Starts a read if none is held, without using its result. */
  prefetch(): void;

  /** The memory URL for one runtime the page creates. */
  get(): Promise<URL | undefined>;
}

/**
 * How long after it failed a read that failed for a transient reason may
 * still serve the first `get` that uses it. A page whose user takes longer
 * than this to sign in reads again for its first runtime rather than open
 * Memory on a failure from when the page loaded.
 */
const TRANSIENT_FAILURE_SERVES_MS = 10_000;

/** One read {@link holdMemoryUrl} holds. */
interface HeldRead {
  result: Promise<DeploymentMemoryUrl>;
  /** When the read settled with a transient failure; unset otherwise. */
  failedAt?: number;
}

/**
 * Holds the memory URL `read` gives. A read started by `prefetch` or by `get`
 * is held until a `get` has used it, so a read the page starts at load serves
 * its first runtime and is not repeated for it.
 *
 * A result that is not transient stays held for the page's lifetime, so
 * `read` is not called again: a memory URL the deployment published or said
 * it has none of, and a failure that would most likely come out the same,
 * which then warns once rather than at every runtime the page creates. A
 * transient failure goes to the `get` calls that awaited it and is then
 * dropped, so the next `get` reads again. It goes to a later `get` only
 * within {@link TRANSIENT_FAILURE_SERVES_MS} of failing; after that, that
 * `get` reads again.
 */
export function holdMemoryUrl(
  read: () => Promise<DeploymentMemoryUrl>,
  /** @internal Seam for tests: a clock in milliseconds. */
  now: () => number = () => performance.now(),
): ShellMemoryUrl {
  let held: HeldRead | undefined;
  const start = (): HeldRead => {
    if (held !== undefined) return held;
    const entry: HeldRead = { result: read() };
    // Registered before any `get` awaits the result, so the time is set
    // before a `get` resumes. The rejection is the awaiting `get`'s to
    // report.
    entry.result.then(
      ({ transient }) => {
        if (transient) entry.failedAt = now();
      },
      () => {},
    );
    return held = entry;
  };
  return {
    prefetch: () => void start(),
    get: async () => {
      if (
        held?.failedAt !== undefined &&
        now() - held.failedAt >= TRANSIENT_FAILURE_SERVES_MS
      ) {
        held = undefined;
      }
      const current = start();
      const { memoryUrl, transient } = await current.result;
      // A `get` that found this read stale has already replaced it with a
      // newer one, which this must not drop.
      if (transient && held === current) held = undefined;
      return memoryUrl;
    },
  };
}
