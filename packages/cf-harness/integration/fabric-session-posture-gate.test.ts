/**
 * Deployed-topology posture gate for cf-harness's fabric session.
 *
 * What it proves, against a real serving toolshed: the harness's OWN
 * production session path — `createHarnessFabricSessionFactory` (PKCS#8
 * identity from disk → `PiecesController.initialize` → deployed-client
 * posture adoption → the remoteClient preset) — resolves the flipped
 * first-party default with nothing declared in the environment, and the
 * session executes one genuine flow (compile + instantiate a pattern,
 * read a served result back). The explicit-env ON lanes never exercised
 * this unset-flag path; the flip changes exactly it.
 *
 * Runs only in the test topology's `deployed-topology` suite, whose
 * `toolshed` capability starts a server and sets API_URL; it is in
 * `integration/`, which the package's `deno-test` task does not match, so
 * the workspace unit suite never runs it. Locally:
 *   API_URL=http://localhost:8000 deno test --allow-env --allow-net \
 *     --allow-read --allow-write --allow-ffi --allow-run \
 *     integration/fabric-session-posture-gate.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { createHarnessFabricSessionFactory } from "../src/fabric-session.ts";

const API_URL = Deno.env.get("API_URL");

const GATE_PATTERN = `import { pattern } from "commonfabric";
export default pattern(() => ({ status: "serving" }));
`;

describe(
  "cf-harness deployed-topology posture gate",
  { ignore: !API_URL },
  () => {
    it("resolves the default posture and completes one genuine flow", async () => {
      // The gate exercises the DEFAULT resolution (unset flag → server
      // adoption → the first-party constant). An inherited explicit value
      // would make it vacuously test the env path instead.
      expect(Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION")).toBe(undefined);

      // The server half of the posture, probed from the gate itself: the
      // lane's toolshed matches the default binary's posture.
      const stats = await (await fetch(new URL("/api/health/stats", API_URL)))
        .json() as { servingLoop?: unknown };
      expect(stats.servingLoop != null).toBe(
        SERVER_EXECUTION_DEFAULT_ENABLED,
      );

      await using tempIdentity = await writeTempIdentity();
      const factory = createHarnessFabricSessionFactory({
        apiUrl: API_URL!,
        identityKeyPath: tempIdentity.path,
        space: `cf-harness-posture-gate-${Date.now()}`,
      });
      const session = await factory();
      try {
        // The client half: the session's runtime resolved the posture from the
        // deployment with nothing declared locally.
        expect(session.pieces.runtime.experimental.serverExecution).toBe(
          SERVER_EXECUTION_DEFAULT_ENABLED,
        );

        // One genuine flow through the session: compile + instantiate a
        // pattern and read its result back through the serving topology.
        const piece = await session.pieces.create(GATE_PATTERN);
        const statusCell = (await piece.result.getCell())
          .asSchema<{ status?: string }>()
          .key("status");
        await statusCell.pull();
        await waitForCellValue<string>(
          session.pieces.runtime,
          statusCell,
          (value) => value === "serving",
        );
      } finally {
        await session.pieces.dispose();
      }
    });
  },
);
