/**
 * A FabriChat room's answers about its reader, across a person's runtimes,
 * where the room finds its reader through its own `#profile` wish. One runtime
 * finds the person's profile. Another of the same person's runtimes acts as a
 * profile their home does not list, so its wish fails rather than answer as
 * another profile. Once the other has run the room, the room documents the
 * runtime that found the profile reads, as stored there, still hold the
 * profile, and still say it can send.
 *
 * With server execution on, the room's values are served, and each runtime's
 * come from its own instance of the wish: the failing runtime's room offers
 * the profile form, while the documents the other reads still hold the
 * profile. A room whose wish is per user answers both runtimes from one
 * served wish, which finds the person's profile, so the failing runtime is
 * offered no form.
 *
 * The stored documents are read before the failing runtime's rendering. Read
 * the other way around, the rendering's reads give the runtime that found the
 * profile time to derive its answers again and write them back, which hides
 * the overwrite with server execution off.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-room-profile-wish",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/**
 * The path, below `path`, to the node of the stored rendering `node` whose
 * props hold `id`; `undefined` where none does.
 */
const pathToId = (
  node: FabricValue,
  id: string,
  path: (string | number)[],
): (string | number)[] | undefined => {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      const found = pathToId(child, id, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const { props, children } = node as Record<string, FabricValue>;
  if ((props as Record<string, FabricValue> | null)?.id === id) return path;
  return children === undefined
    ? undefined
    : pathToId(children, id, [...path, "children"]);
};

/** The display of the room's profile-setup surface, as `session` derives it. */
const setupDisplay = async (
  session: MultiRuntimeSession,
): Promise<unknown> => {
  const path = pathToId(
    await session.readRaw(["$UI"]),
    "fabrichat-profile-setup",
    ["$UI"],
  );
  expect(path).toBeDefined();
  return await session.read([...path!, "props", "style", "display"]);
};

/**
 * The stored value of the document the piece result's `path` resolves to in
 * `session`, read from that runtime's replica as stored rather than derived.
 */
const stored = async (
  session: MultiRuntimeSession,
  path: (string | number)[],
): Promise<unknown> => {
  const { id, space, scope } = await session.link(path);
  const { value } = await session.rawRead({ id, space, scope });
  return (value as { value?: unknown } | undefined)?.value;
};

describe("fabrichat room profile wish across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      const cfc = { experimental: { serverExecution } };

      it("keeps the profile in the room documents a session that found it reads, after a session whose wish failed runs the room", async () => {
        const person = await Identity.fromPassphrase(
          "fabrichat-room-profile-wish-person",
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [{
            label: "fabrichat-room-profile-wish-setup",
            identity: person,
            cfc,
          }],
        });

        // The person's home lists their profile before the runtimes under
        // test open the room, as a home made before any room does.
        const [setup] = harness.sessions;
        const profile = await setup.createOwnProfile("Person");
        await setup.send("holdProfile", { profile });
        await harness.settle();
        await setup.client().call("selectProfile", { path: ["profile"] });
        await harness.settle();

        const found = await harness.addSession({
          label: "fabrichat-room-profile-wish-found",
          identity: person,
          cfc,
        });
        await harness.settle();
        expect(await found.read(["viewer", "profile", "name"])).toBe("Person");
        expect(await found.read(["canSend"])).toBe(true);
        expect(await setupDisplay(found)).toBe("none");

        // The same person's runtime acting as a profile their home does not
        // list: its wish fails rather than answer as another profile. Reading
        // the room's viewer runs the room in that runtime.
        const unlisted = await Identity.fromPassphrase(
          "fabrichat-room-profile-wish-unlisted",
          { implementation: "noble" },
        );
        const failed = await harness.addSession({
          label: "fabrichat-room-profile-wish-failed",
          identity: person,
          cfc,
          preferredProfileSpace: unlisted.did(),
        });
        await failed.read(["viewer"]);
        await harness.settle();
        expect(await stored(found, ["viewer"])).toMatchObject({
          profile: expect.anything(),
          principal: person.did(),
        });
        expect(await stored(found, ["canSend"])).toBe(true);
        // Read after the stored documents: the reads of a rendering give the
        // other runtime time to derive its answers again and write them back
        // over the failing runtime's, which would hide that overwrite.
        expect(await setupDisplay(failed)).toBe("block");
      });
    });
  }
});
