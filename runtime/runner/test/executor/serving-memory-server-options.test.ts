/**
 * What a serving memory server makes of the options it is started with: the
 * policy fields the environment fills in, the closures a worker-mode server
 * refuses, a worker pool that cannot start, and the naming posture its
 * memory server takes from the serving runtimes' flags. The servers' serving
 * itself is in `serving-memory-server.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { createClientInfo } from "@commonfabric/memory/v2/client-info";
import {
  policyFromEnvironment,
  type ServingMemoryServer,
  startServingMemoryServer,
} from "../../src/executor/serving-memory-server.deno.ts";
import { testPrincipalSessionOpenAuthFactory } from "../memory-v2-test-utils.ts";

const alice = await Identity.fromPassphrase("serving memory server options");

/** An environment holding `variables` and nothing else. */
const environment =
  (variables: Record<string, string>) => (name: string): string | undefined =>
    variables[name];

/** Whether `path` names something on disk. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/**
 * Records the temporary directories made while the result is held, so that a
 * case can say what became of the store a worker-mode server made.
 */
const recordTemporaryDirectories = () => {
  const made: string[] = [];
  const original = Deno.makeTempDir;
  const recording = stub(
    Deno,
    "makeTempDir",
    async (options?: Deno.MakeTempOptions) => {
      const path = await original(options);
      made.push(path);
      return path;
    },
  );
  return { made, [Symbol.dispose]: () => recording.restore() };
};

describe("serving-memory-server", () => {
  describe("policyFromEnvironment()", () => {
    it("turns the read-through and the overlapped commit on for the literal `true` alone", () => {
      expect(
        policyFromEnvironment(
          undefined,
          environment({
            SERVER_EXECUTION_STORE_READ_THROUGH: "true",
            SERVER_EXECUTION_OVERLAP_COMMIT: "true",
          }),
        ),
      ).toEqual({ storeReadThrough: true, overlapWaveCommit: true });
      expect(
        policyFromEnvironment(
          undefined,
          environment({
            SERVER_EXECUTION_STORE_READ_THROUGH: "1",
            SERVER_EXECUTION_OVERLAP_COMMIT: "TRUE",
          }),
        ),
      ).toBeUndefined();
    });

    it("takes the flush deadlines from positive decimal integers within a timer's range", () => {
      expect(
        policyFromEnvironment(
          undefined,
          environment({
            SERVER_EXECUTION_FLUSH_DEADLINE_MS: "25",
            SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS: "2147483647",
          }),
        ),
      ).toEqual({ flushDeadlineMs: 25, flushDeadlineMaxMs: 2_147_483_647 });
      for (const raw of ["0", "2.5", "1e3", "25ms", "2147483648", ""]) {
        expect(
          policyFromEnvironment(
            undefined,
            environment({
              SERVER_EXECUTION_FLUSH_DEADLINE_MS: raw,
              SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS: raw,
            }),
          ),
        ).toBeUndefined();
      }
    });

    it("keeps each field the policy sets, and the policy's other fields beside those the environment fills", () => {
      expect(
        policyFromEnvironment(
          {
            storeReadThrough: false,
            overlapWaveCommit: false,
            flushDeadlineMs: 5,
            idleParkMs: 7,
          },
          environment({
            SERVER_EXECUTION_STORE_READ_THROUGH: "true",
            SERVER_EXECUTION_OVERLAP_COMMIT: "true",
            SERVER_EXECUTION_FLUSH_DEADLINE_MS: "25",
            SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS: "50",
          }),
        ),
      ).toEqual({
        storeReadThrough: false,
        overlapWaveCommit: false,
        flushDeadlineMs: 5,
        flushDeadlineMaxMs: 50,
        idleParkMs: 7,
      });
    });
  });

  describe("startServingMemoryServer()", () => {
    it("refuses each closure a worker cannot take, naming it, and leaves no temporary store behind", async () => {
      using directories = recordTemporaryDirectories();
      await expect(startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        worker: true,
        fetch: globalThis.fetch,
        policy: { idleParkMs: 7, onSettleEnded: () => {} },
      })).rejects.toThrow(
        "a serving memory server in a worker takes no fetch, " +
          "policy.onSettleEnded: each is a closure",
      );
      expect(directories.made).toHaveLength(1);
      expect(await exists(directories.made[0])).toBe(false);
    });

    it("removes its temporary store when its worker pool cannot start, and throws why", async () => {
      using directories = recordTemporaryDirectories();
      await expect(startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        worker: true,
        maxWorkers: 0,
      })).rejects.toThrow("`maxWorkers` is 0");
      expect(directories.made).toHaveLength(1);
      expect(await exists(directories.made[0])).toBe(false);
    });

    describe("naming posture", () => {
      // A session that names instances is admitted to a space no data marks
      // only by a server that names them too, which this server does exactly
      // when its serving runtimes do.

      const openNamingSession = async (
        serving: ServingMemoryServer,
      ): Promise<void> => {
        const client = await MemoryClient.connect({
          transport: MemoryClient.loopback(serving.server),
          client: createClientInfo(),
          instanceNames: true,
        });
        try {
          await client.mount(
            alice.did(),
            {},
            testPrincipalSessionOpenAuthFactory(alice),
          );
        } finally {
          await client.close();
        }
      };

      it("admits a session that names instances where the serving runtimes name them", async () => {
        await using serving = await startServingMemoryServer({
          apiUrl: new URL(import.meta.url),
          worker: false,
          experimental: { instanceNames: true },
        });
        await openNamingSession(serving);
      });

      it("refuses a session that names instances where the serving runtimes do not", async () => {
        await using serving = await startServingMemoryServer({
          apiUrl: new URL(import.meta.url),
          worker: false,
        });
        await expect(openNamingSession(serving)).rejects.toThrow(
          "does not name instances",
        );
      });
    });
  });
});
