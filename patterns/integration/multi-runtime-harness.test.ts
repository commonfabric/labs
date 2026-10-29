/**
 * The multi-runtime harness's own session bookkeeping.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "space-access-multi-runtime",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

describe("multi-runtime-harness", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  describe("addSession", () => {
    it("starts one session when two starts ask for the same label at once", async () => {
      const owner = await Identity.fromPassphrase("harness label owner", {
        implementation: "noble",
      });
      harness = await MultiRuntimeHarness.create({
        programPath: PROGRAM_PATH,
        rootPath: ROOT_PATH,
        sessions: [{ label: "owner", identity: owner }],
      });

      const starts = await Promise.allSettled([
        harness.addSession({ label: "owner-later", identity: owner }),
        harness.addSession({ label: "owner-later", identity: owner }),
      ]);

      expect(starts.map((start) => start.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const refused = starts.find((start) => start.status === "rejected");
      const reason = (refused as PromiseRejectedResult).reason as Error;
      expect(reason.message).toBe(
        'A session labeled "owner-later" already exists',
      );
      expect(
        harness.sessions.filter((session) => session.label === "owner-later"),
      ).toHaveLength(1);
    });
  });
});
