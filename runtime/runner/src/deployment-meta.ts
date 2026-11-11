/**
 * Reads what a deployment tells the clients that are not built alongside it,
 * from its meta document (`/api/meta`): the experimental-flag posture and the
 * memory URL. Like `experimental-posture.ts`, it loads none of the runtime
 * execution graph, so a browser page can import it.
 */

import { debugStr } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/logger";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

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

const logger = getLogger("deployment-meta", { enabled: true, level: "warn" });

/**
 * The name of the `<meta>` element in which a compiled toolshed publishes what
 * the shell takes from its deployment, to the pages it serves. The `content`
 * is a {@link DeploymentMetaContent} as JSON. The toolshed writes the element and the
 * shell reads it, both by this name.
 */
export const DEPLOYMENT_META_NAME = "cf-deployment";

/**
 * Where the shell resolves one flag.
 *
 * - `"build"`: the shell's build decides, through the build define where
 *   `runtime/shell/felt.config.ts` has one and the built-in default
 *   otherwise. CI pins a lane's defines.
 * - `"deployment"`: the deployment decides. One shell build is served by
 *   every deployment, so a flag whose value differs between deployments
 *   that share a build goes here: a compiled toolshed publishes it, out of
 *   the posture `/api/meta` publishes, in the page it serves
 *   ({@link DEPLOYMENT_META_NAME}), and the shell adopts it from the page, or
 *   from the meta document, under `adoptServerExperimentalOptions`, as `cf`
 *   adopts the whole posture: an explicit build define still wins. Such a
 *   flag has to be `"server"` in `EXPERIMENTAL_FLAG_AUTHORITY`, since that
 *   adoption takes only server-authority flags, and must not change while a
 *   toolshed serves, since the page is built once. The runner's tests hold
 *   both, and for `serverExecution`, which the serving loop forces, a
 *   toolshed test holds that the page carries the value the loop publishes.
 */
export type ShellFlagSource = "build" | "deployment";

/**
 * Where the shell resolves every flag, type-gated like
 * `EXPERIMENTAL_FLAG_AUTHORITY`: a new flag does not compile until it is
 * placed here, so "does the shell follow the deployment on this?" is a
 * decision on record.
 */
export const SHELL_FLAG_SOURCES = {
  modernCellRep: "build",
  agentBuiltin: "build",
  contentAddressedSchemas: "build",
  commitPreconditions: "build",
  plainResultReceipts: "build",
  computedCellIds: "build",
  lazyMaterialization: "build",
  // Which side computes what is stored is the deployment's choice, and a
  // browser on the other arm derives beside the serving loop. The loop runs
  // exactly when the deployment's own resolution is on and forces only that
  // value, so the posture a page is built from already carries it. The host
  // declares the adopted arm to its worker, which checks it against its own.
  serverExecution: "deployment",
  localSessionDocuments: "deployment",
  // Whether a web client receives only what its mounted views need is the
  // deployment's choice: its serving side selects what each view is sent.
  viewScopedReplication: "deployment",
  webViewScopedReplication: "deployment",
  readerSchemaPrecedence: "build",
  localFold: "build",
  // Whether a new piece records its creator is the deployment's decision,
  // since its serving side is what binds an update-added field to the record.
  pieceCreatorRecord: "deployment",
  // Whether a connection may carry several spaces is how the deployment
  // routes connections: a deployment whose router terminates client
  // connections turns it on, and one that routes each connection by the
  // space its address names cannot, while both serve one shell build.
  sharedMemoryConnection: "deployment",
  // Whether a `const`-bound child is a named instance decides which document
  // a parent binds it to, so the shell has to run the naming mode of the
  // deployment whose spaces it opens.
  instanceNames: "deployment",
  // A client's own opt-in: the deployment's half is its server's offer, so
  // the shell takes it from its build.
  syncCidReferences: "build",
} as const satisfies Record<keyof ExperimentalOptions, ShellFlagSource>;

