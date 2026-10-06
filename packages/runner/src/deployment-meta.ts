/**
 * Reads what a deployment tells the clients that are not built alongside it,
 * from its meta document (`/api/meta`): the experimental-flag posture and the
 * memory URL. Like `experimental-posture.ts`, it loads none of the runtime
 * execution graph, so a browser page can import it.
 */

import { debugStr } from "@commonfabric/data-model";

import {
  ADOPT_SERVER_FLAGS_ENV,
  adoptServerExperimentalOptions,
  type EnvReader,
  experimentalOptionsFromEnv,
  parseFlagValue,
  parseServerExperimentalOptions,
  SERVER_EXPERIMENTAL_PATH,
} from "./experimental-posture.ts";
import type { ExperimentalOptions } from "./runtime.ts";
import { namesApiOrigin, readMemoryUrl } from "./space-host.ts";

/**
 * The name of the `<meta>` element in which a compiled toolshed publishes its
 * `MEMORY_PUBLIC_URL` to the shell pages it serves. The `content` is the
 * memory URL, or empty where the deployment has none. The toolshed writes the
 * element and the shell reads it, both by this name.
 */
export const MEMORY_URL_META_NAME = "cf-memory-url";

/** How long one attempt to read the meta document may take. */
const META_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * The waits before the second and the third attempt to read a meta document
 * that could not be read for a transient reason: three attempts, 1.25 seconds
 * of waiting in all.
 */
const META_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

/**
 * The statuses with which a server says that it has no meta document,
 * which is a deployment that publishes nothing: 404 from a server with no
 * meta route, 405 from one whose route takes another method, 410 from one
 * that removed it.
 */
const NO_DOCUMENT_STATUSES: ReadonlySet<number> = new Set([404, 405, 410]);

/**
 * The transient statuses: the server could not respond now and may in a
 * moment. A request timeout, a rate limit, and a gateway that could not reach
 * or wait for a toolshed that is restarting.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  408,
  429,
  502,
  503,
  504,
]);

/** How to read a deployment's meta document. */
export interface DeploymentMetaParams {
  /** The deployment this client runs against; it serves the document. */
  apiUrl: URL;

  /**
   * Cancels the read, the waits between attempts included. A caller whose
   * startup is cancellable must pass its signal. Each attempt also gives up
   * on its own after five seconds, whether or not a signal is passed, so a
   * deployment that accepts the connection and then says nothing cannot hold
   * a caller indefinitely.
   */
  signal?: AbortSignal;

  /** @internal Seam for tests: the real `fetch` otherwise. */
  fetch?: typeof globalThis.fetch;

  /** @internal Seam for tests: how long one attempt may take. */
  attemptTimeoutMs?: number;

  /** @internal Seam for tests: the waits before the second and later
   * attempts. Empty makes one attempt. */
  retryDelaysMs?: readonly number[];
}

/** {@link DeploymentMetaParams} for a client that also adopts the posture. */
export interface DeployedClientParams extends DeploymentMetaParams {
  /** Reads this process's environment; pass `Deno.env.get` in Deno contexts. */
  env: EnvReader;
}

/**
 * The outcome of reading a deployment's meta document, or of one attempt to.
 *
 * - `conclusive: true`: the server returned its meta document, as `document`,
 *   or said it has none ({@link NO_DOCUMENT_STATUSES}), as an undefined
 *   `document`. Either settles what the deployment publishes.
 * - `conclusive: false`: the document could not be read. Every other outcome
 *   is this: the server was unreachable or refused the request, an attempt
 *   timed out, it returned another status, or an OK response's body was not a
 *   JSON object. `transient` says whether asking again may succeed: a
 *   connection that failed and a status in {@link TRANSIENT_STATUSES} are
 *   transient. An attempt that timed out is not: a server that accepted the
 *   connection and then sent nothing for five seconds is not asked again,
 *   since the health check that follows would wait on it too. A refusal such
 *   as a 401, a 403 or a 500, a redirect that was not followed, a body that is
 *   not JSON, and an error that is not a network failure, such as a
 *   permission the process lacks, get the same result however often they are
 *   asked.
 *
 * `redirectedOffOrigin` is the URL a followed redirect ended at, when that is
 * not the API URL's deployment ({@link staysOnDeployment}), such as a login or
 * canonical host. The posture is read from that response as from any other,
 * as clients did before deployments published a memory URL. The memory URL
 * is not ({@link memoryUrlFromMeta}).
 */
