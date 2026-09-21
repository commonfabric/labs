/**
 * The trusted Fabric session behind the `run_pattern` tool: a
 * `PiecesController` connected to a deployed API, built lazily on the tool's
 * first invocation and cached for the rest of the run while healthy.
 * Everything here runs on the trusted host side — nothing in this module ever
 * enters the docker sandbox.
 */

import { Identity } from "@commonfabric/identity";
import { isDIDKey } from "@commonfabric/identity/did";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  fabricSessionPresetCfcDials,
  type HarnessFabricSessionConfig,
  type HarnessFabricSessionPresetCfcDials,
} from "./config.ts";
import {
  createFabricInstantiationRecorder,
  type FabricPatternInstantiations,
} from "./fabric-instantiations.ts";
import {
  type HarnessForeignSpaces,
  validateHarnessForeignSpaces,
} from "./foreign-spaces.ts";

export interface HarnessFabricSession {
  pieces: PiecesController;

  /** Operator admission snapshot whose host routes are registered at startup. */
  readonly foreignSpaces?: HarnessForeignSpaces;

  /**
   * The identity this session acts as, when the session was built from one.
   *
   * The render gate needs it to stand up an isolated, in-memory runtime for
   * its probe: a probe run in the session's own space persists its inputs and
   * its result graph there, and neither `stop()` nor staying out of the piece
   * registry deletes them. A session that carries no identity gets no
   * isolated runtime and therefore no probe — the gate abstains rather than
   * quietly probing in the live space.
   */
  identity?: Identity;

  /**
   * What this session's runtime materialized, when the session was built with
   * an instantiation observer. A session without one answers no question about
   * pattern pointers, and the checks that read it are skipped rather than
   * failed.
   */
  instantiations?: FabricPatternInstantiations;
}

/**
 * Builds the run's Fabric session. The engine caches a healthy result so a
 * factory is called at most once per run while its session holds; a
 * construction failure surfaces as an ordinary `run_pattern` tool-output
 * error, and the next tool call invokes the factory again.
 */
export type HarnessFabricSessionFactory = () => Promise<HarnessFabricSession>;

/**
 * The `PiecesController.initialize` options a session config resolves to,
 * identity aside: the space and whichever CFC dials the config carries — an
 * unset dial stays absent so the remoteClient preset's own posture governs.
 * Pure so the resolution is testable without touching disk or network.
 */
export const harnessFabricSessionControllerOptions = (
  config: HarnessFabricSessionConfig,
): HarnessFabricSessionPresetCfcDials & {
  apiUrl: URL;
  space: string;
  cfcReadMaxConfidentiality?: HarnessFabricSessionConfig[
    "cfcReadMaxConfidentiality"
  ];
  cfcReadOnExceed?: HarnessFabricSessionConfig["cfcReadOnExceed"];
} => ({
  apiUrl: new URL(config.apiUrl),
  space: config.space,
  ...fabricSessionPresetCfcDials(config),
  ...(config.cfcReadMaxConfidentiality !== undefined
    ? { cfcReadMaxConfidentiality: config.cfcReadMaxConfidentiality }
    : {}),
  ...(config.cfcReadOnExceed !== undefined
    ? { cfcReadOnExceed: config.cfcReadOnExceed }
    : {}),
});

/**
 * The two steps of building a session that a test replaces: loading the
 * identity the session acts as, and connecting the controller. Production
 * reads the PKCS#8 key from disk and calls `PiecesController.initialize`.
 */
export interface HarnessFabricSessionFactoryDeps {
  /** Loads the identity named by the config's `identityKeyPath`. */
  loadIdentity?: (identityKeyPath: string) => Promise<Identity>;

  /** Connects the controller; `PiecesController.initialize` by default. */
  initialize?: (
    options: Parameters<typeof PiecesController.initialize>[0],
  ) => Promise<PiecesController>;
}

