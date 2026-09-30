// OW34-family: per-run CFC trust attribution for served execution
// (serving-loop.md §3c; the design of record is
// docs/history/plans/server-execution-v2/optimize/ow34-attribution-design.md,
// RULED 2026-08-21). A served run's transaction carries a trust snapshot
// naming the run's ACTING principal — the event's server-stamped `firedAt`
// actor, a demanded derivation's demand-supplied principal, or a delegated
// carriage's actor — never the serving runtime's ambient service identity.
// The pins here are the design's §9 acceptance rows:
//
// - §9-1 the FLAG-5 mint (watched RED at base, where the persisted
//   authored-by / represents-principal subjects were the SERVICE DID —
//   the stage-C rootcause §2a store shape) plus the INV-E negative arms:
//   a schema-authored literal-DID current-principal claim still refuses,
//   and an unprivileged direct ["cfc"] write is still the S18 forgery
//   refusal, both surfacing as the served entry's error consequence;
// - §9-2 per-wave multi-principal: two users' handler runs mint each
//   run's own user, and both commits recheck clean (a digest mismatch
//   would refuse the commit and error the entry — OW54's surfacing);
// - §9-3 replay: a re-drained entry (first commit-preparation attempt failed)
//   mints from the DURABLE entry's actor, and a second host activation re-runs
//   nothing and leaves the persisted labels byte-identical;
// - §9-4 the stamp seam's precedence, pinned on the LIVE stamper:
//   delegated carriage wins, a handler's acting next, a demanded
//   derivation's principal next (the Q2 arm), and an actor-less run
//   keeps the ambient service snapshot (the Q3 ruling);
// - §9-5 OFF-arm neutrality: no stamper means no snapshot call — the
//   OFF client and the flag-ON client speculation both leave the
//   edit()-attached ambient snapshot untouched;
// - INV-G: `trustSnapshotForPrincipal` composes the same revision as the
//   default provider, config digest included, so a trust-config change
//   invalidates per-run served digests exactly as ambient ones.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { StreamEventsDocValue } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CfcTrustConfigInput } from "../src/cfc/trust.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const spaceSigner = await Identity.fromPassphrase("trust attribution space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "trust attribution service",
);
const aliceSigner = await Identity.fromPassphrase("trust attribution alice");
const bobSigner = await Identity.fromPassphrase("trust attribution bob");

/** The TRUE sidecar doc ids in the store (see executor-events-down: the
 * client derives the id from the RESOLVED stream link, so tests read the
 * ids back from the head prefix rather than re-deriving them). */
const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

// The authored vocabulary, in the explicit-schema form the compiled
// `AuthoredByCurrentUser` / `RepresentsCurrentUser` wrappers lower to
// (packages/api/cfc.ts): a current-principal placeholder subject under
// `addIntegrity`, gated by `writeAuthorizedBy` + a `uiContract` that a
// renderer-trusted event must match (cfc/prepare.ts's non-owner arm).
const TRUSTED_WRITER = "test.ow34-trusted-writer";
const UI_CONTRACT = {
  helper: "UiAction",
  action: "Ow34Send",
  trustedPattern: "Ow34Chat",
  requiredEventIntegrity: ["Ow34Chat"],
};
const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

const authoredDocSchema: JSONSchema = {
  type: "object",
  properties: {
    body: {
      type: "string",
      ifc: {
        addIntegrity: [{ kind: "authored-by", subject: CURRENT_PRINCIPAL }],
        writeAuthorizedBy: [TRUSTED_WRITER],
        uiContract: UI_CONTRACT,
      },
    },
    claim: {
      type: "string",
      ifc: {
        addIntegrity: [
          { kind: "represents-principal", subject: CURRENT_PRINCIPAL },
        ],
        writeAuthorizedBy: [TRUSTED_WRITER],
        uiContract: UI_CONTRACT,
      },
    },
  },
} as JSONSchema;

