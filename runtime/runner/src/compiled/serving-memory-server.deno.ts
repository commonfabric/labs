/**
 * A memory server that listens on a localhost websocket, with a serving
 * loop whose runtimes run pieces from compiled patterns
 * (`serveCompiledPieces`): `listenServingMemoryServer()` of
 * `executor/serving-memory-server.deno.ts` with the experimental option
 * `compiledPatterns` on and the loader installed on each serving runtime,
 * which compiles the source a client wrote with one compiler of the server.
 * The loop runs on this thread, over a non-persistent store.
 *
 * Deno-only, as the server it listens with is.
 */
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import { namesInstancesByDefault } from "../builder/instance-name.ts";
import { ExecutorHost } from "../executor/host.ts";
import { servingRuntimeFactory } from "../executor/serving-runtime.ts";
import type { SpaceServerPolicy } from "../executor/space-server.ts";
import type { ExperimentalOptions, Runtime } from "../runtime.ts";
import {
  PatternCompiler,
  type PatternCompilerOptions,
} from "./compile.deno.ts";
import type { CompiledPiece } from "./piece.ts";
import {
  compiledPiecesOf,
  type CompilePatternProgram,
  serveCompiledPieces,
  type ServeCompiledPiecesOptions,
} from "./serving.ts";

/** A listening memory server whose serving loop runs compiled pieces. */
export type CompiledServingMemoryServer = {
  /** Where a client finds the server, as `memoryHost` and as `apiUrl`. */
  readonly url: URL;
  readonly server: MemoryV2Server.Server;
  /** The serving loop that is attached now. */
  readonly host: ExecutorHost;
  /**
   * Closes the serving loop and attaches another to the same memory
   * server, as a serving process that starts again does: its runtimes hold
   * nothing of the pieces the loop before ran.
   */
  restart(): Promise<void>;
  /**
   * Has the serving loop's next commit of a wave rejected, as a commit that
   * conflicts is, without reaching the store.
   */
  rejectNextWave(): void;
  /** The compiled pieces the serving runtimes run. */
  pieces(): CompiledPiece[];
  /** Closes the serving loop, then the memory server. */
  close(): Promise<void>;
};

/** Starts a {@link CompiledServingMemoryServer} on an ephemeral port. */
export const listenCompiledServingMemoryServer = async (
  options: {
    /** Experimental options of the serving runtimes, beside the forced ones. */
    experimental?: ExperimentalOptions;
    policy?: SpaceServerPolicy;
    /**
     * What compiles the source a client wrote. The default is one
     * `PatternCompiler` for the server, made with `compiler`, which runs
     * the binary of `base/pattern-compiler`.
     */
    compile?: CompilePatternProgram;
    /** Where the default compiler finds its binary and keeps what it gave. */
    compiler?: PatternCompilerOptions;
    /** What each serving runtime serves compiled pieces with. */
    pieces?: Omit<ServeCompiledPiecesOptions, "compile">;
  } = {},
): Promise<CompiledServingMemoryServer> => {
  const experimental = { ...options.experimental, compiledPatterns: true };
  // Each serving loop has an identity of its own, as each serving process
  // has a session of its own: the memory server numbers the commits of a
  // session, and takes the first commits of a second loop on the session
  // of the first as replays.
  const delegatingDids: string[] = [];
  let serviceIdentity = await Identity.generate();
  delegatingDids.push(serviceIdentity.did());
  let compile = options.compile;
  if (compile === undefined) {
    const compiler = new PatternCompiler(options.compiler);
    compile = (program) => compiler.compile(program);
  }
  const serve: ServeCompiledPiecesOptions = { ...options.pieces, compile };
  const standalone = StandaloneMemoryServer.start({
    acl: { mode: "off", delegatingDids },
    namesInstances: () => namesInstancesByDefault(experimental),
  });
  // A factory for each serving loop, as each serving process has one.
  const factory = () =>
    servingRuntimeFactory({
      server: standalone.server,
      identity: serviceIdentity,
      apiUrl: standalone.url,
      experimental,
    });
  let runtimes: Runtime[] = [];
  let rejecting = false;
  const attach = () => {
    const create = factory();
    return new ExecutorHost({
      decorateWaveCommitSink: (sink) => ({
        ...sink,
        currentHeads: (space, docs) => sink.currentHeads(space, docs),
        concurrentWritePaths: (space, doc, sinceSeq) =>
          sink.concurrentWritePaths(space, doc, sinceSeq),
        commitWave: (batch) => {
          if (!rejecting) return sink.commitWave(batch);
          rejecting = false;
          return Promise.resolve({
            error: {
              name: "WaveCommitRejected" as const,
              message: "The test rejected the wave.",
            },
          });
        },
      }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ensureSpaceRoots: false,
      server: standalone.server,
      serviceIdentity: serviceIdentity.did(),
      createRuntime: async (space, context) => {
        const made = await create(space, context);
        serveCompiledPieces(made.runtime, serve);
        runtimes.push(made.runtime);
        return made;
      },
    });
  };
  let host = attach();
  let closed: Promise<void> | undefined;
  return {
    url: standalone.url,
    server: standalone.server,
    get host() {
      return host;
    },
    rejectNextWave: () => {
      rejecting = true;
    },
    restart: async () => {
      await host.close();
      runtimes = [];
      serviceIdentity = await Identity.generate();
      delegatingDids.push(serviceIdentity.did());
      host = attach();
    },
    pieces: () => runtimes.flatMap((runtime) => compiledPiecesOf(runtime)),
    close: () =>
      closed ??= (async () => {
        try {
          await host.close();
        } finally {
          await standalone.close();
        }
      })(),
  };
};
