// HTTP client for the toolshed's pattern-lifecycle verbs
// (docs/features/server-pattern-lifecycle.md). Under server execution the
// serving runtime compiles, materializes or replaces, and commits a
// pattern; what `cf` keeps is resolving the program from disk and sending
// it. Every call carries a CF1 first-party request proof signed with the
// user's own identity key, and the server admits a caller the space's ACL
// names as a writer.

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

export interface LifecycleClientConfig {
  apiUrl: URL;

  /** Signs each request; the server authorizes its DID against the space. */
  identity: Identity;
}

/** A content-addressed pattern pointer. */
export interface PatternRef {
  identity: string;
  symbol: string;
}

/**
 * A refusal the serving side answered with. `code` is the server's stable
 * name for it, and `status` the HTTP status it came on.
 */
export class ServedLifecycleError extends Error {
  readonly #code: string;
  readonly #status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ServedLifecycleError";
    this.#code = code;
    this.#status = status;
  }

  get code(): string {
    return this.#code;
  }

  get status(): number {
    return this.#status;
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
  verb: string,
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
 * default pattern action after setup commits. The serving loop derives the piece in the cycle after the
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
  };
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
