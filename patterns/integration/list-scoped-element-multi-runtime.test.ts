/**
 * A list's elements, instantiated per session, per user, and once for the
 * space, across runtimes that all run the list. Every runtime instantiates a
 * new element as the item arrives, and the space's instance documents go to
 * whichever commit lands first: the others are refused for reading them as
 * absent. A runtime whose commit was refused still has to instantiate the
 * element for its own session and user, which no other runtime does, so each
 * session's names list the new element in every scope.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "list-scoped-element",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

describe("list elements in each scope across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let sessions: MultiRuntimeSession[];

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["list-scoped-a", "list-scoped-b", "list-scoped-c"],
      recordRejections: true,
    });
    sessions = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("instantiates a new element for every session, in every scope, once the runtimes' instantiations have raced", async () => {
    await sessions[0].send("add", { item: "x" });
    await harness.settle();

    // Without a serving loop, every runtime instantiates the element itself,
    // and the race this covers refuses some runtime's commit.
    if (!SERVER_EXECUTION) {
      const refusals = (await Promise.all(
        sessions.map((session) => session.rejections()),
      )).flat().filter((rejection) =>
        rejection.message.startsWith("stale confirmed read")
      );
      expect(refusals.length, "no runtime's instantiation was refused")
        .toBeGreaterThan(0);
    }

    for (const session of sessions) {
      for (const field of ["sessionFound", "userFound", "spaceFound"]) {
        expect(await session.read([field]), `${session.label}: ${field}`)
          .toEqual(["found:x"]);
      }
    }
  });
});
