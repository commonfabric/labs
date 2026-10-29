/**
 * A FabriChat room's answers about its reader, across runtimes: whether the
 * reader can send, who the room says they are, what they may do to each
 * message, and whether they can add someone, and what the room's rendering
 * derives from them, such as whether its composer is disabled. Each reader's
 * session has its own answer, so a session that can't read the person's
 * profile, as one whose `#profile` wish hasn't resolved can't, answers for
 * itself alone, and so does a person holding READ in the room's space.
 * Whichever of two sessions runs last, the other still reads its own: a
 * session that can send may edit the message it sent, and its composer is
 * enabled.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type MultiRuntimeSessionSpec,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-room-viewer",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The gesture a grant of access requires, as a members surface gives.
const CHANGE_ACCESS = { surface: "MembersSurface", action: "ChangeAccess" };

// The gesture a send requires, as the room's composer gives.
const SEND = { surface: "ChatSendSurface", action: "ChatSend" };

// The `inputId` of the room's main composer.
const COMPOSER_INPUT = "fabrichat-message";

/**
 * The path, below `path`, to the node of the stored rendering `node` whose
 * props hold `inputId`; `undefined` where none does.
 */
const pathToInput = (
  node: FabricValue,
  inputId: string,
  path: (string | number)[],
): (string | number)[] | undefined => {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      const found = pathToInput(child, inputId, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const { props, children } = node as Record<string, FabricValue>;
  if ((props as Record<string, FabricValue> | null)?.inputId === inputId) {
    return path;
  }
  return children === undefined
    ? undefined
    : pathToInput(children, inputId, [...path, "children"]);
};

describe("fabrichat room viewer across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      const cfc = { experimental: { serverExecution } };

      // Where the room's rendering holds its composer. A session that can't
      // read the person's profile can't read the whole rendering either, so
      // it is found in a session that can, and it is the same in every
      // session.
      let composer: (string | number)[] | undefined;

      /** Finds, in `session`, where the room's rendering holds its composer. */
      const findComposer = async (session: MultiRuntimeSession) => {
        composer = pathToInput(
          await session.readRaw(["$UI"]),
          COMPOSER_INPUT,
          ["$UI"],
        );
        expect(composer).toBeDefined();
      };

      /**
       * Starts the fixture with the person's two sessions: one that reads
       * their profile, and one whose reads stop short of the person's own
       * data, so it reads no profile. The profiled session makes its profile
       * the person's own.
       */
      const startTwoSessions = async () => {
        const person = await Identity.fromPassphrase(
          "fabrichat-room-viewer-person",
          { implementation: "noble" },
        );
        const specs: MultiRuntimeSessionSpec[] = [
          { label: "fabrichat-room-viewer-profiled", identity: person, cfc },
          {
            label: "fabrichat-room-viewer-profileless",
            identity: person,
            cfc,
            readCeiling: (spaceDid) => [cfcAtom.space(spaceDid)],
          },
        ];
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: specs,
        });
        const [profiled, profileless] = harness.sessions;
        const profile = await profiled.createOwnProfile("Person");
        await profiled.send("useProfile", { profile });
        await harness.settle();
        await profiled.send("sendMessage", { body: "Hello" }, SEND);
        await harness.settle();
        await findComposer(profiled);
        return { profiled, profileless };
      };

      // Whether a reader may edit the room's first message, which they sent,
      // where it is checked. With server execution on, a message sent here
      // doesn't reach the sender's `messageRights` in this harness, even with
      // no other session, so it is checked with server execution off alone.
      const editRight = (canEdit: boolean) =>
        serverExecution ? {} : { canEditFirst: canEdit };

      /**
       * Reads, in `session`, whether the room says it can send, whether the
       * room sees a profile for it, whether the room's composer is disabled
       * for it, and whether it may edit the room's first message.
       */
      const answers = async (session: MultiRuntimeSession) => {
        await harness!.settle();
        return {
          canSend: (await session.read(["canSend"])) === true,
          hasProfile: (await session.read(["viewer", "profile"])) !==
            undefined,
          composerDisabled:
            (await session.read([...composer!, "props", "disabled"])) ===
              true,
          ...editRight(
            (await session.read(["messageRights", 0, "canEdit"])) === true,
          ),
        };
      };

      it("keeps a profiled session able to send when the person's profile-less session reads last", async () => {
        const { profiled, profileless } = await startTwoSessions();

        expect(await answers(profiled)).toEqual({
          canSend: true,
          hasProfile: true,
          composerDisabled: false,
          ...editRight(true),
        });
        expect(await answers(profileless)).toEqual({
          canSend: false,
          hasProfile: false,
          composerDisabled: true,
          ...editRight(false),
        });
        expect(await answers(profiled)).toEqual({
          canSend: true,
          hasProfile: true,
          composerDisabled: false,
          ...editRight(true),
        });
      });

      it("keeps a profiled session able to send when the person's profile-less session reads first", async () => {
        const { profiled, profileless } = await startTwoSessions();

        expect(await answers(profileless)).toEqual({
          canSend: false,
          hasProfile: false,
          composerDisabled: true,
          ...editRight(false),
        });
        expect(await answers(profiled)).toEqual({
          canSend: true,
          hasProfile: true,
          composerDisabled: false,
          ...editRight(true),
        });
        expect(await answers(profileless)).toEqual({
          canSend: false,
          hasProfile: false,
          composerDisabled: true,
          ...editRight(false),
        });
      });

      it("keeps a writer able to send beside a member holding READ, whichever reads last", async () => {
        const writer = await Identity.fromPassphrase(
          "fabrichat-room-viewer-writer",
          { implementation: "noble" },
        );
        const reader = await Identity.fromPassphrase(
          "fabrichat-room-viewer-reader",
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [
            { label: "fabrichat-room-viewer-writer", identity: writer, cfc },
            { label: "fabrichat-room-viewer-reader", identity: reader, cfc },
          ],
        });
        const [writes, reads] = harness.sessions;
        const profile = await writes.createOwnProfile("Writer");
        await writes.send("useProfile", { profile });
        await writes.send(
          "grantRead",
          { principal: reader.did() },
          CHANGE_ACCESS,
        );
        await writes.send("sendMessage", { body: "Hello" }, SEND);
        await harness.settle();
        await findComposer(writes);

        expect(await answers(writes)).toMatchObject({
          canSend: true,
          composerDisabled: false,
          ...editRight(true),
        });
        expect(await answers(reads)).toMatchObject({
          canSend: false,
          composerDisabled: true,
          ...editRight(false),
        });
        expect(await answers(writes)).toMatchObject({
          canSend: true,
          composerDisabled: false,
          ...editRight(true),
        });
      });
    });
  }
});
