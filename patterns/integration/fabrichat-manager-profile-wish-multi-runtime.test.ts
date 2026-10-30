/**
 * A FabriChat manager's answers about whether its reader can start a chat,
 * across a person's runtimes, where the manager finds its reader through its
 * own `#profile` wish. One runtime finds the person's profile. Another of the
 * same person's runtimes acts as a profile their home does not list, so its
 * wish fails rather than answer as another profile. Once the other has run the
 * manager, the documents the runtime that found the profile reads for the
 * start controls' `disabled` and for the chat address, as stored there, still
 * say it can start a chat, and still show the person's address.
 *
 * The same holds with server execution on, where the failing runtime's own
 * answers say it can't start a chat as well.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { AdmittedCommitNotice } from "@commonfabric/memory/v2/server";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-manager-profile-wish",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/**
 * The path, below `path`, to the node of the stored rendering `node` whose
 * props hold `value` at `prop`; `undefined` where none does.
 */
const pathToProp = (
  node: FabricValue,
  prop: string,
  value: string,
  path: (string | number)[],
): (string | number)[] | undefined => {
  if (Array.isArray(node)) {
    for (const [index, child] of node.entries()) {
      const found = pathToProp(child, prop, value, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const { props, children } = node as Record<string, FabricValue>;
  if ((props as Record<string, FabricValue> | null)?.[prop] === value) {
    return path;
  }
  return children === undefined
    ? undefined
    : pathToProp(children, prop, value, [...path, "children"]);
};

/**
 * The path, below the piece result, to the props of the node of the manager's
 * rendering whose props hold `value` at `prop`, as `session` reads it.
 */
const propsPath = async (
  session: MultiRuntimeSession,
  prop: string,
  value: string,
): Promise<(string | number)[]> => {
  const path = pathToProp(await session.readRaw(["$UI"]), prop, value, [
    "$UI",
  ]);
  expect(path).toBeDefined();
  return [...path!, "props"];
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

/**
 * Each scope, as a scope key, in which `commits` wrote the document `id`, once.
 */
const writtenScopes = (
  commits: AdmittedCommitNotice[],
  id: string,
): string[] => [
  ...new Set(
    commits.flatMap((commit) => commit.writes)
      .filter((write) => write.id === id)
      .map((write) => write.scopeKey),
  ),
];

describe("fabrichat-manager-profile-wish-multi-runtime", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      const cfc = { experimental: { serverExecution } };

      it("keeps the start controls enabled, and the address, in the documents a session that found the profile reads, after a session whose wish failed runs the manager", async () => {
        const person = await Identity.fromPassphrase(
          "fabrichat-manager-profile-wish-person",
          { implementation: "noble" },
        );
        harness = await MultiRuntimeHarness.create({
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
          sessions: [{
            label: "fabrichat-manager-profile-wish-setup",
            identity: person,
            cfc,
          }],
        });

        // The person's home lists their profile before the runtimes under
        // test open the manager, as a home made before any manager does.
        const [setup] = harness.sessions;
        const profile = await setup.createOwnProfile("Person");
        await setup.send("holdProfile", { profile });
        await harness.settle();
        await setup.client().call("selectProfile", { path: ["profile"] });
        await harness.settle();

        const found = await harness.addSession({
          label: "fabrichat-manager-profile-wish-found",
          identity: person,
          cfc,
        });
        await harness.settle();
        const start = await propsPath(
          found,
          "inputId",
          "fabrichat-start-direct",
        );
        const disabled = await found.link([...start, "disabled"]);
        // The session's group draft, which each session stores in its own
        // scope, and which says what that scope is.
        const draft = await found.link([
          ...await propsPath(found, "id", "fabrichat-group-title"),
          "$value",
        ]);
        const address = await propsPath(found, "id", "fabrichat-my-address");
        expect(await found.read([...start, "disabled"])).toBe(false);
        expect(await found.read([...address, "style", "display"])).toBe(
          "block",
        );

        // The same person's runtime acting as a profile their home does not
        // list: its wish fails rather than answer as another profile. Reading
        // the manager's rendering runs the manager in that runtime.
        const unlisted = await Identity.fromPassphrase(
          "fabrichat-manager-profile-wish-unlisted",
          { implementation: "noble" },
        );
        let failed!: MultiRuntimeSession;
        const failedRunning = await harness.admittedCommitsDuring(async () => {
          failed = await harness!.addSession({
            label: "fabrichat-manager-profile-wish-failed",
            identity: person,
            cfc,
            preferredProfileSpace: unlisted.did(),
          });
          await failed.readRaw(["$UI"]);
          await harness!.settle();
        });
        expect(await failed.read([...start, "disabled"])).toBe(true);

        // While the session whose wish failed runs, its answer is written in
        // its own scope, where its draft is, and in no other: not into an
        // instance another session of the person's reads, and not by another
        // session that reads what it wrote and answers again.
        const ownScopes = writtenScopes(failedRunning, draft.id);
        expect(ownScopes).toHaveLength(1);
        expect(writtenScopes(failedRunning, disabled.id)).toEqual(ownScopes);

        expect(await stored(found, [...start, "disabled"])).toBe(false);
        expect(await stored(found, [...address, "style", "display"])).toBe(
          "block",
        );
      });
    });
  }
});
