/**
 * Holds delivery of an existing Home root while Wish selects a profile or
 * starts the real profile-creation pattern. Observes caller and deferred setup
 * commits independently; loaded-Home cases are controls.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type ClientMessage,
  decodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { defer } from "@commonfabric/utils/defer";

import type { JSONSchema } from "../../src/builder/types.ts";
import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { resolveEntryIdentity } from "../../src/harness/entry-identity.ts";
import { getMetaLink } from "../../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import type { SessionFactory } from "../../src/storage/v2.ts";
import { TestStorageManager } from "../memory-v2-test-utils.ts";

const user = await Identity.fromPassphrase("local profile cold-link consumer");
const board = await Identity.fromPassphrase("local profile cold-link board");
const persona = await Identity.fromPassphrase(
  "local profile cold-link persona",
);

const profileSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    avatar: { type: "string" },
    initialNameApplied: { type: "string" },
  },
  required: ["name", "avatar"],
  ifc: { confidentiality: ["local-profile"] },
};

/** Helper for cold reads, which uses explicit CFC enforcement on a client. */
const makeRuntime = (storageManager: Runtime["storageManager"]) =>
  new Runtime({
    apiUrl: new URL("https://example.invalid"),
    storageManager,
    experimental: {
      serverExecution: false,
      computedCellIds: true,
      lazyMaterialization: true,
      contentAddressedSchemas: true,
      readerSchemaPrecedence: true,
      modernCellRep: false,
      commitPreconditions: true,
      plainResultReceipts: true,
    },
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "off",
    cfcWriteFloor: "off",
    cfcTriggerReadGating: false,
    cfcDecomposedEnvelopes: false,
    cfcPolicyEvaluation: "off",
    cfcLabelMetadataProtection: "off",
    cfcDeclaredMonotonicity: "off",
  });

const route = "/api/patterns/system/";

/** Helper for the source server stub, which reads the real system pattern. */
const readPattern = (name: string) =>
  Deno.readTextFileSync(
    new URL("../../../patterns/system/" + name, import.meta.url),
  );

const homeSchema: JSONSchema = {
  type: "object",
  properties: { profiles: { type: "array", items: true } },
  ifc: { confidentiality: ["local-profile"] },
};