/** The flags {@link SHELL_FLAG_SOURCES} gives the deployment. */
export const SHELL_DEPLOYMENT_FLAGS: readonly (keyof ExperimentalOptions)[] =
  (Object.keys(SHELL_FLAG_SOURCES) as (keyof ExperimentalOptions)[]).filter(
    (flag) => SHELL_FLAG_SOURCES[flag] === "deployment",
  );

/**
 * What a compiled toolshed writes into the page it serves, as the element's
 * JSON content: the fields of its meta document the shell reads, in the
 * document's own shape, so that the shell reads a page and a document alike.
 * `memoryUrl` is the memory URL, or `null` where the deployment has none.
 * `experimental` is the posture restricted to {@link SHELL_DEPLOYMENT_FLAGS}
 * ({@link shellFlagsFromDeclared}), or `null` where the toolshed has no
 * Runtime, as on the meta document.
 */
export interface DeploymentMetaContent {
  memoryUrl: string | null;
  experimental: ExperimentalOptions | null;
}

/**
 * The flags the shell adopts from a posture a deployment declared, on its
 * meta document or in the page it served: `declared` read as
 * `parseServerExperimentalOptions` reads it, restricted to
 * {@link SHELL_DEPLOYMENT_FLAGS}. A declaration without one of them says
 * nothing about it, and the shell's default governs.
 */
export function shellFlagsFromDeclared(declared: unknown): ExperimentalOptions {
  const parsed = parseServerExperimentalOptions(declared);
  const flags: ExperimentalOptions = {};
  for (const key of SHELL_DEPLOYMENT_FLAGS) {
    if (parsed[key] !== undefined) flags[key] = parsed[key];
  }
  return flags;
}

/**
 * How long a deployed client waits on its server before treating it as dead:
 * the whole of a read of the meta document, and a health check of its hosts.
 * Firing early costs a client its posture, or fails its startup, so this sits
 * well above the slowest response measured under load, which
 * `docs/development/waiting-in-tests-rationale.md` records ("A deployed client's
 * wait on its server").
 */
export const DEPLOYMENT_RESPONSE_BOUND_MS = 60_000;

/**
 * How long a read of the meta document stays outstanding before it is logged
 * at error level: longer than the slowest response measured under load, so a
 * server that reaches this is worth someone's attention. The read goes on.
 */
const META_SLOW_READ_LOG_MS = 5_000;

/**
 * The waits before the second and the third attempt to read a meta document
 * that could not be read for a transient reason: three attempts, 1.25 seconds
 * of waiting in all, all within {@link DEPLOYMENT_RESPONSE_BOUND_MS}.
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
   * startup is cancellable must pass its signal. The read also gives up on its
   * own after {@link DEPLOYMENT_RESPONSE_BOUND_MS}, whether or not a signal is
   * passed, so a deployment that accepts the connection and then says nothing
   * cannot hold a caller indefinitely.
   */
  signal?: AbortSignal;

  /** @internal Seam for tests: the real `fetch` otherwise. */
  fetch?: typeof globalThis.fetch;

  /** @internal Seam for tests: how long the whole read may take. */
  boundMs?: number;

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
 *   is this: the server was unreachable or refused the request, the read
 *   outlasted {@link DEPLOYMENT_RESPONSE_BOUND_MS}, it returned another status,
 *   or an OK response's body was not a JSON object. `transient` says whether
 *   asking again may succeed: a connection that failed, a read that outlasted
 *   the bound, and a status in {@link TRANSIENT_STATUSES} are transient. A
 *   refusal such as a 401, a 403 or a 500, a redirect that was not followed, a
 *   body that is not JSON, and an error that is not a network failure, such as
 *   a permission the process lacks, get the same result however often they are
 *   asked. `reason` says what went wrong, for a log message: over a whole read,
 *   what went wrong at each attempt.
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
    | { conclusive: false; transient: boolean; reason: string }
  );