type DeploymentMeta =
  & { redirectedOffOrigin?: string }
  & (
    | { conclusive: true; document: Record<string, unknown> | undefined }
    | { conclusive: false; transient: boolean }
  );

/**
 * Reads the deployment's meta document, and returns the last attempt's
 * outcome. A document that could not be read for a transient reason is asked
 * for again, up to three attempts in all, since a deployment that is
 * restarting a toolshed or behind a proxy that is reloading responds again
 * within moments. An aborted `signal` throws its reason instead of resolving,
 * whether it arrives before the read, while a request or its body is in
 * flight, or during a wait between attempts.
 */
async function readDeploymentMeta(
  params: DeploymentMetaParams,
): Promise<DeploymentMeta> {
  const delays = params.retryDelaysMs ?? META_RETRY_DELAYS_MS;
  for (let attempt = 0;; attempt++) {
    params.signal?.throwIfAborted();
    const meta = await readMetaOnce(params);
    if (meta.conclusive || !meta.transient || attempt >= delays.length) {
      return meta;
    }
    await waitOrAbort(delays[attempt], params.signal);
  }
}

/**
 * Whether a redirect that ended at `url` stayed on `apiUrl`'s deployment:
 * at its origin, or at the same host on https where the API URL names http,
 * which is a proxy upgrading the connection to TLS.
 */
function staysOnDeployment(url: string, apiUrl: URL): boolean {
  let final: URL;
  try {
    final = new URL(url);
  } catch {
    return false;
  }
  return final.origin === apiUrl.origin ||
    (apiUrl.protocol === "http:" && final.protocol === "https:" &&
      final.host === apiUrl.host);
}