// INV-E arm (i): the same shape with a LITERAL DID subject — refused at
// authoring ("subject must be runtime resolved"), served or not.
const literalDidSchema = (did: string): JSONSchema =>
  ({
    type: "object",
    properties: {
      body: {
        type: "string",
        ifc: {
          addIntegrity: [{ kind: "authored-by", subject: did }],
          writeAuthorizedBy: [TRUSTED_WRITER],
          uiContract: UI_CONTRACT,
        },
      },
    },
  }) as JSONSchema;

/** A fire payload carrying the trusted-DOM provenance the uiContract
 * requires, renderer-trust MARKED (the WeakSet attestation; the durable
 * entry carries it as `rendererTrusted: true` and the served dispatch
 * re-marks the payload — the OW34 sister-mark carriage). */
const trustedPayload = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const payload = {
    ...extra,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "Ow34Chat",
        eventIntegrity: ["Ow34Chat"],
        uiContractDataset: { uiAction: "Ow34Send" },
      },
    },
  };
  markRendererTrustedEvent(payload);
  return payload;
};

type LabelMapEntry = {
  path?: unknown[];
  label?: {
    integrity?: Array<{ kind?: string; subject?: string } | string>;
  };
};

/** The DURABLE current-principal subjects of one kind on a stored doc
 * RECORD (`Engine.read(engine, { id })` — the `["cfc"]` envelope is a
 * sibling of the record's `value`). Both atom forms — object and
 * `"kind:subject"` string — per the verifier's reading in
 * cf-cfc-authorship. */
const principalSubjects = (
  record: unknown,
  kind: "authored-by" | "represents-principal",
): string[] => {
  const entries =
    (record as { cfc?: { labelMap?: { entries?: LabelMapEntry[] } } })
      ?.cfc?.labelMap?.entries ?? [];
  const subjects: string[] = [];
  for (const entry of entries) {
    for (const atom of entry.label?.integrity ?? []) {
      if (typeof atom === "string") {
        if (atom.startsWith(`${kind}:`)) {
          subjects.push(atom.slice(kind.length + 1));
        }
      } else if (atom?.kind === kind && typeof atom.subject === "string") {
        subjects.push(atom.subject);
      }
    }
  }
  return subjects;
};

