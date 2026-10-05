/**
 * Starts the runner's local jobs: opens the store, reads the host's
 * profiles, writes the bearer token, serves the API on the private socket,
 * and starts the lane. It needs no fabric, so the runner starts it before,
 * and whatever becomes of, its Fabric lane.
 */

import { dirname, join } from "@std/path";

import type { HarnessJobOptions } from "../harness-job.ts";
import { createLocalJobApi } from "./api.ts";
import { LocalJobLane, type LocalJobLaneOptions } from "./lane.ts";
import { readLocalJobProfiles } from "./profiles.ts";
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
}

/** The running service. */
export interface LocalJobsService {
  /** The path of the bearer token file beside the socket. */
  tokenPath: string;

  /** Records whether the Fabric lane is running, for `/health`. */
  setFabricLane(running: boolean): void;

  /** Stops serving and the lane, then closes the store. */
  stop(): Promise<void>;
}

/** Helper for the token, which mints 32 random bytes as hex. */
const newToken = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

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
  } = {},
): Promise<LocalJobsService> => {
  const profiles = await readLocalJobProfiles(config.profilesPath);
  const storePath = config.storePath ??
    join(dirname(config.socketPath), "jobs.sqlite");
  // The store holds what callers asked and what jobs answered, so it is as
  // private as the socket. SQLite gives its journal files the database
  // file's mode, so creating that file 0600 first covers all three.
  await Deno.writeFile(storePath, new Uint8Array(), {
    append: true,
    mode: 0o600,
  });
  await Deno.chmod(storePath, 0o600);
  const store = LocalJobStore.open(storePath);
  const lane = new LocalJobLane({
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
  let fabricLane = false;
  const stopping = new AbortController();
  const token = newToken();
  const tokenPath = `${config.socketPath}.token`;
  // A socket file a stopped runner left behind is replaced; a listener can
  // only be created where no file is.
  await Deno.remove(config.socketPath).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.writeTextFile(tokenPath, token, { mode: 0o600 });
  await Deno.chmod(tokenPath, 0o600);
  const server = Deno.serve(
    {
      path: config.socketPath,
      transport: "unix",
      onListen: () => {},
    },
    createLocalJobApi({
      store,
      profiles,
      token,
      kick: () => lane.kick(),
      cancel: (id) => lane.cancel(id),
      fabricLane: () => fabricLane,
      stopping: stopping.signal,
    }),
  );
  await Deno.chmod(config.socketPath, 0o600);
  lane.start();
  report(
    `agent runner: serving local jobs on ${config.socketPath} (profiles: ${
      [...profiles.keys()].join(", ")
    }; at most ${config.maxConcurrent} at once)`,
  );
  return {
    tokenPath,
    setFabricLane(running) {
      fabricLane = running;
    },
    async stop() {
      try {
        stopping.abort();
        await server.shutdown();
        await lane.stop();
      } finally {
        store.close();
        await Deno.remove(tokenPath).catch(() => {});
      }
    },
  };
};
