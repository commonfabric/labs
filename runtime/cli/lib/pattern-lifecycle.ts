// Client for the toolshed's pattern-lifecycle verbs
// (docs/features/server-pattern-lifecycle.md). Under server execution the
// serving runtime compiles, materializes or replaces, and commits a
// pattern; what `cf` keeps is resolving the program from disk and sending
// it. A verb goes as a `pattern.lifecycle` request on the space's memory
// session, which reaches the process serving the space, and over HTTP to a
// server that does not take one there. An HTTP call carries a CF1
// first-party request proof signed with the user's own identity key; either
// way the server admits a caller the space's ACL names as a writer.

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";
import type { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "@commonfabric/runner";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

const BASE = "/api/pattern-lifecycle";

/**
 * Join a verb's path onto the configured API base, keeping the base's own
 * path, so a deployment served under a prefix is addressed at its endpoint.
 */
export const lifecycleUrl = (apiUrl: URL, verb: string): URL => {
  const url = new URL(apiUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${BASE}/${verb}`;
  return url;
};

/** A pattern-lifecycle verb's name. */
export type LifecycleVerb = "upload" | "instantiate" | "setsrc";

export interface LifecycleClientConfig {
  apiUrl: URL;

  /** Signs each request; the server authorizes its DID against the space. */
  identity: Identity;

  /**
   * Sends a verb, without its `space`, on the memory session of the space it
   * acts in, as `IStorageManager.runPatternLifecycle()` does. Tried first
   * where present; a server that does not advertise the request is called
   * over HTTP instead.
   */
  session?: (
    verb: LifecycleVerb,
    body: FabricPlainObject,
  ) => Promise<FabricPlainObject>;
}

/** A content-addressed pattern pointer. */
export interface PatternRef {
  identity: string;
  symbol: string;
}

/**
 * One step the serving side timed while answering a request: `phase` names
 * it (`instantiate.queue`, `registration.delivery`), and `ms` is its elapsed
 * time in milliseconds.
 */
export interface ServedPhaseTiming {
  phase: string;
  ms: number;
}

/**
 * The refusal codes that settle a verb: the server decided it, and the verb
 * did nothing. Every other code, like a lost connection, leaves the outcome
 * unknown.
 */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  "compile-failed",
  "forbidden",
  "incompatible",
  "invalid-request",
  "invalid-source",
  "payload-too-large",
  "pattern-not-found",
  "piece-not-found",
  "server-execution-off",
  "setup-failed",
  "slug-taken",
  "source-moved",
]);

/**
 * A refusal the serving side answered with. `code` is the server's stable
 * name for it, and `status` the HTTP status it came on, absent for one that
 * came on a memory session.
 */
export class ServedLifecycleError extends Error {
  readonly #code: string;
  readonly #status: number | undefined;

  /** Constructs an instance for the refusal `code`, sent with `status`. */
  constructor(code: string, status: number | undefined, message: string) {
    super(message);
    this.name = "ServedLifecycleError";
    this.#code = code;
    this.#status = status;
  }

  /** The server's stable name for the refusal. */
  get code(): string {
    return this.#code;
  }

  /** The HTTP status the refusal came on; absent over a memory session. */
  get status(): number | undefined {
    return this.#status;
  }

  /**
   * Whether the server decided the verb, so that it did nothing and a retry
   * gets the same answer: a 4xx other than 408 over HTTP, and a code the
   * server only sends for such a decision over a memory session.
   */
  get refused(): boolean {
    return this.#status === undefined
      ? REFUSED_CODES.has(this.#code)
      : this.#status >= 400 && this.#status < 500 && this.#status !== 408;
  }
}

/**
 * The program as the wire carries it. A resolved program holds nothing but
 * strings, and this projection is what keeps that true when the type grows
 * a field the server does not take.
 */
export function wireProgram(program: RuntimeProgram): {
  main: string;
  mainExport?: string;
  files: { name: string; contents: string }[];
  sourceRoots?: string[];
  dataFiles?: string[];
} {
  return {
    main: program.main,
    ...(program.mainExport === undefined
      ? {}
      : { mainExport: program.mainExport }),
    files: program.files.map(({ name, contents }) => ({ name, contents })),
    ...(program.sourceRoots === undefined
      ? {}
      : { sourceRoots: program.sourceRoots }),
    ...(program.dataFiles === undefined
      ? {}
      : { dataFiles: program.dataFiles }),
  };
}

async function call<T>(
  config: LifecycleClientConfig,
  verb: LifecycleVerb,
  payload: Record<string, unknown> & { space: string },
): Promise<T> {
  if (config.session !== undefined) {
    const sent = await callOnSession(config.session, verb, payload);
    if (sent.status === "answered") return sent.receipt as T;
  }
  return await callOverHttp(config, verb, payload);
}

/**
 * Helper for `call()`, which sends the verb on the space's memory session
 * and returns its receipt, or `unsupported` where the server does not take
 * the request there.
 *
 * @throws ServedLifecycleError when the server refuses the verb.
 */
async function callOnSession(
  session: NonNullable<LifecycleClientConfig["session"]>,
  verb: LifecycleVerb,
  { space: _space, ...payload }: Record<string, unknown> & { space: string },
): Promise<
  { status: "answered"; receipt: unknown } | { status: "unsupported" }
> {
  // Through JSON, so the session carries exactly the body HTTP would; what
  // JSON decodes to is a fabric value.
  const body: FabricValue = JSON.parse(JSON.stringify(payload));
  if (!isFabricPlainObject(body)) {
    throw new Error(`The \`${verb}\` arguments are not a JSON object`);
  }
  try {
    return { status: "answered", receipt: await session(verb, body) };
  } catch (error) {
    const code = error instanceof Error &&
        error.name === "PatternLifecycleRefusal"
      ? (error as Error & { code?: unknown }).code
      : undefined;
    if (code === "lifecycle-unsupported") return { status: "unsupported" };
    if (typeof code === "string") {
      throw new ServedLifecycleError(
        code,
        undefined,
        (error as Error).message,
      );
    }
    throw error;
  }
}

