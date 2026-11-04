/**
 * What the shell's worker takes from the deployment it runs against: where it
 * opens Memory, the memory URL of a deployment that puts a memory router in
 * front of its toolsheds, or none, which leaves Memory on the API URL; and the
 * experimental flags the deployment decides for the shell
 * (`SHELL_DEPLOYMENT_FLAGS`). Everything else stays on the API URL, and every
 * other flag is a build define.
 */

import {
  DEPLOYMENT_META_NAME,
  type DeploymentForShell,
  deploymentForShell,
  shellFlagsFromDeclared,
} from "@commonfabric/runner/deployment-meta";
import type { ExperimentalOptions } from "@commonfabric/runner";
import { readMemoryUrl } from "@commonfabric/runner/space-host";

/**
 * What the page says about the deployment.
 *
 * - `page`: the page states it. `memoryUrl` is what its element names, and
 *   `undefined` for a `null`, or a missing field, which is a deployment
 *   without a memory router. `experimental` holds the flags the element
 *   declares for the shell.
 * - `deployment`: the page does not state it, and the shell reads the API
 *   URL's meta document instead.
 */
export type DeploymentFromPage =
  | {
    from: "page";
    memoryUrl: URL | undefined;
    experimental: ExperimentalOptions;
  }
  | { from: "deployment" };

/**
 * Reads the deployment from the `<meta>` element a compiled toolshed puts in
 * the page it serves (`DEPLOYMENT_META_NAME`), whose content is the fields of
 * the deployment's meta document the shell reads, as JSON.
 *
 * The element is taken only from a page served from the API URL's own
 * origin: it describes the deployment that served the page, and a page
 * served from elsewhere, such as a CDN copy with a built-in API URL, is not
 * that deployment. A page without the element (a CDN copy, or a development
 * shell that no compiled toolshed served) states nothing either. Nor does an
 * element whose content is not a JSON object, or whose memory URL is not an
 * HTTP or HTTPS origin: that is logged, and the shell reads the deployment's
 * meta document rather than failing its boot. A toolshed writes the element
 * from values it validated, so only a page it did not write can carry such
 * content. The flags are read as the meta document's are: one declared with
 * something other than a boolean is dropped with a warning, and the shell's
 * default governs it.
 */
export function deploymentFromPage(
  page: Pick<ParentNode, "querySelector"> | undefined,
  apiUrl: URL,
  pageOrigin: string | undefined,
): DeploymentFromPage {
  if (pageOrigin !== apiUrl.origin) return { from: "deployment" };
  const content = page?.querySelector?.(`meta[name="${DEPLOYMENT_META_NAME}"]`)
    ?.getAttribute("content");
  if (content === null || content === undefined) return { from: "deployment" };
  const declared = parseObject(content);
  if (declared === undefined) {
    return ignoring(content, "not a JSON object", apiUrl);
  }
  const read = readMemoryUrl(declared.memoryUrl, apiUrl);
  if ("refused" in read) return ignoring(content, read.refused, apiUrl);
  return {
    from: "page",
    memoryUrl: read.memoryUrl,
    experimental: shellFlagsFromDeclared(declared.experimental),
  };
}

/** `content` parsed as JSON, where that is an object; `undefined` otherwise. */
function parseObject(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

/** Logs that the page's element is ignored for `reason`, and defers. */
function ignoring(
  content: string,
  reason: string,
  apiUrl: URL,
): DeploymentFromPage {
  console.error(
    `[shell] Ignoring the page's deployment ${JSON.stringify(content)} ` +
      `(${reason}); reading the deployment from ${apiUrl.origin} instead`,
  );
  return { from: "deployment" };
}

/**
 * The deployment for a shell at `pageOrigin` whose API URL is `apiUrl`: the
 * page's where it states one ({@link deploymentFromPage}), which is not
 * transient, and otherwise what the API URL's meta document publishes, read
 * once for both the memory URL and the flags. That read retries a document
 * it could not read for a transient reason, and then warns and leaves Memory
 * on `apiUrl`, with no flag adopted (`deploymentForShell`).
 */
export function resolveDeployment(
  page: Pick<ParentNode, "querySelector"> | undefined,
  apiUrl: URL,
  pageOrigin: string | undefined,
  fetch?: typeof globalThis.fetch,
): Promise<DeploymentForShell> {
  const fromPage = deploymentFromPage(page, apiUrl, pageOrigin);
  if (fromPage.from === "page") {
    return Promise.resolve({
      memoryUrl: fromPage.memoryUrl,
      experimental: fromPage.experimental,
      transient: false,
    });
  }
  return deploymentForShell({
    apiUrl,
    ...(fetch !== undefined ? { fetch } : {}),
  });
}

/** The deployment as the shell takes it: read early, used per runtime. */
export interface ShellDeployment {
  /** Starts a read if none is held, without using its result. */
  prefetch(): void;

  /** What one runtime the page creates takes from the deployment. */
  get(): Promise<Pick<DeploymentForShell, "memoryUrl" | "experimental">>;
}

/**
 * How long after it failed a read that failed for a transient reason may
 * still serve the first `get` that uses it. A page whose user takes longer
 * than this to sign in reads again for its first runtime rather than open
 * Memory on a failure from when the page loaded.
 */
const TRANSIENT_FAILURE_SERVES_MS = 10_000;

/** One read {@link holdDeployment} holds. */
interface HeldRead {
  result: Promise<DeploymentForShell>;
  /** When the read settled with a transient failure; unset otherwise. */
  failedAt?: number;
}

/**
 * Holds the deployment `read` gives. A read started by `prefetch` or by `get`
 * is held until a `get` has used it, so a read the page starts at load serves
 * its first runtime and is not repeated for it.
 *
 * A result that is not transient stays held for the page's lifetime, so
 * `read` is not called again: what the deployment published or said it has
 * none of, and a failure that would most likely come out the same, which then
 * warns once rather than at every runtime the page creates. A transient
 * failure goes to the `get` calls that awaited it and is then dropped, so the
 * next `get` reads again. It goes to a later `get` only within
 * {@link TRANSIENT_FAILURE_SERVES_MS} of failing; after that, that `get`
 * reads again.
 */
export function holdDeployment(
  read: () => Promise<DeploymentForShell>,
  /** @internal Seam for tests: a clock in milliseconds. */
  now: () => number = () => performance.now(),
): ShellDeployment {
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
      const { memoryUrl, experimental, transient } = await current.result;
      // A `get` that found this read stale has already replaced it with a
      // newer one, which this must not drop.
      if (transient && held === current) held = undefined;
      return { memoryUrl, experimental };
    },
  };
}