/**
 * Whether `runtime` is bounded by exactly the read ceiling `options` asked
 * for. The controller's options and the runtime's own fields are two
 * declarations that can drift apart, and a session whose runtime holds a
 * different ceiling than the one the config asked for — or none — would read
 * under one posture while its artifacts attest another.
 */
export const fabricSessionRuntimeBoundedAsConfigured = (
  runtime: Pick<
    PiecesController["runtime"],
    "cfcReadMaxConfidentiality" | "cfcReadOnExceed"
  >,
  options: Pick<
    ReturnType<typeof harnessFabricSessionControllerOptions>,
    "cfcReadMaxConfidentiality" | "cfcReadOnExceed"
  >,
): boolean =>
  JSON.stringify(runtime.cfcReadMaxConfidentiality) ===
    JSON.stringify(options.cfcReadMaxConfidentiality) &&
  runtime.cfcReadOnExceed === options.cfcReadOnExceed;

/**
 * Default factory over `config`: loads the PKCS#8 identity from disk and
 * connects a `PiecesController` to the deployed API. An unauthorized space
 * fails construction rather than yielding a session whose every read is a
 * silent absence. The controller's runtime is given an instantiation recorder,
 * whose read side rides along on the session — the observer is a runtime
 * constructor option, so this is the only point at which it can be installed.
 * Admitted foreign host routes are registered before the session is returned;
 * a refused route disposes the runtime and fails construction.
 *
 * The session is refused, and its runtime disposed, when the runtime is not
 * bounded by the read ceiling the config asked for
 * (`fabricSessionRuntimeBoundedAsConfigured`).
 */
export const createHarnessFabricSessionFactory = (
  config: HarnessFabricSessionConfig,
  deps: HarnessFabricSessionFactoryDeps = {},
): HarnessFabricSessionFactory =>
async () => {
  const foreignSpaces = validateHarnessForeignSpaces(
    config.foreignSpaces ?? {},
  );
  const loadIdentity = deps.loadIdentity ??
    (async (path: string) => Identity.fromPkcs8(await Deno.readFile(path)));
  const initialize = deps.initialize ??
    ((options) => PiecesController.initialize(options));
  const identity = await loadIdentity(config.identityKeyPath);
  const recorder = createFabricInstantiationRecorder();
  const options = harnessFabricSessionControllerOptions(config);
  const pieces = await initialize({
    ...options,
    identity,
    onPatternInstantiated: recorder.observe,
  });
  if (!fabricSessionRuntimeBoundedAsConfigured(pieces.runtime, options)) {
    await pieces.runtime.dispose().catch(() => {});
    throw new Error(
      "fabric session runtime is not bounded by the configured read " +
        "ceiling; refusing to run under it",
    );
  }
  try {
    for (const [space, host] of Object.entries(foreignSpaces)) {
      if (
        !isDIDKey(space) || space === pieces.getSpace() ||
        !pieces.runtime.registerSpaceHost(space, host)
      ) {
        throw new Error("Foreign space host route was refused by the session");
      }
    }
  } catch (error) {
    await pieces.runtime.dispose().catch(() => {});
    throw error;
  }
  return {
    pieces,
    identity,
    foreignSpaces,
    instantiations: recorder.instantiations,
  };
};

/**
 * Wraps `factory` so a healthy session is built once and shared by every
 * invocation in the run. An in-flight construction is shared too, but a
 * REJECTED construction clears the cache: the failure still reaches every
 * caller awaiting it, and the next tool call invokes the factory again
 * rather than replaying a terminal failure for the rest of the run. A
 * synchronous throw from the factory folds into the same rejected promise.
 */
export const cacheHarnessFabricSessionFactory = (
  factory: HarnessFabricSessionFactory,
): HarnessFabricSessionFactory => {
  let session: Promise<HarnessFabricSession> | undefined;
  return () => {
    if (session === undefined) {
      const attempt: Promise<HarnessFabricSession> = Promise.resolve()
        .then(factory)
        .catch((error) => {
          if (session === attempt) {
            session = undefined;
          }
          throw error;
        });
      session = attempt;
    }
    return session;
  };
};