describe("wish-home-readiness", () => {
  for (const profilePresent of [true, false]) {
    for (const delayHome of ["root", "none"] as const) {
      for (const coldHelper of [false, true]) {
        if (coldHelper && delayHome !== "root") continue;
        it(`starts profile creation only after Home confirms (profile=${profilePresent}, delayedHome=${delayHome}, coldHelper=${coldHelper})`, async () => {
          const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
          const seedManager = EmulatedStorageManager.connectTo(server, {
            as: user,
          });
          const seed = makeRuntime(seedManager);
          const homeRootId =
            seed.getHomeSpaceCell().getAsNormalizedFullLink().id;
          const homeRequested = defer<void>();
          const homeReleased = defer<void>();
          let held = delayHome !== "none";
          const factory: SessionFactory = {
            async create(space, signer, options = {}) {
              const base = loopback(server);
              const client = await connect({
                transport: {
                  ...base,
                  async send(payload) {
                    const message = decodeMemoryBoundary(
                      payload,
                    ) as ClientMessage;
                    const roots = message.type === "graph.query"
                      ? message.query.roots
                      : message.type === "session.watch.add" ||
                          message.type === "session.watch.set"
                      ? message.watches.flatMap((watch) =>
                        watch.kind === "operation" ? [] : watch.query.roots
                      )
                      : [];
                    if (
                      held && space === user.did() &&
                      roots.some((root) => root.id === homeRootId)
                    ) {
                      homeRequested.resolve();
                      await homeReleased.promise;
                    }
                    await base.send(payload);
                  },
                },
              });
              const session = await client.mount(
                space,
                options,
                (_space, _session, context) => ({
                  invocation: {
                    aud: context.audience,
                    challenge: context.challenge.value,
                  },
                  authorization: { principal: signer?.did() },
                }),
              );
              return { client, session };
            },
          };
          const manager = TestStorageManager.create({
            as: user,
            memoryHost: new URL("memory://"),
          }, factory);
          const runtime = makeRuntime(manager);
          const cancels: (() => void)[] = [];
          const originalFetch = globalThis.fetch;
          const createIdentity = await resolveEntryIdentity(
            route + "profile-create.tsx",
            (module) =>
              Promise.resolve(readPattern(module.slice(route.length))),
          );
          const program = {
            main: route + "profile-create.tsx",
            files: [
              {
                name: route + "profile-create.tsx",
                contents: readPattern("profile-create.tsx"),
              },
              {
                name: route + "profile-home.tsx",
                contents: readPattern("profile-home.tsx"),
              },
            ],
          };
          globalThis.fetch = ((input: Request | URL | string) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.pathname === route + "profile-create.tsx") {
              return Promise.resolve(
                new Response(
                  url.searchParams.has("identity")
                    ? createIdentity
                    : readPattern("profile-create.tsx"),
                ),
              );
            }
            if (url.pathname === route + "profile-home.tsx") {
              return Promise.resolve(
                new Response(readPattern("profile-home.tsx")),
              );
            }
            return Promise.resolve(new Response("not found", { status: 404 }));
          }) as typeof fetch;
          try {
            const profile = seed.getCell(persona.did(), "profile-result");
            const homeDefault = seed.getCell(user.did(), "home-result");
            const parent = seed.getCell(board.did(), "consumer");
            const inputs = seed.getCell(board.did(), "wish-inputs");
            const state = seed.getCell(board.did(), {
              wish: { state: [parent] },
            });
            const helper = seed.getCell(board.did(), {
              wish: { profileCreatePattern: [parent], user: user.did() },
            });
            let tx = seed.edit();
            profile.withTx(tx).asSchema(profileSchema).set({
              name: "Synthetic profile",
              avatar: "",
              initialNameApplied: "Synthetic profile",
            });
            profile.withTx(tx).setMetaRaw(
              "schema",
              profileSchema,
              rawMetaWriteAuthorization,
            );
            seed.prepareTxForCommit(tx);
            expect((await tx.commit()).error).toBeUndefined();
            tx = seed.edit();
            homeDefault.withTx(tx).asSchema(homeSchema).set({ profiles: [] });
            homeDefault.withTx(tx).setMetaRaw(
              "schema",
              homeSchema,
              rawMetaWriteAuthorization,
            );
            seed.getHomeSpaceCell(tx).asSchema(undefined).setRaw({
              defaultPattern: homeDefault.getAsLink(),
            });
            seed.prepareTxForCommit(tx);
            expect((await tx.commit()).error).toBeUndefined();
            tx = seed.edit();
            parent.withTx(tx).set({});
            inputs.withTx(tx).set({
              query: "#profile",
              headless: true,
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  avatar: { type: "string" },
                },
              },
            });
            seed.prepareTxForCommit(tx);
            expect((await tx.commit()).error).toBeUndefined();
            for (const rt of [seed, runtime]) {
              await rt.patternManager.compilePattern(program, {
                space: board.did(),
              });
              await rt.patternManager.flushCompileCacheWrites();
            }
            const seedAction = wish(
              inputs as Cell<[unknown, unknown]>,
              () => {},
              (cancel) => cancels.push(cancel),
              [parent],
              parent,
              seed,
            );
            const seedWish = seed.edit();
            seedAction.action(
              seedWish,
            );
            seed.prepareTxForCommit(seedWish);
            expect((await seedWish.commit()).error).toBeUndefined();
            await seed.idle();
            await helper.pull();

            expect(helper.key("$NAME").get()).toBe("Create Profile");
            const addProfile = seed.edit();
            homeDefault.withTx(addProfile).key("profiles").set(
              profilePresent ? [profile.getAsLink()] : [],
            );
            seed.prepareTxForCommit(addProfile);
            expect((await addProfile.commit()).error).toBeUndefined();
            const warmWish = seed.edit();
            seedAction.action(
              warmWish,
            );
            seed.prepareTxForCommit(warmWish);
            expect((await warmWish.commit()).error).toBeUndefined();
            await seedManager.synced();
            const input = runtime.getCellFromLink(
              inputs.getAsNormalizedFullLink(),
            );
            const owner = runtime.getCellFromLink(
              parent.getAsNormalizedFullLink(),
            );
            const stateCell = runtime.getCellFromLink({
              ...state.getAsNormalizedFullLink(),
              scope: "user",
            });
            const helperCell = runtime.getCellFromLink(
              helper.getAsNormalizedFullLink(),
            );
            const startFailures: Parameters<
              NonNullable<Runtime["pieceStartCommitFailureObserver"]>
            >[0][] = [];
            runtime.pieceStartCommitFailureObserver = (event) =>
              startFailures.push(event);
            const metadata = seed.edit();
            expect(
              readStoredCfcMetadata(
                metadata,
                homeDefault.getAsNormalizedFullLink(),
              ),
            ).toBeDefined();
            expect(
              readStoredCfcMetadata(
                metadata,
                seed.getHomeSpaceCell().getAsNormalizedFullLink(),
              ),
            ).toBeUndefined();
            expect(
              readStoredCfcMetadata(
                metadata,
                seed.getCellFromLink(getMetaLink(helper, "argument")!)
                  .getAsNormalizedFullLink(),
              ),
            ).toBeDefined();
            metadata.abort();
            const helperIsRunning = () =>
              [...runtime.runner.cancels.keys()]
                .some((key) =>
                  key.endsWith(helperCell.getAsNormalizedFullLink().id)
                );
            const helperCommits: { error?: string }[] = [];
            const originalRun = runtime.runner.run.bind(runtime.runner);

            runtime.runner.run = (...args) => {
              const runTx = args[0];
              if (runTx === undefined) {
                throw new Error("The sidecar must supply a transaction");
              }
              runTx.addVerdictCallback((_tx, result) => {
                helperCommits.push({ error: result.error?.name });
              });
              const result = originalRun(...args);

              return result;
            };
            await Promise.all([
              input.sync(),
              owner.sync(),
              stateCell.sync(),
              ...(coldHelper ? [] : [helperCell.sync()]),
              runtime.getCell(board.did(), {
                wish: { profileCreatePatternReady: [owner], user: user.did() },
              }).sync(),
              runtime.getCellFromLink(profile.getAsNormalizedFullLink()).sync(),
            ]);
            if (delayHome === "none") {
              await Promise.all([
                runtime.getHomeSpaceCell().sync(),
                runtime.getCellFromLink(homeDefault.getAsNormalizedFullLink())
                  .sync(),
              ]);
            }
            if (coldHelper) {
              const cold = runtime.edit();
              expect(cold.readOrThrow({
                ...helperCell.getAsNormalizedFullLink(),
                path: [],
              })).toBeUndefined();
              cold.abort();
            }
            let output: unknown;
            const action = wish(
              input as Cell<[unknown, unknown]>,
              (_tx, value) => {
                output = value;
              },
              (cancel) => cancels.push(cancel),
              [owner],
              owner,
              runtime,
            );
            const firstAttempt = defer<void>();
            const published = defer<void>();
            const attempts: { error?: string }[] = [];
            const scheduled = (
              tx: Parameters<typeof runtime.prepareTxForCommit>[0],
            ) => {
              action.action(tx);
              tx.addVerdictCallback((_tx, result) => {
                attempts.push({ error: result.error?.name });
                firstAttempt.resolve();
                if (!result.error && output !== undefined) published.resolve();
              });
            };
            action.onActionRegistered?.(scheduled);
            cancels.push(
              runtime.scheduler.subscribe(scheduled, { isEffect: true }),
            );
            await firstAttempt.promise;
            expect(attempts[0].error).toBeUndefined();
            if (delayHome === "root") {
              await homeRequested.promise;
              expect(output).toBeUndefined();
              expect(helperCommits).toHaveLength(0);
            }
            held = false;
            homeReleased.resolve();
            await published.promise;
            await runtime.settled();
            expect(attempts.every((attempt) => attempt.error === undefined))
              .toBe(true);
            expect(startFailures).toHaveLength(0);
            if (profilePresent) {
              expect(stateCell.key("result").key("name").get()).toBe(
                "Synthetic profile",
              );
              expect(stateCell.key("error").get()).toBeUndefined();
            } else {
              expect(stateCell.key("error").get()).toBe(
                "No profile exists yet",
              );
              expect(helperCell.key("$NAME").get()).toBe("Create Profile");
              expect(helperIsRunning()).toBe(true);
              expect(helperCell.key("sidecarError").get()).toBeUndefined();
            }
          } finally {
            held = false;
            homeReleased.resolve();
            cancels.forEach((cancel) => cancel());
            await runtime.idle();
            await seed.idle();
            await manager.synced();
            await seedManager.synced();
            await runtime.dispose();
            await seed.dispose();
            await server.close();
            globalThis.fetch = originalFetch;
          }
        });
      }
    }
  }
});
