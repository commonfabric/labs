/**
 * A FabriFile store's adds across a person's runtimes, where the store finds
 * its adder through its own `#profile` wish. One runtime finds the person's
 * profile. Another of the same person's runtimes acts as a profile their home
 * does not list, so its wish fails rather than answer as another profile, and
 * the store refuses that runtime's add saying their profile couldn't be read.
 * Once the other has added through the store, an add from the runtime that
 * found the profile still gets past the profile, to the blob it names, which
 * no space here holds. A store whose wish is per user keeps one answer for all
 * of a person's runtimes, which the failing runtime writes over.
 *
 * With server execution on, the store's handlers run served, and the add from
 * the runtime acting as the unlisted profile gets past the profile too.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrifile-store-profile-wish",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/**
 * Sends the store an add, under `requestId`, of a blob in `space` that the
 * space does not hold, and returns its outcome as `session` reads it.
 */
const addFrom = async (
  harness: MultiRuntimeHarness,
  session: MultiRuntimeSession,
  requestId: string,
): Promise<unknown> => {
  await session.send("add", {
    requestId,
    name: "photo.png",
    mediaType: "image/png",
    blob: { space: harness.spaceDid, id: "fid1:missing" },
    size: 4,
  });
  await harness.settle();
  return await session.read(["requests", requestId]);
};

describe("fabrifile store profile wish across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      const cfc = { experimental: { serverExecution } };

      it("gets an add from a session that found the profile past it, after a session whose wish failed is refused one", async () => {
        const person = await Identity.fromPassphrase(
          "fabrifile-store-profile-wish-person",
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [{
            label: "fabrifile-store-profile-wish-setup",
            identity: person,
            cfc,
          }],
        });

        // The person's home lists their profile before the runtimes under
        // test open the store, as a home made before any store does.
        const [setup] = harness.sessions;
        const profile = await setup.createOwnProfile("Person");
        await setup.send("holdProfile", { profile });
        await harness.settle();
        await setup.client().call("selectProfile", { path: ["profile"] });
        await harness.settle();

        const found = await harness.addSession({
          label: "fabrifile-store-profile-wish-found",
          identity: person,
          cfc,
        });
        await harness.settle();
        expect(await addFrom(harness, found, "found-before")).toMatchObject({
          status: "refused",
          code: "no-blob",
        });

        // The same person's runtime acting as a profile their home does not
        // list: its wish fails rather than answer as another profile.
        const unlisted = await Identity.fromPassphrase(
          "fabrifile-store-profile-wish-unlisted",
          { implementation: "noble" },
        );
        const failed = await harness.addSession({
          label: "fabrifile-store-profile-wish-failed",
          identity: person,
          cfc,
          preferredProfileSpace: unlisted.did(),
        });
        await harness.settle();
        expect(await addFrom(harness, failed, "failed")).toMatchObject(
          serverExecution ? { status: "refused", code: "no-blob" } : {
            status: "refused",
            code: "not-permitted",
            reason: "Your profile couldn't be read.",
          },
        );

        expect(await addFrom(harness, found, "found-after")).toMatchObject({
          status: "refused",
          code: "no-blob",
        });
      });
    });
  }
});
