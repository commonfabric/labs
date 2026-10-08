/**
 * Starts the runner's local jobs: opens the store, reads the host's
 * profiles, writes the bearer token, serves the API on the private socket,
 * and starts the lane. It needs no fabric, so the runner starts it before,
 * and whatever becomes of, its Fabric lane.
 */

import { encodeHex } from "@std/encoding/hex";
import { dirname, join } from "@std/path";

import type { HarnessJobOptions } from "../harness-job.ts";
import { createLocalJobApi } from "./api.ts";
import { LocalJobLane, type LocalJobLaneOptions } from "./lane.ts";
import { readLocalJobProfiles } from "./profiles.ts";
import {
  type LaneReadiness,
  type LaneTransition,
  LOCAL_JOB_FEATURES,
  LOCAL_JOB_ROUTES,
  transitionLane,
} from "./readiness.ts";
import { LocalJobStore } from "./store.ts";

/** Where and how the runner serves local jobs. */
export interface LocalJobsConfig {
  /** The Unix socket the API listens on. */
  socketPath: string;

  /** The host's profile file. */
  profilesPath: string;

  /** The job store; `jobs.sqlite` beside the socket unless named. */
  storePath?: string;

  /** The most local jobs run at once. */
  maxConcurrent: number;

  /** The directory each job's workspace and artifacts are created under. */
  workRoot: string;

  /** The runner's own Loom retrieval file, for a profile that names none. */
  loomRetrievalConfigPath?: string;

  /** The runner's own model, for a profile that names none. */
  model?: string;

  /** Labs revision captured when this runner starts; null when unknown. */
  labsCommit?: string | null;
}

/** The running service. */
export interface LocalJobsService {
  /** The path of the bearer token file beside the socket. */
  tokenPath: string;

  /** Records whether the Fabric lane is running, for `/health`. */
  setFabricLane(running: boolean): void;

  /** Records a Fabric lifecycle change with its reason. */
  setFabricReadiness(next: LaneTransition): void;

  /** Stops serving and the lane, then closes the store. */
  stop(): Promise<void>;
}

/** Helper for the token, which mints 32 random bytes as hex. */
const newToken = (): string =>
  encodeHex(crypto.getRandomValues(new Uint8Array(32)));