/**
 * Helper for `call()`, which posts the verb to the toolshed's route and
 * returns its receipt.
 *
 * @throws ServedLifecycleError when the server refuses the verb or answers
 *   with something other than JSON.
 */
async function callOverHttp<T>(
  config: LifecycleClientConfig,
  verb: LifecycleVerb,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = lifecycleUrl(config.apiUrl, verb);
  // The proof commits to the body hash, so the bytes signed and the bytes
  // sent must be identical — serialize once.
  const body = JSON.stringify(payload);
  const headers = await signFirstPartyHttpRequest({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signer: config.identity,
  });
  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServedLifecycleError(
      `http-${response.status}`,
      response.status,
      `${verb} failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    const refusal = parsed as { error?: unknown; code?: unknown };
    throw new ServedLifecycleError(
      typeof refusal.code === "string"
        ? refusal.code
        : `http-${response.status}`,
      response.status,
      typeof refusal.error === "string"
        ? refusal.error
        : `${verb} failed (${response.status})`,
    );
  }
  return parsed as T;
}

/**
 * Create a piece in `space` from `program`, set up and not started here,
 * with its name in the setup transaction and registration through the
 * default pattern action after setup commits. Missing roots or handlers retain
 * the created piece and report failed registration for a request-key retry.
 * The serving loop derives the piece in the cycle after the
 * creation commits unless `start` is `false`, which leaves it to the
 * first demand.
 */
export async function instantiatePieceOnServer(
  config: LifecycleClientConfig,
  input: {
    space: string;

    /** Stable key reused when a creation result is uncertain. */
    requestKey?: string;
    program: RuntimeProgram;
    argument?: object;
    repository?: string;
    slug?: string;
    force?: boolean;
    register?: boolean;
    start?: boolean;
  },
): Promise<{
  pieceId: string;
  pattern: PatternRef;
  slug?: string;
  requestKey: string;
  registration: {
    status: "skipped" | "pending" | "handled" | "failed";
    error?: string;
    attempt?: number;
    terminal?: true;
  };

  /** The steps the serving side timed; absent from a server that does not. */
  timings?: ServedPhaseTiming[];
}> {
  return await call(config, "instantiate", {
    space: input.space,
    ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
    program: wireProgram(input.program),
    ...(input.argument === undefined ? {} : { argument: input.argument }),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.register === undefined ? {} : { register: input.register }),
    ...(input.start === undefined ? {} : { start: input.start }),
  });
}

/**
 * Replace `piece`'s source in `space` with `program`, through the same
 * compatibility checks a client-side update runs, in a setup transaction
 * the serving runtime commits to the store on its own. The receipt is that
 * transaction's: the pointer the piece now holds, the revision it appended,
 * and the origin it detached. Unless `start` is `false`, the serving loop
 * derives the updated piece in the cycle after.
 */
export async function setPieceSourceOnServer(
  config: LifecycleClientConfig,
  input: {
    space: string;
    piece: string;
    program: RuntimeProgram;
    repository?: string;
    dangerouslyAllowIncompatibleSchema?: boolean;
    start?: boolean;
  },
): Promise<{
  pieceId: string;
  pattern: PatternRef;
  revisionId: string;
  seq: number;
  detachedOrigin: string | null;
}> {
  return await call(config, "setsrc", {
    space: input.space,
    piece: input.piece,
    program: wireProgram(input.program),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.dangerouslyAllowIncompatibleSchema === undefined ? {} : {
      dangerouslyAllowIncompatibleSchema:
        input.dangerouslyAllowIncompatibleSchema,
    }),
    ...(input.start === undefined ? {} : { start: input.start }),
  });
}
