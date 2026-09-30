import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { currentPrincipal } from "../src/builder/current-principal.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { principalClaimSubject } from "../src/cfc/represents-principal.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const alice = await Identity.fromPassphrase("current-principal alice");
const bob = await Identity.fromPassphrase("current-principal bob");
const service = await Identity.fromPassphrase("current-principal service");

/** A payload naming `bob` everywhere a principal could plausibly be read. */
const bobLookingPayload = {
  acting: { user: bob.did(), session: "bob-session" },
  user: bob.did(),
  principal: bob.did(),
  firedAt: { user: bob.did(), session: "bob-session" },
};

/**
 * A pattern whose handler, `computed()` and `lift()` each call
 * `currentPrincipal()`, reporting what it returned or the message it threw.
 */
const PROBE_PATTERN = [
  "import {",
  "  computed, currentPrincipal, handler, lift, pattern, Stream, Writable,",
  "} from 'commonfabric';",
  "const probe = (): string => {",
  "  try {",
  "    return `returned ${currentPrincipal()}`;",
  "  } catch (error) {",
  "    return `threw ${(error as Error).message}`;",
  "  }",
  "};",
  "const record = handler<unknown, { seen: Writable<string> }>(",
  "  (_event, { seen }) => { seen.set(probe()); },",
  ");",
  "const viaLift = lift((_n: number) => probe());",
  "export default pattern<",
  "  { seen: Writable<string> },",
  "  {",
  "    seen: string;",
  "    viaComputed: string;",
  "    viaLift: string;",
  "    record: Stream<unknown>;",
  "  }",
  ">(({ seen }) => ({",
  "  seen,",
  "  viaComputed: computed(() => probe()),",
  "  viaLift: viaLift(0),",
  "  record: record({ seen }),",
  "}));",
].join("\n");

const HANDLER_ONLY_MESSAGE = "available only in a handler";

/**
 * A document whose `body` carries an `authored-by` claim on the current
 * principal, with the writer and gesture such a claim needs to commit.
 */
const authoredSchema = {
  type: "object",
  properties: {
    body: {
      type: "string",
      ifc: {
        addIntegrity: [{
          kind: "authored-by",
          subject: { __ctCurrentPrincipal: true },
        }],
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "/writer.tsx", path: ["writeBody"] },
        },
        uiContract: {
          helper: "UiAction",
          action: "WriteBody",
          trustedPattern: "Writer",
          requiredEventIntegrity: ["Writer"],
        },
      },
    },
  },
  required: ["body"],
} as JSONSchema;

/** Runs `fn` under a pushed frame carrying `props`, and returns its result. */
function inFrame<T>(
  props: {
    runtime: Runtime;
    tx: IExtendedStorageTransaction;
    kind?: "handler" | "lift";
  },
  fn: () => T,
): T {
  const frame = pushFrame({
    runtime: props.runtime,
    tx: props.tx,
    ...(props.kind === "handler"
      ? { inHandler: true, frameKind: "handler" as const }
      : props.kind === "lift"
      ? { frameKind: "lift" as const }
      : {}),
  });
  try {
    return fn();
  } finally {
    popFrame(frame);
  }
}