/** One attempt of {@link readDeploymentMeta}. */
async function readMetaOnce(
  params: DeploymentMetaParams,
): Promise<DeploymentMeta> {
  const fetchImpl = params.fetch ?? globalThis.fetch;
  const attempt = new AbortController();
  const timer = setTimeout(
    () => attempt.abort(new DOMException("timed out", "TimeoutError")),
    params.attemptTimeoutMs ?? META_ATTEMPT_TIMEOUT_MS,
  );
  const signal = params.signal === undefined
    ? attempt.signal
    : AbortSignal.any([params.signal, attempt.signal]);
  try {
    // The signal rides the request, which is what makes the BODY read below
    // cancellable too: aborting a signal passed to `fetch` terminates the
    // ongoing fetch and errors the response's stream, so a stalled
    // `response.json()` rejects rather than hanging, and lands in the catch.
    const response = await fetchImpl(
      new URL(SERVER_EXPERIMENTAL_PATH, params.apiUrl),
      { signal },
    );
    // Recorded rather than refused: the posture is read from wherever the
    // redirect ended, and only the memory URL is not.
    const offOrigin =
      response.redirected && !staysOnDeployment(response.url, params.apiUrl)
        ? { redirectedOffOrigin: response.url }
        : {};
    if (!response.ok) {
      // Discard the body rather than leaving the connection holding an
      // unread stream. An error page is not a meta document even when it
      // parses as one.
      await response.body?.cancel();
      params.signal?.throwIfAborted();
      const status = response.status;
      return NO_DOCUMENT_STATUSES.has(status)
        ? { ...offOrigin, conclusive: true, document: undefined }
        : {
          ...offOrigin,
          conclusive: false,
          transient: TRANSIENT_STATUSES.has(status),
        };
    }
    const body: unknown = await response.json();
    params.signal?.throwIfAborted();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? {
        ...offOrigin,
        conclusive: true,
        document: body as Record<string, unknown>,
      }
      : { ...offOrigin, conclusive: false, transient: false };
  } catch (error) {
    // A cancelled startup is the caller's decision, not a server that failed
    // to respond: propagate it instead of resolving settings for a runtime
    // construction the caller is abandoning. `fetch` reports a connection
    // that failed as a `TypeError`, and so does a body whose stream broke
    // off; a body that is not JSON is a `SyntaxError`. An attempt that
    // timed out is not asked again ({@link DeploymentMeta}).
    params.signal?.throwIfAborted();
    return {
      conclusive: false,
      transient: !attempt.signal.aborted && error instanceof TypeError,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Waits `ms`, or rejects with `signal`'s reason when it aborts first. */
function waitOrAbort(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The memory URL a read of the meta document gives: the `memoryUrl` it
 * publishes, read by `readMemoryUrl`. Each of these is none, and leaves Memory
 * on `apiUrl`:
 *
 * - a document without the field, or with `null`;
 * - a value naming `apiUrl`'s own origin;
 * - a published value that is not an HTTP or HTTPS origin, which is dropped
 *   with a warning, as a malformed flag is;
 * - a server that said it has no document;
 * - a response a redirect brought from off the API URL's deployment, whatever
 *   it says: a login or canonical host would otherwise decide where Memory
 *   opens, or with a 404 say there is no memory URL. That is warned about,
 *   naming where the redirect ended;
 * - a document that could not be read. That is warned about, naming the host
 *   Memory stays on, because a deployment with a memory router may not serve
 *   Memory there and the client's Memory would otherwise fail without a word.
 *   Every client opened Memory on `apiUrl` before deployments published a
 *   memory URL, so a deployment without a router keeps working.
 *
 * Each read warns at most once.
 */
function memoryUrlFromMeta(
  meta: DeploymentMeta,
  apiUrl: URL,
): URL | undefined {
  const metaUrl = new URL(SERVER_EXPERIMENTAL_PATH, apiUrl).href;
  if (meta.redirectedOffOrigin !== undefined) {
    console.warn(
      `[deployment-meta] ${metaUrl} redirected to ` +
        `${meta.redirectedOffOrigin}, which is not this API URL's ` +
        `deployment; Memory opens on ${apiUrl.origin}. If the deployment is ` +
        `served from ${originOf(meta.redirectedOffOrigin)}, set the API URL ` +
        `to that origin.`,
    );
    return undefined;
  }
  if (!meta.conclusive) {
    console.warn(
      `[deployment-meta] Could not read ${metaUrl}; Memory opens on ` +
        `${apiUrl.origin}, which may not serve it if the deployment routes ` +
        `Memory through a memory router.`,
    );
    return undefined;
  }
  const declared = meta.document?.memoryUrl;
  const parsed = readMemoryUrl(declared, apiUrl);
  if ("refused" in parsed) {
    console.warn(
      `[deployment-meta] Ignoring server-published memoryUrl=` +
        debugStr`$quote${declared} — ${parsed.refused}.`,
    );
    return undefined;
  }
  return parsed.memoryUrl;
}

/** The origin of `url`, or `url` itself where it does not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * A memory URL, and whether reading again may give another: what
 * {@link memoryUrlForDeployment} reads, and what a shell takes from a page
 * that states the memory URL, which is not transient.
 */
export interface DeploymentMemoryUrl {
  /**
   * The memory URL the deployment publishes, or `undefined`, which leaves
   * Memory on `apiUrl` ({@link memoryUrlFromMeta}).
   */
  memoryUrl: URL | undefined;

  /**
   * Whether the document could not be read for a transient reason, a
   * connection that failed or a status in {@link TRANSIENT_STATUSES}, so that
   * reading it again may give another memory URL. A caller that keeps the
   * result keeps it unless this is set: a document the server returned, or
   * said it has none of, settles the memory URL, and a failure that is not
   * transient, such as a 401 or an attempt that timed out, would most likely
   * come out the same way again.
   */
  transient: boolean;
}

/**
 * The memory URL a deployment publishes, from one read of its meta document,
 * for a client that takes nothing else from it: a shell whose page does not
 * state the memory URL.
 */
export async function memoryUrlForDeployment(
  params: DeploymentMetaParams,
): Promise<DeploymentMemoryUrl> {
  const meta = await readDeploymentMeta(params);
  return {
    memoryUrl: memoryUrlFromMeta(meta, params.apiUrl),
    transient: !meta.conclusive && meta.transient,
  };
}

/** What a client that is NOT built alongside its server takes from it. */
export interface DeployedClientSettings {
  /** The posture ({@link settingsForDeployedClient}). */
  experimental: ExperimentalOptions;

  /**
   * The host Memory opens on: the memory URL the deployment publishes, such
   * as a memory router's, or `apiUrl` where it publishes none or its document
   * could not be read ({@link memoryUrlFromMeta}). Open the storage manager
   * on it, and pass the same value to the `remoteClient` preset as
   * `memoryHost`, which gives the runtime its memory URL. One value for both
   * keeps the runtime's rule for host hints in step with where storage
   * actually opens Memory.
   */
  memoryHost: URL;
}

/**
 * What a client that is NOT built alongside its server takes from it, from
 * one read of its meta document ({@link readDeploymentMeta}): the posture and
 * the host Memory opens on. Call it wherever a runtime talks to a deployed
 * API: `cf`, the pieces controller, the connector hosts, the admin CLIs. The
 * presets that run against LOCAL emulated storage have no server to ask and
 * read the environment alone.
 *
 * The posture is the deployment's own, with this process's explicit
 * `EXPERIMENTAL_*` overriding it flag by flag. A document that could not be
 * read, and a server that said it has none, resolve to the
 * environment alone: the caller is about to fail loudly on its real work if
 * the server is genuinely down, and failing here first would only obscure
 * that. A server that RETURNS a pre-flag document (a meta document
 * without an `experimental` field, or a posture record silent on
 * `readerSchemaPrecedence` or `agentBuiltin`) is different: those flags adopt
 * their legacy declared `false` ({@link parseServerExperimentalOptions}). For
 * every other flag, absence of a declaration is not a declaration.
 * {@link ADOPT_SERVER_FLAGS_ENV} keeps the posture on the environment. It does
 * not stop the read, since the memory URL says where the deployment serves
 * Memory rather than what a flag is. A response a redirect brought from off
 * the API URL's deployment gives the posture as before, and no memory URL.
 *
 * The read is bounded. Each attempt may take five seconds, and one that does
 * ends the read. A transient failure is asked again, up to three attempts with
 * 1.25 seconds of waiting between them. So a server that stalls costs five
 * seconds, and one that keeps refusing the connection about 1.25. What the
 * caller does next, such as the runtime's health check, has bounds of its own
 * or none.
 *
 * An aborted `signal` is the one case that does NOT resolve: the caller asked
 * to stop, so this throws the abort reason rather than handing back settings
 * nobody is going to use.
 */
export async function settingsForDeployedClient(
  params: DeployedClientParams,
): Promise<DeployedClientSettings> {
  // Before anything else: a caller that has already stopped gets the abort.
  params.signal?.throwIfAborted();
  const env = experimentalOptionsFromEnv(params.env, "deployment-meta");
  const raw = params.env(ADOPT_SERVER_FLAGS_ENV);
  const refused = raw !== undefined &&
    parseFlagValue(raw, ADOPT_SERVER_FLAGS_ENV, "deployment-meta") === false;
  const meta = await readDeploymentMeta(params);
  return {
    experimental: refused || !meta.conclusive || meta.document === undefined
      ? env
      : adoptServerExperimentalOptions(
        parseServerExperimentalOptions(meta.document.experimental),
        env,
      ),
    memoryHost: memoryUrlFromMeta(meta, params.apiUrl) ?? params.apiUrl,
  };
}

/**
 * What a client adds to its report of a failed health check when Memory
 * opens on another host than `apiUrl`. The check does not ask the memory
 * host, so it says nothing about it either way; the report names it so that
 * whoever reads it knows Memory is not on the host that failed. Empty when
 * Memory opens on `apiUrl`.
 */
export function memoryHostNote(memoryHost: URL, apiUrl: URL): string {
  return namesApiOrigin(memoryHost, apiUrl)
    ? ""
    : ` Memory opens on "${memoryHost.href}", which the health check does not ask.`;
}
