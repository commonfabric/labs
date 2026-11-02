/**
 * Client for the pattern-lifecycle verbs
 * (docs/features/server-pattern-lifecycle.md). Under server execution the
 * serving runtime compiles, materializes or replaces, and commits a pattern;
 * what `cf` keeps is resolving the program from disk and sending it. A verb
 * goes as a `pattern.lifecycle` request on the space's memory session, which
 * reaches the process serving the space, and runs as the session's principal,
 * whom the server admits only as a writer of the space.
 */

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PatternLifecycleVerb } from "@commonfabric/memory/v2";
import type { RuntimeProgram } from "@commonfabric/runner";

/** How a verb reaches the serving side. */
export interface LifecycleClientConfig {
  /**
   * Sends a verb, with its arguments but without `space`, on the memory
   * session of `space`, as `IStorageManager.runPatternLifecycle()` does.
   */
  session: (
    space: MemorySpace,
    verb: PatternLifecycleVerb,
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
  "lifecycle-unsupported",
  "payload-too-large",
  "pattern-not-found",
  "piece-not-found",
  "server-execution-off",
  "setup-failed",
  "slug-taken",
  "source-moved",
]);

/**
 * A refusal the serving side answered with, or the memory client raised
 * before sending. `code` is the stable name for it.
 */
export class ServedLifecycleError extends Error {
  readonly #code: string;

  /** Constructs an instance for the refusal `code`. */
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServedLifecycleError";
    this.#code = code;
  }

  /** The stable name for the refusal. */
  get code(): string {
    return this.#code;
  }

  /**
   * Whether the verb was decided without running, so that it did nothing and
   * a retry gets the same answer.
   */
  get refused(): boolean {
    return REFUSED_CODES.has(this.#code);
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

/**
 * Sends `verb` on the memory session of the payload's space, with the rest of
 * the payload as its arguments, and returns its receipt.
 *
 * @throws ServedLifecycleError when the server refuses the verb, or the memory
 *   client refuses to send it.
 */
async function call<T>(
  config: LifecycleClientConfig,
  verb: PatternLifecycleVerb,
  { space, ...payload }: Record<string, unknown> & { space: MemorySpace },
): Promise<T> {
  // Through JSON, so the arguments are plain data: what JSON decodes to is a
  // fabric value.
  const body: FabricValue = JSON.parse(JSON.stringify(payload));
  if (!isFabricPlainObject(body)) {
    throw new Error(`The \`${verb}\` arguments are not a JSON object`);
  }
  try {
    return await config.session(space, verb, body) as T;
  } catch (error) {
    const code = error instanceof Error &&
        error.name === "PatternLifecycleRefusal"
      ? (error as Error & { code?: unknown }).code
      : undefined;
    if (typeof code === "string") {
      throw new ServedLifecycleError(code, (error as Error).message);
    }
    throw error;
  }
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
    space: MemorySpace;

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
    space: MemorySpace;
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