describe("executor-trust-attribution", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager | undefined;
  let clientRuntime: Runtime | undefined;
  let extraManagers: EmulatedStorageManager[];
  let extraRuntimes: Runtime[];
  let servingRuntime: Runtime | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        servingRuntime = runtime;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    extraManagers = [];
    extraRuntimes = [];
    servingRuntime = undefined;
    clientManager = undefined;
    clientRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of extraRuntimes) await runtime.dispose();
    for (const manager of extraManagers) await manager.close();
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = (
    signer: Identity = aliceSigner,
  ): { manager: EmulatedStorageManager; runtime: Runtime } => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    return { manager, runtime };
  };

  /** Compile + run the bump pattern on `runtime`, returning its cells. */
  const standUp = async (
    runtime: Runtime,
    names: { arg: string; result: string },
  ) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: BUMP_PATTERN }],
    }, { space });
    const argument = runtime.getCell<{ value: number }>(
      space,
      names.arg,
      undefined,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      names.result,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = runtime.edit();
      argument.withTx(seed).set({ value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { compiled, argument, result };
  };

  /** Warm the serving loop for one stream: stand the pattern up on the
   * client, demand it, start the host, fire one plain warm-up event to
   * completion, and return the durable stream link (for probes) and the
   * sidecar id. The warm-up also puts the piece's own handler behind us:
   * a probe registered on the SAME stream ref afterwards REPLACES it
   * (addSchedulerEventHandler's same-ref replacement), so each later
   * entry runs exactly the probe — one entry, one run. */
  const warmServedStream = async (names: { arg: string; result: string }) => {
    ({ manager: clientManager, runtime: clientRuntime } = openClient());
    const engine = await server.engineForSpace(space);
    const { compiled, argument, result } = await standUp(clientRuntime, names);
    const cancelDemand = result.sink(() => {});
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    host = newHost();
    result.key("bump").send({ kind: "warmup" });
    await clientRuntime.idle();
    await clientRuntime.storageManager.synced();
    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    await awaitAdmitted(server, () => {
      const value = Engine.read(engine, { id: sidecarId })?.value as
        | StreamEventsDocValue
        | undefined;
      return value?.entries?.[0]?.consequenced === true;
    });
    expect(host!.spaceServer(space)?.active).toBe(true);
    expect(servingRuntime).toBeDefined();
    const entry = (Engine.read(engine, { id: sidecarId })
      ?.value as StreamEventsDocValue).entries![0];
    const streamLink = {
      space,
      id: entry.stream.id as never,
      path: [...entry.stream.path],
      scope: (entry.stream.scope ?? "space") as never,
    };
    return {
      engine,
      compiled,
      argument,
      result,
      cancelDemand,
      sidecarId,
      streamLink,
    };
  };

  const entriesIn = (
    engine: Engine.Engine,
    sidecarId: string,
  ): NonNullable<StreamEventsDocValue["entries"]> =>
    (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
      .entries ?? [];

  const entryByKind = (
    engine: Engine.Engine,
    sidecarId: string,
    kind: string,
  ) =>
    entriesIn(engine, sidecarId).find((entry) =>
      (entry.payload as { kind?: string } | undefined)?.kind === kind
    );

  describe("§9-1 the FLAG-5 mint", () => {
    it("persists the entry's firedAt.user as the authored-by and represents-principal subject on a served handler run's docs — never the service DID (WATCHED RED AT BASE: both subjects were the service signer)", async () => {
      const { engine, cancelDemand, sidecarId, streamLink, result } =
        await warmServedStream({
          arg: "flag5-arg",
          result: "flag5-result",
        });
      const serving = servingRuntime!;
      const cancelProbe = serving.scheduler.addEventHandler(
        (tx, event) => {
          const docName = (event as { doc?: string })?.doc ?? "flag5-doc";
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: TRUSTED_WRITER,
          });
          serving.getCell(space, docName, authoredDocSchema, tx).set({
            body: "hello from a served run",
            claim: "profile claim from a served run",
          });
        },
        streamLink,
      );
      try {
        result.key("bump").send(
          trustedPayload({ kind: "authored", doc: "flag5-doc" }),
        );
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "authored")?.consequenced ===
              true,
        );
        const entry = entryByKind(engine, sidecarId, "authored")!;
        expect(entry.error).toBeUndefined();
        expect(entry.firedAt?.user).toBe(aliceSigner.did());

        // The doc id is name-derived, so the client mints the same link.
        const docId = clientRuntime!.getCell(space, "flag5-doc", undefined)
          .getAsNormalizedFullLink().id;
        await awaitAdmitted(
          server,
          () => Engine.read(engine, { id: docId })?.value !== undefined,
        );
        const record = Engine.read(engine, { id: docId });

        // THE PIN (INV-A / INV-D): the durable subjects are the ACTING
        // user from the entry's server-stamped firedAt. At base both
        // were the service DID (FLAG-5; rootcause §2a's store shape).
        expect(principalSubjects(record, "authored-by")).toEqual([
          aliceSigner.did(),
        ]);
        expect(principalSubjects(record, "represents-principal")).toEqual([
          aliceSigner.did(),
        ]);
        expect(principalSubjects(record, "authored-by")).not.toContain(
          serviceSigner.did(),
        );
        expect(
          principalSubjects(record, "represents-principal"),
        ).not.toContain(serviceSigner.did());
      } finally {
        cancelProbe();
        cancelDemand();
      }
    });

    it("still refuses a schema-authored literal-DID current-principal claim on the served path, and the refusal is the entry's error consequence (INV-E)", async () => {
      const { engine, cancelDemand, sidecarId, streamLink, result } =
        await warmServedStream({
          arg: "inve-lit-arg",
          result: "inve-lit-result",
        });
      const serving = servingRuntime!;
      const cancelProbe = serving.scheduler.addEventHandler(
        (tx, _event) => {
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: TRUSTED_WRITER,
          });
          serving.getCell(
            space,
            "inve-literal-doc",
            literalDidSchema(aliceSigner.did()),
            tx,
          ).set({ body: "forged literal claim" });
        },
        streamLink,
      );
      try {
        result.key("bump").send(trustedPayload({ kind: "literal" }));
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        // OW54's surfacing: the CFC pre-storage refusal seals an ERROR
        // consequence; the entry advances carrying the refusal.
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "literal")?.consequenced ===
              true,
        );
        const entry = entryByKind(engine, sidecarId, "literal")!;
        expect(entry.error).toContain("CFC enforcement rejected commit");
        expect(entry.error).toContain("must be runtime resolved");
        // Nothing persisted: the forged claim never reached the store.
        const docId = clientRuntime!.getCell(
          space,
          "inve-literal-doc",
          undefined,
        ).getAsNormalizedFullLink().id;
        expect(Engine.read(engine, { id: docId })?.value).toBeUndefined();
      } finally {
        cancelProbe();
        cancelDemand();
      }
    });

    it("still fails an unprivileged direct ['cfc'] write closed as the S18 forgery refusal on the served path (INV-E)", async () => {
      const { engine, cancelDemand, sidecarId, streamLink, result } =
        await warmServedStream({
          arg: "inve-s18-arg",
          result: "inve-s18-result",
        });
      const serving = servingRuntime!;
      const targetId = clientRuntime!.getCell(space, "s18-doc", undefined)
        .getAsNormalizedFullLink().id;
      const cancelProbe = serving.scheduler.addEventHandler(
        (tx, event) => {
          const kind = (event as { kind?: string })?.kind;
          if (kind === "s18-setup") {
            // A LEGIT mint first, so the doc holds a well-formed
            // envelope for the forgery to target.
            setCfcImplementationIdentity(tx, {
              kind: "builtin",
              builtinId: TRUSTED_WRITER,
            });
            serving.getCell(space, "s18-doc", authoredDocSchema, tx).set({
              body: "honest message",
              claim: "honest claim",
            });
            return;
          }
          // The forgery: a DIRECT label rewrite on the stored envelope,
          // outside any privileged scope — swap the honest subjects for
          // Bob's without any run acting as Bob.
          tx.writeOrThrow(
            {
              space,
              id: targetId,
              type: "application/json",
              path: ["cfc", "labelMap", "entries"],
            },
            {
              value: [{
                path: ["body"],
                label: {
                  integrity: [{
                    kind: "authored-by",
                    subject: bobSigner.did(),
                  }],
                },
                origin: "declared",
              }],
            },
          );
        },
        streamLink,
      );
      try {
        result.key("bump").send(
          trustedPayload({ kind: "s18-setup" }),
        );
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "s18-setup")?.consequenced === true,
        );
        expect(
          principalSubjects(
            Engine.read(engine, { id: targetId }),
            "authored-by",
          ),
        ).toEqual([aliceSigner.did()]);

        result.key("bump").send(trustedPayload({ kind: "s18-forge" }));
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "s18-forge")?.consequenced === true,
        );
        const entry = entryByKind(engine, sidecarId, "s18-forge")!;
        expect(entry.error).toContain("CFC enforcement rejected commit");
        expect(entry.error).toContain(
          "unprivileged write to protected runtime surface",
        );
        // The stored envelope is untouched: the honest subjects survive.
        expect(
          principalSubjects(
            Engine.read(engine, { id: targetId }),
            "authored-by",
          ),
        ).toEqual([aliceSigner.did()]);
      } finally {
        cancelProbe();
        cancelDemand();
      }
    });
  });

  describe("§9-2 per-wave multi-principal", () => {
    it("mints each run's own user when two users' handler runs share a drain, and both commits recheck clean — no cross-run contamination (INV-C)", async () => {
      const { engine, compiled, cancelDemand, sidecarId, streamLink, result } =
        await warmServedStream({
          arg: "multi-arg",
          result: "multi-result",
        });
      const serving = servingRuntime!;
      const cancelProbe = serving.scheduler.addEventHandler(
        (tx, event) => {
          const docName = (event as { doc?: string })?.doc ?? "multi-doc";
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: TRUSTED_WRITER,
          });
          serving.getCell(space, docName, authoredDocSchema, tx).set({
            body: `message via ${docName}`,
            claim: `claim via ${docName}`,
          });
        },
        streamLink,
      );

      // Bob joins the same piece, reading it under its result schema,
      // which is what reaches the handler stream he sends to: the store
      // delivers the piece's document alone, and the stream behind `bump`
      // is a document of its own.
      const bob = openClient(bobSigner);
      extraManagers.push(bob.manager);
      extraRuntimes.push(bob.runtime);
      const bobResult = bob.runtime.getCell<Record<string, unknown>>(
        space,
        "multi-result",
        compiled.resultSchema,
      );
      await bobResult.sync();

      try {
        // Fired back to back with no await between, so the drain batches
        // both entries; each dispatch is its own run × tx × snapshot.
        result.key("bump").send(
          trustedPayload({ kind: "alice-msg", doc: "multi-alice-doc" }),
        );
        bobResult.key("bump").send(
          trustedPayload({ kind: "bob-msg", doc: "multi-bob-doc" }),
        );
        await clientRuntime!.idle();
        await bob.runtime.idle();
        await clientRuntime!.storageManager.synced();
        await bob.runtime.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "alice-msg")?.consequenced ===
              true &&
            entryByKind(engine, sidecarId, "bob-msg")?.consequenced === true,
        );
        const aliceEntry = entryByKind(engine, sidecarId, "alice-msg")!;
        const bobEntry = entryByKind(engine, sidecarId, "bob-msg")!;
        // Clean recheck: a cfc-prepared-digest-mismatch would have
        // refused the commit and errored the entry (OW54's surfacing).
        expect(aliceEntry.error).toBeUndefined();
        expect(bobEntry.error).toBeUndefined();
        expect(aliceEntry.firedAt?.user).toBe(aliceSigner.did());
        expect(bobEntry.firedAt?.user).toBe(bobSigner.did());

        const aliceDocId = clientRuntime!.getCell(
          space,
          "multi-alice-doc",
          undefined,
        ).getAsNormalizedFullLink().id;
        const bobDocId = clientRuntime!.getCell(
          space,
          "multi-bob-doc",
          undefined,
        ).getAsNormalizedFullLink().id;
        await awaitAdmitted(
          server,
          () =>
            Engine.read(engine, { id: aliceDocId })?.value !== undefined &&
            Engine.read(engine, { id: bobDocId })?.value !== undefined,
        );
        const aliceDoc = Engine.read(engine, { id: aliceDocId });
        const bobDoc = Engine.read(engine, { id: bobDocId });
        expect(principalSubjects(aliceDoc, "authored-by")).toEqual([
          aliceSigner.did(),
        ]);
        expect(principalSubjects(bobDoc, "authored-by")).toEqual([
          bobSigner.did(),
        ]);
        // No contamination in either direction.
        expect(principalSubjects(aliceDoc, "authored-by")).not.toContain(
          bobSigner.did(),
        );
        expect(principalSubjects(bobDoc, "authored-by")).not.toContain(
          aliceSigner.did(),
        );
      } finally {
        cancelProbe();
        cancelDemand();
      }
    });
  });

  describe("§9-3 replay", () => {
    it("mints from the DURABLE entry's actor on a re-drain after a typed commit-preparation failure, and a second activation re-runs nothing and leaves the labels byte-identical (INV-B)", async () => {
      const { engine, cancelDemand, sidecarId, streamLink, result } =
        await warmServedStream({
          arg: "replay-arg",
          result: "replay-result",
        });
      const serving = servingRuntime!;
      let dispatches = 0;
      const cancelProbe = serving.scheduler.addEventHandler(
        (tx, _event) => {
          dispatches += 1;
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: TRUSTED_WRITER,
          });
          serving.getCell(space, "replay-doc", authoredDocSchema, tx).set({
            body: "replayed message",
            claim: "replayed claim",
          });
          if (dispatches === 1) {
            // Model the typed pre-storage failure after the handler has built
            // its write. OW54 persists that failure, then grants one clean
            // retry; the re-dispatch must resolve its actor from the durable
            // entry again. The handler no longer aborts directly; the mocked
            // commit path aborts internally, mirroring the framework sealing
            // the typed CommitPreparationError before granting one clean retry.
            const error = {
              name: "CommitPreparationError" as const,
              message: "OW34 replay probe: first commit preparation failed",
              failureClass: "unknown" as const,
              permanentEvidence: false as const,
            };
            (tx as unknown as {
              commit: () => Promise<{ error: typeof error }>;
            }).commit = () => {
              tx.abort(new Error(error.message));
              return Promise.resolve({ error });
            };
          }
        },
        streamLink,
      );
      try {
        result.key("bump").send(trustedPayload({ kind: "replayed" }));
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        await awaitAdmitted(server, () =>
          dispatches >= 2 &&
          entryByKind(engine, sidecarId, "replayed")?.consequenced === true);
        const docId = clientRuntime!.getCell(space, "replay-doc", undefined)
          .getAsNormalizedFullLink().id;
        await awaitAdmitted(
          server,
          () => Engine.read(engine, { id: docId })?.value !== undefined,
        );
        const minted = Engine.read(engine, { id: docId });
        expect(principalSubjects(minted, "authored-by")).toEqual([
          aliceSigner.did(),
        ]);
        expect(principalSubjects(minted, "represents-principal")).toEqual([
          aliceSigner.did(),
        ]);

        // Second activation: the consequenced mark excludes the entry —
        // no re-run — and the persisted labels stay byte-identical.
        const labelsBefore = JSON.stringify(
          (Engine.read(engine, { id: docId }) as { cfc?: unknown })?.cfc,
        );
        const eventId = entryByKind(engine, sidecarId, "replayed")!.eventId;
        const consequenceCommitsFor = () =>
          (engine.database.prepare(
            `SELECT consequence_of FROM "commit"
             WHERE class = 'derived' AND consequence_of IS NOT NULL`,
          ).all() as Array<{ consequence_of: string }>).filter((row) =>
            row.consequence_of.includes(eventId)
          ).length;
        expect(consequenceCommitsFor()).toBe(1);
        await host!.close();
        host = newHost();
        // A fresh authored poke re-activates the space (the emulated
        // fixture keeps sessions across the host swap, so the poke
        // stands in for the reconnect — the events-down restart idiom).
        {
          const poke = clientRuntime!.edit();
          clientRuntime!.getCell<number>(space, "replay-activate", undefined)
            .withTx(poke).set(1);
          expect((await poke.commit()).error).toBeUndefined();
        }
        // Ordered barrier for the negative: append a FRESH entry on the
        // same stream and wait for ITS consequence — the drain processes
        // entries in order, so a wrong re-run of the replayed entry
        // would land its second consequence commit no later than the
        // fresh entry's. Sharper than a settle beat: a late duplicate
        // cannot slip in after the assertion.
        result.key("bump").send(trustedPayload({ kind: "replay-barrier" }));
        await clientRuntime!.idle();
        await clientRuntime!.storageManager.synced();
        await awaitAdmitted(
          server,
          () =>
            entryByKind(engine, sidecarId, "replay-barrier")?.consequenced ===
              true,
        );
        expect(host!.spaceServer(space)?.active).toBe(true);
        expect(consequenceCommitsFor()).toBe(1);
        const labelsAfter = JSON.stringify(
          (Engine.read(engine, { id: docId }) as { cfc?: unknown })?.cfc,
        );
        expect(labelsAfter).toBe(labelsBefore);
      } finally {
        cancelProbe();
        cancelDemand();
      }
    });
  });

  describe("§9-4 the stamp seam's precedence", () => {
    it("resolves the run's snapshot on the LIVE stamper: a delegated carriage's actor wins, a handler's acting next, a demanded derivation's principal next, and an actor-less run keeps the ambient service snapshot", async () => {
      const { cancelDemand } = await warmServedStream({
        arg: "seam-arg",
        result: "seam-result",
      });
      const serving = servingRuntime!;
      const stampAndRead = (info: ServerRunInfo) => {
        const tx = serving.edit();
        serving.stampServerRun(tx, info);
        const snapshot = tx.getCfcState().trustSnapshot;
        tx.abort();
        return snapshot;
      };
      try {
        // Arm 1 (§9-4 proper): the S-A delegated bookkeeping carriage
        // carries the DELEGATED acting's snapshot.
        const delegated = stampAndRead({
          actionId: "seam-delegated",
          kind: "bookkeeping",
          delegated: {
            acting: { user: aliceSigner.did(), session: "sess-seam" },
            capabilityRef: "event-consequence:e-seam",
          },
        });
        expect(delegated?.actingPrincipal).toBe(aliceSigner.did());
        expect(delegated?.id).toBe(`principal:${aliceSigner.did()}`);

        // Arm 2: a handler's explicit acting (the event's server-stamped
        // firedAt actor).
        const acting = stampAndRead({
          actionId: "seam-acting",
          kind: "event-handler",
          eventId: "e-seam-acting",
          acting: { user: bobSigner.did() },
        });
        expect(acting?.actingPrincipal).toBe(bobSigner.did());

        // Arm 2b: a handler INHERITING a demanded pair (the in-process
        // LT6 shape) carries the pair's user.
        const inherited = stampAndRead({
          actionId: "seam-inherited",
          kind: "event-handler",
          eventId: "e-seam-inherited",
          scopeKeyIdentity: {
            principal: bobSigner.did(),
            sessionId: "sess-lt6",
          } as never,
        });
        expect(inherited?.actingPrincipal).toBe(bobSigner.did());

        // Arm 3 (the Q2 derivation arm — ships, severable): a demanded
        // derivation's snapshot names the demand-supplied principal,
        // eager at stamp.
        const demanded = stampAndRead({
          actionId: "seam-demanded",
          kind: "derivation",
          scopeKeyIdentity: {
            principal: aliceSigner.did(),
            sessionId: "sess-demand",
          } as never,
          actionScopeKey: "user" as never,
        });
        expect(demanded?.actingPrincipal).toBe(aliceSigner.did());

        // Arm 4 (the Q3 ruling): actor-less runs KEEP the ambient
        // service snapshot — plain bookkeeping and the wave-fallback
        // derivation alike.
        const bookkeeping = stampAndRead({
          actionId: "seam-bookkeeping",
          kind: "bookkeeping",
        });
        expect(bookkeeping?.actingPrincipal).toBe(serviceSigner.did());
        const fallback = stampAndRead({
          actionId: "seam-fallback",
          kind: "derivation",
        });
        expect(fallback?.actingPrincipal).toBe(serviceSigner.did());

        // The revision is the serving runtime's own trust revision on
        // every arm — one composition site (INV-G's seam half).
        const ambient = serving.trustSnapshotProvider()!;
        for (const snapshot of [delegated, acting, inherited, demanded]) {
          expect(snapshot?.revision).toBe(ambient.revision);
        }
      } finally {
        cancelDemand();
      }
    });
  });

  describe("§9-5 OFF-arm neutrality", () => {
    it("leaves the edit()-attached ambient snapshot untouched on an OFF client — stampServerRun stamps nothing", async () => {
      const manager = StorageManager.emulate({ as: aliceSigner });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
      });
      try {
        const tx = runtime.edit();
        const before = tx.getCfcState().trustSnapshot;
        expect(before?.actingPrincipal).toBe(aliceSigner.did());
        runtime.stampServerRun(tx, {
          actionId: "off-run",
          kind: "event-handler",
          eventId: "e-off",
          acting: { user: bobSigner.did() },
        });
        const after = tx.getCfcState().trustSnapshot;
        expect(after).toEqual(before);
        expect(after?.actingPrincipal).toBe(aliceSigner.did());
        tx.abort();
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });

    it("leaves the snapshot untouched on a flag-ON client — the speculation stamp is not a snapshot writer", async () => {
      const manager = StorageManager.emulate({ as: aliceSigner });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      try {
        const tx = runtime.edit();
        const before = tx.getCfcState().trustSnapshot;
        runtime.stampServerRun(tx, {
          actionId: "spec-run",
          kind: "event-handler",
          eventId: "e-spec",
          acting: { user: bobSigner.did() },
        });
        const after = tx.getCfcState().trustSnapshot;
        expect(after).toEqual(before);
        expect(after?.actingPrincipal).toBe(aliceSigner.did());
        tx.abort();
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });
  });

  describe("trustSnapshotForPrincipal()", () => {
    const trustConfig: CfcTrustConfigInput = {
      statements: [{
        concrete: { type: "Ow34Probe" },
        implements: "ow34/probe",
        verifier: aliceSigner.did(),
      }],
      delegations: [{
        delegator: aliceSigner.did(),
        verifier: aliceSigner.did(),
        concepts: ["ow34/probe"],
      }],
    };

    it("returns the principal's snapshot with the runtime's own revision — identical to the default provider's composition (INV-G, no trust config)", async () => {
      const manager = StorageManager.emulate({ as: aliceSigner });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
      });
      try {
        const snapshot = runtime.trustSnapshotForPrincipal(bobSigner.did());
        expect(snapshot).toEqual({
          id: `principal:${bobSigner.did()}`,
          actingPrincipal: bobSigner.did(),
          revision: runtime.id,
        });
        expect(snapshot.revision).toBe(
          runtime.trustSnapshotProvider()!.revision,
        );
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });

    it("refuses to construct a SERVING runtime with a custom trustSnapshotProvider — and the refused construction leaves NO ambient trace: a runtime built afterward is byte-identical to one built before (validate-then-apply; the guard precedes every process-global flag write)", async () => {
      const manager = StorageManager.emulate({ as: serviceSigner });
      // CONTROL: the effective experimental record before the refused
      // construction (flag-less, so it reads the ambient state through).
      const controlManager = StorageManager.emulate({ as: aliceSigner });
      const control = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: controlManager,
      });
      const controlExperimental = { ...control.experimental };
      try {
        expect(() =>
          new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            servingPosture: true,
            experimental: {
              serverExecution: true,
              // A flag whose ambient write precedes the old guard site:
              // under throw-after-apply this leaks into the process and
              // shows up in the probe below (the Cubic P1 leak).
              contentAddressedSchemas: !controlExperimental
                .contentAddressedSchemas,
            },
            trustSnapshotProvider: () => ({
              id: "custom-provider",
              actingPrincipal: serviceSigner.did(),
            }),
          })
        ).toThrow("custom trustSnapshotProvider");
        // PROBE: a flag-less runtime built AFTER the refusal must behave
        // as if the failed construction never happened — its effective
        // experimental record equals the control's.
        const probeManager = StorageManager.emulate({ as: bobSigner });
        const probe = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: probeManager,
        });
        try {
          expect(probe.experimental.contentAddressedSchemas).toBe(
            controlExperimental.contentAddressedSchemas,
          );
          expect({ ...probe.experimental }).toEqual(controlExperimental);
        } finally {
          await probe.dispose();
          await probeManager.close();
        }
      } finally {
        await control.dispose();
        await controlManager.close();
        await manager.close();
      }
    });

    it("folds the trust-config digest into the revision exactly as the default provider does (INV-G, config present)", async () => {
      const manager = StorageManager.emulate({ as: aliceSigner });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        cfcTrustConfig: trustConfig,
      });
      try {
        const snapshot = runtime.trustSnapshotForPrincipal(bobSigner.did());
        expect(snapshot.revision).toContain("/trust:");
        expect(snapshot.revision).toBe(
          runtime.trustSnapshotProvider()!.revision,
        );
        expect(snapshot.revision?.startsWith(runtime.id)).toBe(true);
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });
  });
});