describe("current-principal", () => {
  let client: Runtime;
  let clientStorage: ReturnType<typeof StorageManager.emulate>;
  let serving: Runtime;
  let servingStorage: ReturnType<typeof StorageManager.emulate>;
  let openTxs: IExtendedStorageTransaction[];

  /** Opens a transaction on `runtime` that the test aborts afterward. */
  const edit = (runtime: Runtime): IExtendedStorageTransaction => {
    const tx = runtime.edit();
    openTxs.push(tx);
    return tx;
  };

  /** Opens a serving transaction stamped as a handler run. */
  const servedHandlerTx = (
    stamp: {
      acting?: { user: string; session?: string };
      instanceOwner?: string;
    },
  ): IExtendedStorageTransaction => {
    const tx = edit(serving);
    stampWaveRunContext(
      tx,
      {
        actionId: "handler/current-principal",
        kind: "event-handler",
        eventId: "event-1",
        ...(stamp.acting !== undefined ? { acting: stamp.acting } : {}),
        ...(stamp.instanceOwner !== undefined
          ? {
            scopeKeyIdentity: {
              principal: stamp.instanceOwner,
              sessionId: "owner-session",
            },
          }
          : {}),
      },
    );
    return tx;
  };

  beforeEach(() => {
    openTxs = [];
    clientStorage = StorageManager.emulate({ as: alice });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorage,
    });
    servingStorage = StorageManager.emulate({ as: service });
    serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
    });
  });

  afterEach(async () => {
    for (const tx of openTxs) tx.abort(new Error("test-only"));
    await clientStorage.synced();
    await client.dispose();
    await clientStorage.close();
    await serving.dispose();
    await servingStorage.close();
  });

  describe("Runtime.actingPrincipalFor()", () => {
    it("returns the runtime's own user on a client runtime", () => {
      expect(client.actingPrincipalFor(edit(client))).toBe(alice.did());
    });

    it("returns the stamped actor on a serving runtime", () => {
      const tx = servedHandlerTx({
        acting: { user: bob.did(), session: "bob-session" },
      });
      expect(serving.actingPrincipalFor(tx)).toBe(bob.did());
    });

    it("returns the actor, not the instance owner, for a run on another principal's instance", () => {
      const tx = servedHandlerTx({
        acting: { user: alice.did(), session: "alice-session" },
        instanceOwner: bob.did(),
      });

      // The instance owner is what `homeSpacePrincipalFor()` returns for the
      // same run, which is what makes this case the one that tells them apart.
      expect(serving.homeSpacePrincipalFor(tx)).toBe(bob.did());
      expect(serving.actingPrincipalFor(tx)).toBe(alice.did());
    });

    it("returns `undefined` for a served run with no actor", () => {
      expect(serving.actingPrincipalFor(servedHandlerTx({}))).toBeUndefined();
      expect(serving.actingPrincipalFor(edit(serving))).toBeUndefined();
    });

    it("returns `undefined` for a served run on an instance but with no actor", () => {
      const tx = servedHandlerTx({ instanceOwner: bob.did() });
      expect(serving.actingPrincipalFor(tx)).toBeUndefined();
    });

    it("leaves the transaction's read scope at `space`", () => {
      const read = servedHandlerTx({
        acting: { user: alice.did() },
        instanceOwner: alice.did(),
      });
      expect(serving.actingPrincipalFor(read)).toBe(alice.did());
      expect(read.getNarrowestReadScope()).toBe("space");

      // The same stamp does move the read scope under the call that resolves
      // a home space, so a `space` above is not a scope that cannot move.
      const control = servedHandlerTx({
        acting: { user: alice.did() },
        instanceOwner: alice.did(),
      });
      serving.homeSpacePrincipalFor(control);
      expect(control.getNarrowestReadScope()).toBe("user");
    });
  });

  describe("currentPrincipal()", () => {
    it("returns the runtime's own user in a client handler", () => {
      const tx = edit(client);
      const principal = inFrame(
        { runtime: client, tx, kind: "handler" },
        currentPrincipal,
      );
      expect(principal).toBe(alice.did());
    });

    it("returns the stamped actor in a served handler", () => {
      const tx = servedHandlerTx({
        acting: { user: bob.did(), session: "bob-session" },
        instanceOwner: alice.did(),
      });
      expect(
        inFrame({ runtime: serving, tx, kind: "handler" }, currentPrincipal),
      ).toBe(bob.did());
    });

    it("returns `undefined` in a served handler with no actor", () => {
      const tx = servedHandlerTx({});
      expect(
        inFrame({ runtime: serving, tx, kind: "handler" }, currentPrincipal),
      ).toBeUndefined();
    });

    it("throws in a `lift()` frame", () => {
      const tx = edit(client);
      expect(() =>
        inFrame({ runtime: client, tx, kind: "lift" }, currentPrincipal)
      ).toThrow(HANDLER_ONLY_MESSAGE);
    });

    it("throws outside any frame", () => {
      expect(() => currentPrincipal()).toThrow(HANDLER_ONLY_MESSAGE);
    });

    it("throws in a pattern body, even one built inside a handler", () => {
      // The handler frame beneath lends the pattern body its runtime and
      // transaction, so what the call has to refuse on is the body's own
      // frame not being a handler's.

      const tx = edit(client);
      expect(inFrame({ runtime: client, tx, kind: "handler" }, () => {
        let seen: unknown = "not called";
        expect(() =>
          pattern(() => {
            seen = currentPrincipal();
            return {};
          })
        ).toThrow(HANDLER_ONLY_MESSAGE);
        return seen;
      })).toBe("not called");
    });

    describe("in a compiled pattern", () => {
      const space = alice.did();

      /** Compiles and runs `PROBE_PATTERN`, and returns its result cell. */
      const runProbe = async () => {
        const compiled = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: PROBE_PATTERN }],
        }, { space });
        const argument = client.getCell<{ seen: string }>(
          space,
          "current-principal-probe-argument",
          undefined,
        );
        const result = client.getCell<{
          seen: string;
          viaComputed: string;
          viaLift: string;
          record: unknown;
        }>(space, "current-principal-probe-result", compiled.resultSchema);
        {
          const tx = client.edit();
          argument.withTx(tx).set({ seen: "no event yet" });
          expect((await tx.commit()).error).toBeUndefined();
        }
        {
          const tx = client.edit();
          client.run(tx, compiled, argument, result);
          expect((await tx.commit()).error).toBeUndefined();
        }
        const cancel = result.sink(() => {});
        await client.idle();
        return { result, cancel };
      };

      it("returns the runtime's own user to a handler, whatever the event payload names", async () => {
        const { result, cancel } = await runProbe();
        try {
          result.key("record").send(bobLookingPayload);
          await client.idle();
          expect(result.key("seen").get()).toBe(`returned ${alice.did()}`);
        } finally {
          cancel();
        }
      });

      it("throws in a `computed()` and in a `lift()`", async () => {
        const { result, cancel } = await runProbe();
        try {
          expect(result.key("viaComputed").get()).toContain(
            `threw \`currentPrincipal()\` is ${HANDLER_ONLY_MESSAGE}`,
          );
          expect(result.key("viaLift").get()).toContain(
            `threw \`currentPrincipal()\` is ${HANDLER_ONLY_MESSAGE}`,
          );
        } finally {
          cancel();
        }
      });
    });

    it("returns the principal an `authored-by` claim the same handler writes resolves to", async () => {
      // The write carries everything a current-principal claim needs to
      // commit, so the only principal in play is the one the transaction's
      // trust names. The transaction keeps the trust `edit()` attached.

      const tx = client.edit();
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "current-principal-module",
        sourceFile: "/writer.tsx",
        bindingPath: ["writeBody"],
      });
      const principal = inFrame(
        { runtime: client, tx, kind: "handler" },
        currentPrincipal,
      );
      const cell = client.getCell(
        alice.did(),
        "current-principal-authored",
        authoredSchema,
        tx,
      );
      cell.set({ body: "hello" });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: ["body"],
        },
        eventId: "trusted-body-edit",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "Writer",
            eventIntegrity: ["Writer"],
            uiContractDataset: { uiAction: "WriteBody" },
          },
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();

      const verify = edit(client);
      const stored = verify.readOrThrow({ ...target, path: [] }) as {
        cfc?: {
          labelMap?: { entries?: { label: { integrity?: unknown[] } }[] };
        };
      };
      const subjects = (stored.cfc?.labelMap?.entries ?? []).flatMap((entry) =>
        (entry.label.integrity ?? []).flatMap((atom) => {
          const subject = principalClaimSubject(atom, "authored-by");
          return subject === undefined ? [] : [subject];
        })
      );
      expect(principal).toBe(alice.did());
      expect(subjects).toEqual([principal]);
    });
  });
});
