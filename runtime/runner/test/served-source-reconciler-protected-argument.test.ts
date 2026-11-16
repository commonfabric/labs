/**
 * Follows a system release from passive demand on a restarted serving host.
 * A retained argument's current-principal claim belongs to its original
 * author; actorless source reconciliation preserves it and its value.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/js-values/types";
import { read } from "@commonfabric/memory/v2/engine";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { servingRuntimeFactory } from "../src/executor/serving-runtime.ts";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
  systemPatternSource,
} from "../src/index.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_SESSION_OPEN_AUDIENCE } from "./memory-v2-test-utils.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";

const route = "/api/patterns/system/guarded-note.tsx";
const origin = systemPatternSource("system/guarded-note.tsx");
/** The public state contract stays fixed while the release changes its output. */
const sourceFor = (scoped: boolean): string => `
import {
  AuthoredByCurrentUser,
  handler,
  pattern,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
const retitle = handler<
  { title: string },
  { about: Writable<{ title: string } | undefined> }
>(({ title }, { about }) => about.set({ title }));
interface Input {
  about?: AuthoredByCurrentUser<
    WriteAuthorizedBy<{ title: string }, typeof retitle>
  >;
}
export default pattern<Input>(({ about }) => {
  ${scoped ? 'const draft = new Writable.perSession("Draft text");' : ""}
  return {
    about,
    retitle: retitle({ about }),
    release: 1,
    ${scoped ? "draft," : ""}
  };
});
`;

const resultSchema = {
  type: "object",
  properties: {
    about: { type: "object", properties: { title: { type: "string" } } },
    release: { type: "number" },
    draft: { type: "string" },
    retitle: { asCell: ["stream"] },
  },
} as const;