/**
 * Reads the deployment's meta document, and returns the last attempt's
 * outcome. A request stays outstanding until the server responds, since a slow
 * server's answer is the one the client needs, and the whole read ends at
 * {@link DEPLOYMENT_RESPONSE_BOUND_MS}. A read still going at
 * {@link META_SLOW_READ_LOG_MS} is logged at error level. A document that could
 * not be read for a transient reason is asked for again, up to three attempts
 * in all, since a deployment that is restarting a toolshed or behind a proxy
 * that is reloading responds again within moments. A document read after a
 * failed attempt, or after that error, is logged as a warning, so that the
 * error is not the last word and a retry that succeeds still leaves a trace. An
 * aborted `signal` throws its reason instead of resolving, whether it arrives
 * before the read, while a request or its body is in flight, or during a wait
 * between attempts.
 */
async function readDeploymentMeta(
  params: DeploymentMetaParams,
): Promise<DeploymentMeta> {
  const delays = params.retryDelaysMs ?? META_RETRY_DELAYS_MS;
  const boundMs = params.boundMs ?? DEPLOYMENT_RESPONSE_BOUND_MS;
  const metaUrl = metaUrlOf(params.apiUrl);
  const startedAt = Date.now();
  const deadline = new AbortController();
  const boundTimer = setTimeout(
    () => deadline.abort(new DOMException("timed out", "TimeoutError")),
    boundMs,
  );
  let loggedSlow = false;
  const slowTimer = setTimeout(() => {
    loggedSlow = true;
    logger.error(
      "read-slow",
      `No response from ${metaUrl} after ${META_SLOW_READ_LOG_MS} ms. This ` +
        `client waits for one, for up to ${boundMs} ms, and does not know ` +
        `what its deployment publishes until then.`,
    );
  }, META_SLOW_READ_LOG_MS);
  const signal = params.signal === undefined
    ? deadline.signal
    : AbortSignal.any([params.signal, deadline.signal]);
  const outlasted = `no response within ${boundMs} ms`;
  const failures: string[] = [];
  try {
    for (let attempt = 0;; attempt++) {
      params.signal?.throwIfAborted();
      if (deadline.signal.aborted) {
        failures.push(outlasted);
        return {
          conclusive: false,
          transient: true,
          reason: failures.join("; "),
        };
      }
      const meta = await readMetaOnce(
        params,
        signal,
        deadline.signal,
        outlasted,
      );
      if (meta.conclusive) {
        if (attempt > 0 || loggedSlow) {
          logger.warn(
            "read-late",
            `Read ${metaUrl} on attempt ${attempt + 1}, ` +
              `${Date.now() - startedAt} ms after asking` +
              `${
                failures.length > 0 ? `, after: ${failures.join("; ")}` : ""
              }.`,
          );
        }
        return meta;
      }
      failures.push(meta.reason);
      if (
        !meta.transient || deadline.signal.aborted || attempt >= delays.length
      ) {
        return { ...meta, reason: failures.join("; ") };
      }
      await waitUnlessAborted(delays[attempt], signal);
    }
  } finally {
    clearTimeout(boundTimer);
    clearTimeout(slowTimer);
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

/** The URL of the meta document of the deployment at `apiUrl`. */
function metaUrlOf(apiUrl: URL): string {
  return new URL(SERVER_EXPERIMENTAL_PATH, apiUrl).href;
}

/** One attempt of {@link readDeploymentMeta}. */
async function readMetaOnce(
  params: DeploymentMetaParams,
  signal: AbortSignal,
  deadline: AbortSignal,
  outlasted: string,
): Promise<DeploymentMeta> {
  const fetchImpl = params.fetch ?? globalThis.fetch;
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
          reason: `status ${status}`,
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
      : {
        ...offOrigin,
        conclusive: false,
        transient: false,
        reason: "the body is not a JSON object",
      };
  } catch (error) {
    // A cancelled startup is the caller's decision, not a server that failed
    // to respond: propagate it instead of resolving settings for a runtime
    // construction the caller is abandoning. `fetch` reports a connection
    // that failed as a `TypeError`, and so does a body whose stream broke
    // off; a body that is not JSON is a `SyntaxError`. A read that outlasted
    // its bound is reported however the abort surfaced.
    params.signal?.throwIfAborted();
    return {
      conclusive: false,
      transient: deadline.aborted || error instanceof TypeError,
      reason: deadline.aborted ? outlasted : debugStr`${error}`,
    };
  }
}

/** Waits `ms`, or until `signal` aborts, whichever comes first. */
function waitUnlessAborted(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
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
  const metaUrl = metaUrlOf(apiUrl);
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

/**
 * Says at error level that a client could not learn its deployment's posture,
 * why, and what it runs on instead. A client on another posture than its
 * deployment's reads what the deployment stores and serves differently from
 * everyone else, and a server that is only slow fails none of the client's real
 * work, so nothing else reports it.
 */
function logPostureUnread(
  meta: Extract<DeploymentMeta, { conclusive: false }>,
  apiUrl: URL,
  runsOn: string,
): void {
  logger.error(
    "posture-unread",
    `Could not read ${metaUrlOf(apiUrl)} (${meta.reason}), so this client ` +
      `does not know its deployment's posture. It runs on ${runsOn}, which ` +
      `does not match a deployment whose posture differs, such as one on the ` +
      `other server-execution arm.`,
  );
}

/** `serverExecution` as {@link logPostureUnread} names its value. */
function serverExecutionWord(enabled: boolean): string {
  return `\`serverExecution\` ${enabled ? "on" : "off"}`;
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
 * What the shell takes from its deployment, and whether reading again may
 * give another: what {@link deploymentForShell} reads from the meta
 * document, and what a shell takes from a page that states it, which is not
 * transient.
 */
export interface DeploymentForShell {
  /**
   * The memory URL the deployment publishes, or `undefined`, which leaves
   * Memory on `apiUrl` ({@link memoryUrlFromMeta}).
   */
  memoryUrl: URL | undefined;

  /**
   * The flags the deployment decides for the shell
   * ({@link shellFlagsFromDeclared}): empty where the document could not be
   * read or the server said it has none, which adopts nothing, as
   * {@link settingsForDeployedClient} adopts nothing then.
   */
  experimental: ExperimentalOptions;

  /**
   * Whether the document could not be read for a transient reason, a
   * connection that failed, a read that outlasted its bound or a status in
   * {@link TRANSIENT_STATUSES}, so that reading it again may give another
   * result. A caller that keeps the result keeps it unless this is set: a
   * document the server returned, or said it has none of, settles what the
   * deployment publishes, and a failure that is not transient, such as a 401,
   * would most likely come out the same way again.
   */
  transient: boolean;
}

/**
 * What a deployment publishes for the shell, from one read of its meta
 * document: the memory URL and the flags it decides for the shell. For a
 * shell whose page does not state them. The posture is read from wherever a
 * redirect ended, as {@link settingsForDeployedClient} reads it; the memory
 * URL is not. A document that could not be read adopts no flag, which is
 * logged at error level ({@link logPostureUnread}).
 */
export async function deploymentForShell(
  params: DeploymentMetaParams,
): Promise<DeploymentForShell> {
  const meta = await readDeploymentMeta(params);
  if (!meta.conclusive) {
    logPostureUnread(
      meta,
      params.apiUrl,
      `the flags its build gives it, with ` +
        serverExecutionWord(SERVER_EXECUTION_DEFAULT_ENABLED) +
        ` unless the build sets it`,
    );
  }
  return {
    memoryUrl: memoryUrlFromMeta(meta, params.apiUrl),
    experimental: !meta.conclusive || meta.document === undefined
      ? {}
      : shellFlagsFromDeclared(meta.document.experimental),
    transient: !meta.conclusive && meta.transient,
  };
}

/**
 * Where a deployment this client does NOT run against serves Memory: what a
 * host hint naming another deployment's origin resolves to
 * (`Runtime.resolveSpaceHost`). The read is one of {@link readDeploymentMeta}
 * against that origin, which serves `/api/meta` with CORS `*`, so a browser
 * page can read it too.
 *
 * - `memoryHost`: the memory URL the origin publishes, such as its router's;
 *   or the origin itself where it said it has no document, or returned one
 *   without the field, or one naming its own origin. Every client opened a
 *   space's Memory on the hinted origin before deployments published memory
 *   URLs, so a deployment without a router keeps working.
 * - `unread`: the memory host could not be learned, and `reason` says why:
 *   the document could not be read, a redirect left the origin's deployment,
 *   or the published value is not an HTTP or HTTPS origin. Each is a case the
 *   client could resolve wrongly if it guessed: the origin may route Memory
 *   through a router that the origin itself does not serve, and the client's
 *   own default is its own deployment's router, which is no place for another
 *   deployment's space. An unread origin is not warned about here; the caller
 *   decides how often to.
 */
export type ForeignMemoryHost =
  | { memoryHost: URL }
  | { unread: true; reason: string };

/**
 * Reads where `params.apiUrl`, another deployment's origin (an HTTP or HTTPS
 * origin, as `normalizeSpaceHost` gives it), serves Memory
 * ({@link ForeignMemoryHost}). Bounded as {@link settingsForDeployedClient}
 * describes, and an aborted `signal` throws its reason.
 */
export async function memoryHostForForeignOrigin(
  params: DeploymentMetaParams,
): Promise<ForeignMemoryHost> {
  const origin = params.apiUrl;
  const meta = await readDeploymentMeta(params);
  const metaUrl = metaUrlOf(origin);
  if (meta.redirectedOffOrigin !== undefined) {
    return {
      unread: true,
      reason: `${metaUrl} redirected to ${meta.redirectedOffOrigin}, ` +
        "which is not that origin's deployment",
    };
  }
  if (!meta.conclusive) {
    return { unread: true, reason: `${metaUrl} could not be read` };
  }
  const declared = meta.document?.memoryUrl;
  const parsed = readMemoryUrl(declared, origin);
  if ("refused" in parsed) {
    return {
      unread: true,
      reason: `${metaUrl} publishes memoryUrl=` +
        debugStr`$quote${declared} — ${parsed.refused}`,
    };
  }
  return { memoryHost: parsed.memoryUrl ?? origin };
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
 * that. A server that is only slow does not fail that work, so a document that
 * could not be read is logged at error level, naming what the client runs on
 * ({@link logPostureUnread}), unless {@link ADOPT_SERVER_FLAGS_ENV} refuses the
 * posture anyway. A server that RETURNS a pre-flag document (a meta document
 * without an `experimental` field, or a posture record silent on
 * `readerSchemaPrecedence` or `agentBuiltin`) is different: those flags adopt
 * their legacy declared `false` ({@link parseServerExperimentalOptions}). For
 * every other flag, absence of a declaration is not a declaration.
 * {@link ADOPT_SERVER_FLAGS_ENV} keeps the posture on the environment. It does
 * not stop the read, since the memory URL says where the deployment serves
 * Memory rather than what a flag is. A response a redirect brought from off
 * the API URL's deployment gives the posture as before, and no memory URL.
 *
 * The read is bounded. A request stays outstanding until the server responds,
 * since a slow server's answer is the posture this client needs, and at five
 * seconds that is logged at error level. The whole read ends at
 * {@link DEPLOYMENT_RESPONSE_BOUND_MS}, so a server that says nothing costs that
 * long. A transient failure is asked again, up to three attempts with 1.25
 * seconds of waiting between them, so one that keeps refusing the connection
 * costs about 1.25 seconds.
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
  if (!meta.conclusive && !refused) {
    logPostureUnread(
      meta,
      params.apiUrl,
      `its own flags: ${JSON.stringify(env)} from the environment, and this ` +
        `build's defaults otherwise, with ` +
        serverExecutionWord(
          env.serverExecution ?? SERVER_EXECUTION_DEFAULT_ENABLED,
        ),
    );
  }
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