/** Reclaims only a Unix socket whose listener is gone. */
const reclaimSocket = async (path: string): Promise<void> => {
  try {
    if (!(await Deno.lstat(path)).isSocket) {
      throw new Error(`The local jobs socket path is occupied: ${path}`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  try {
    const connection = await Deno.connect({ transport: "unix", path });
    connection.close();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    if (error instanceof Deno.errors.ConnectionRefused) {
      await Deno.remove(path);
      return;
    }
    throw error;
  }
  throw new Error(`A listener already owns the local jobs socket: ${path}`);
};

/**
 * Starts serving local jobs as `config` says.
 *
 * @throws Error when the profile file cannot be read, or the socket's
 * directory does not exist.
 */
export const startLocalJobs = async (
  config: LocalJobsConfig,
  report: (message: string) => void,
  deps: {
    runJob?: LocalJobLaneOptions["runJob"];
    harnessDeps?: HarnessJobOptions["harnessDeps"];
    chmod?: typeof Deno.chmod;
  } = {},
): Promise<LocalJobsService> => {
  const profiles = await readLocalJobProfiles(config.profilesPath);
  const storePath = config.storePath ??
    join(dirname(config.socketPath), "jobs.sqlite");
  const guards: Deno.FsFile[] = [];
  const tokenPath = `${config.socketPath}.token`;
  const stopping = new AbortController();
  let store: LocalJobStore | undefined;
  let lane: LocalJobLane | undefined;
  let server: Deno.HttpServer<Deno.UnixAddr> | undefined;
  let tokenOwned = false;
  let socketOwned = false;
  let ready = false;
  let fabricReadiness: LaneReadiness = {
    state: "starting",
    since: new Date().toISOString(),
    reason: "Connecting and subscribing to the Fabric queue",
  };
  let localReadiness: LaneReadiness = {
    state: "starting",
    since: new Date().toISOString(),
    reason: "Initializing the private socket and local job lane",
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    cleanupPromise ??= (async () => {
      ready = false;
      stopping.abort();
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      await attempt(() => server?.shutdown());
      await attempt(() => lane?.stop());
      await attempt(() => store?.close());
      for (
        const path of [
          ...(socketOwned ? [config.socketPath] : []),
          ...(tokenOwned ? [tokenPath] : []),
        ]
      ) {
        await attempt(async () => {
          try {
            await Deno.remove(path);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        });
      }
      for (const guard of guards) await attempt(() => guard.close());
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Local jobs cleanup failed",
        );
      }
    })();
  try {
    // Persistent guard files keep one inode for every contender. Kernel
    // locks release on close or crash; unlinking them would split ownership.
    for (const path of [...new Set([config.socketPath, storePath])].sort()) {
      const guard = await Deno.open(`${path}.lock`, {
        read: true,
        write: true,
        create: true,
        mode: 0o600,
      });
      guards.push(guard);
      if (!await guard.tryLock(true)) {
        throw new Error(`Local jobs resource is already owned: ${path}`);
      }
    }
    await reclaimSocket(config.socketPath);
    // SQLite gives its journals the database file's mode.
    await Deno.writeFile(storePath, new Uint8Array(), {
      append: true,
      mode: 0o600,
    });
    await Deno.chmod(storePath, 0o600);
    store = LocalJobStore.open(storePath);
    lane = new LocalJobLane({
      store,
      profiles,
      maxConcurrent: config.maxConcurrent,
      workRoot: config.workRoot,
      ...(config.loomRetrievalConfigPath !== undefined
        ? { loomRetrievalConfigPath: config.loomRetrievalConfigPath }
        : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(deps.runJob !== undefined ? { runJob: deps.runJob } : {}),
      ...(deps.harnessDeps !== undefined
        ? { harnessDeps: deps.harnessDeps }
        : {}),
      report,
    });
    const token = newToken();
    await Deno.writeTextFile(tokenPath, token, { mode: 0o600 });
    tokenOwned = true;
    await Deno.chmod(tokenPath, 0o600);
    const api = createLocalJobApi({
      store,
      profiles,
      token,
      kick: () => lane!.kick(),
      cancel: (id) => lane!.cancel(id),
      browserHost: (id) => lane!.browserHost(id),
      health: () => ({
        ok: true,
        lanes: { local: ready, fabric: fabricReadiness.state === "up" },
        readiness: { local: localReadiness, fabric: fabricReadiness },
        routes: LOCAL_JOB_ROUTES,
        features: LOCAL_JOB_FEATURES,
        profileFile: config.profilesPath,
        storePath,
        labsCommit: config.labsCommit ?? null,
      }),
      stopping: stopping.signal,
    });
    server = Deno.serve(
      { path: config.socketPath, transport: "unix", onListen: () => {} },
      async (request) => {
        if (ready) return await api(request);
        if (
          request.method === "GET" &&
          new URL(request.url).pathname === "/health"
        ) {
          const response = await api(request);
          return response.status === 200
            ? new Response(response.body, {
              status: 503,
              headers: response.headers,
            })
            : response;
        }
        return Response.json({ ok: false, code: "starting" }, { status: 503 });
      },
    );
    socketOwned = true;
    await (deps.chmod ?? Deno.chmod)(config.socketPath, 0o600);
    lane.start();
    report(
      `agent runner: serving local jobs on ${config.socketPath} (profiles: ${
        [...profiles.keys()].join(", ")
      }; at most ${config.maxConcurrent} at once)`,
    );
    localReadiness = transitionLane(localReadiness, {
      state: "up",
      reason: null,
    });
    ready = true;
    return {
      tokenPath,
      setFabricLane(running) {
        fabricReadiness = transitionLane(fabricReadiness, {
          state: running ? "up" : "down",
          reason: running ? null : "The Fabric lane stopped",
        });
      },
      setFabricReadiness(next) {
        fabricReadiness = transitionLane(fabricReadiness, next);
      },
      stop: cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch { /* The startup error is the cause the caller needs. */ }
    throw error;
  }
};