/** Reads a plain stored record's path without interpreting its cell links. */
function at(value: unknown, ...path: string[]): unknown {
  for (const key of path) {
    if (!isPlainObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

describe("served source reconciliation with a protected argument", () => {
  for (const scoped of [false, true]) {
    it(`preserves authored data and writer authority${scoped ? " with a per-session default" : ""}`, async () => {
      const previous = sourceFor(scoped);
      const current = previous.replace("release: 1", "release: 2");
      await using cleanup = new AsyncDisposableStack();
      const directory = await Deno.makeTempDir({
        prefix: "served-source-update-",
      });
      cleanup.defer(() => Deno.remove(directory, { recursive: true }));
      const owner = await Identity.fromPassphrase("served source update owner");
      const service = await Identity.fromPassphrase(
        "served source update service",
      );
      const apiUrl = new URL("https://source-update.test");
      const previousIdentity = await resolveEntryIdentity(
        route,
        () => Promise.resolve(previous),
      );
      const currentIdentity = await resolveEntryIdentity(
        route,
        () => Promise.resolve(current),
      );
      let offered = { contents: previous, identity: previousIdentity };
      const fetchSource: typeof fetch = (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return Promise.resolve(
          url.pathname === route
            ? new Response(
              url.searchParams.has("identity")
                ? offered.identity
                : offered.contents,
            )
            : new Response("not found", { status: 404 }),
        );
      };
      const startServer = () => {
        const server = new Server({
          authorizeSessionOpen: authorizeLoopbackSessionOpen,
          sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
          store: toFileUrl(`${directory}/`),
          acl: { mode: "enforce", delegatingDids: [service.did()] },
          namesInstances: namesInstancesByDefault,
        });
        const host = new ExecutorHost({
          server,
          serviceIdentity: service.did(),
          ensureSpaceRoots: false,
          createRuntime: servingRuntimeFactory({
            server,
            identity: service,
            apiUrl,
            fetch: fetchSource,
          }),
        });
        return {
          server,
          host,
          close: async () => {
            await host.close();
            await server.close();
          },
        };
      };
      let serving = startServer();
      cleanup.defer(() => serving.close());
      const startClient = () =>
        new Runtime({
          apiUrl,
          storageManager: EmulatedStorageManager.connectTo(serving.server, {
            as: owner,
          }),
          experimental: { serverExecution: true },
          fetch: fetchSource,
        });
      let client = startClient();
      cleanup.defer(() => client.dispose());
      const space = await client.createSpace({ owner: owner.did() });
      const pattern = await client.patternManager.compilePattern({
        main: route,
        files: [{ name: route, contents: previous }],
      }, { space });
      const note = client.getCell(space, "guarded-note", pattern.resultSchema);
      const setup = client.edit();
      client.runner.run(setup, pattern, {}, note, { sourceOrigin: origin });
      client.prepareTxForCommit(setup);
      expect((await setup.commit().settled).error).toBeUndefined();
      await note.pull();
      const authored = client.edit();
      note.withTx(authored).key("retitle").send({ title: "Retained text" });
      client.prepareTxForCommit(authored);
      expect((await authored.commit().settled).error).toBeUndefined();
      const argument = note.getArgumentCell()!.getAsNormalizedFullLink();
      let engine = await serving.server.engineForSpace(space);
      await awaitAdmitted(
        serving.server,
        () =>
          at(read(engine, { id: argument.id }), "value", "about", "title") ===
            "Retained text",
      );
      await client.idle();
      await client.storageManager.synced();
      const before = read(engine, { id: argument.id })!;
      expect(before.value).toMatchObject({ about: { title: "Retained text" } });
      expect(at(before, "cfc", "labelMap")).toMatchObject({
        entries: [{
          path: ["about"],
          label: { integrity: [{ kind: "authored-by", subject: owner.did() }] },
        }],
      });
      expect(getPatternIdentityRef(note)?.identity).toBe(previousIdentity);
      const address = note.getAsNormalizedFullLink();
      // The release's artifact is deployed before its origin is offered. The
      // piece still runs its predecessor over the already-authored argument.
      await client.patternManager.compilePattern({
        main: route,
        files: [{ name: route, contents: current }],
      }, { space });
      expect(getPatternIdentityRef(note)?.identity).toBe(previousIdentity);
      await client.storageManager.synced();
      await client.dispose();
      await serving.close();

      offered = { contents: current, identity: currentIdentity };
      serving = startServer();
      client = startClient();
      engine = await serving.server.engineForSpace(space);
      const reopened = client.getCellFromLink({
        ...address,
        schema: resultSchema,
      });
      const cancel = reopened.sink(() => {});
      cleanup.defer(cancel);
      await client.idle();
      await client.storageManager.pullOpenSpacesToHead();
      await serving.host.whenQuiescent();
      await client.storageManager.pullOpenSpacesToHead();
      await reopened.sync();
      expect(
        client.scheduler.getGraphSnapshot().nodes.filter((node) =>
          node.type === "computation"
        ),
      ).toHaveLength(0);
      expect(serving.host.stats().originFollows).toBeGreaterThan(0);
      expect(getPatternIdentityRef(reopened)?.identity).toBe(currentIdentity);
      const after = read(engine, { id: argument.id })!;
      expect(after.value).toEqual(before.value);
      expect(at(after, "cfc", "labelMap")).toEqual(
        at(before, "cfc", "labelMap"),
      );
      expect(await reopened.key("release").pull()).toBe(2);
      if (scoped) expect(await reopened.key("draft").pull()).toBe("Draft text");

      // Bookkeeping may replay the unchanged argument, but cannot author a
      // replacement for a field guarded by the pattern's writer and principal.
      const refused = await serving.host.runLifecycleVerb(space, {
        name: "unauthorized-retitle",
        run: (runtime) =>
          runtime.editWithRetry((tx) => {
            runtime.stampServerRun(tx, {
              actionId: "test/unauthorized-retitle",
              kind: "bookkeeping",
              directCommit: true,
            });
            runtime.getCellFromLink(argument).withTx(tx).key("about").set({
              title: "Unattributed replacement",
            });
          }),
      });
      expect(refused.error?.name).toBe("CfcCommitRefusalError");
      expect(read(engine, { id: argument.id })).toEqual(after);

      const eventsBefore = serving.host.stats().events.processed;
      const edit = client.edit();
      reopened.withTx(edit).key("retitle").send({ title: "Successor text" });
      client.prepareTxForCommit(edit);
      expect((await edit.commit().settled).error).toBeUndefined();
      await awaitAdmitted(
        serving.server,
        () =>
          at(read(engine, { id: argument.id }), "value", "about", "title") ===
            "Successor text",
      );
      await serving.host.whenQuiescent();
      expect(serving.host.stats().events.processed).toBeGreaterThan(
        eventsBefore,
      );
      expect(at(read(engine, { id: argument.id }), "cfc", "labelMap")).toEqual(
        at(before, "cfc", "labelMap"),
      );
    });
  }
});
