/**
 * How the `agent` sink is governed: its row in the max-enforcement registry,
 * the sink class the egress gate mints for it, and the verdicts that follow
 * from an empty ceiling under that posture — a task text carrying another
 * user's clause is refused, a reference to a labeled cell is refused with
 * it, and a request over unlabeled references fits.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { createBuilder } from "../src/builder/factory.ts";
import {
  KNOWN_SINKS,
  SINK_CLASSES,
  sinkClassOf,
} from "../src/cfc/sink-inventory.ts";
import { Runtime } from "../src/runtime.ts";
import {
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
  MAX_ENFORCEMENT_SINK_GOVERNANCE,
} from "../src/runtime-presets.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("agent sink governance");
const space = signer.did();

const RESULT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

describe("agent sink governance", () => {
  describe("the registry", () => {
    it("declares an empty ceiling for the `agent` sink under max enforcement", () => {
      // The row is a ceiling, not an ungated release: the request a pattern
      // stages carries references plus a task text, and the empty ceiling
      // admits no confidentiality on that text.
      expect(MAX_ENFORCEMENT_SINK_GOVERNANCE.agent).toEqual({ ceiling: [] });
      expect(MAX_ENFORCEMENT_SINK_CEILINGS.agent).toEqual([]);
    });

    it("stays total over the sink inventory", () => {
      expect(Object.keys(MAX_ENFORCEMENT_SINK_GOVERNANCE).sort())
        .toEqual([...KNOWN_SINKS].sort());
    });

    it("classes every known sink, `agent` as `agent`, `sqliteQuery` as `storage` and the rest as `network`", () => {
      // The class is what an exchange rule scopes itself to, so a sink whose
      // request never leaves for a host on the network does not answer to a
      // rule written for one. `sqliteQuery` hands its request to the
      // provider holding a space's replicas, which is neither of the other
      // two.
      expect(Object.keys(SINK_CLASSES).sort()).toEqual([...KNOWN_SINKS].sort());
      expect(sinkClassOf("agent")).toBe("agent");
      expect(sinkClassOf("sqliteQuery")).toBe("storage");
      for (const sink of KNOWN_SINKS) {
        if (sink === "agent" || sink === "sqliteQuery") continue;
        expect(sinkClassOf(sink), sink).toBe("network");
      }
    });

    it("classes a sink outside the inventory as `network`", () => {
      expect(sinkClassOf("someSinkNobodyRegistered")).toBe("network");
    });
  });

  describe("the egress gate under max enforcement", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;
    let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        ...MAX_ENFORCEMENT_CFC_OPTIONS,
        cfcEnforcementMode: "enforce-strict",
        experimental: { agentBuiltin: true },
      });
      tx = runtime.edit();
      ({ commonfabric } = createTrustedBuilder(runtime));
    });

    afterEach(async () => {
      await tx.commit();
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    });

    it("refuses a request whose task text carries another user's clause", async () => {
      const { pattern, agent, Cell: BuilderCell } = commonfabric;
      const testPattern = pattern<Record<string, never>>(() => {
        const task = BuilderCell.of("summarize what the other user wrote", {
          type: "string",
          ifc: { confidentiality: [cfcAtom.user("did:key:zOther")] },
        });
        // deno-lint-ignore no-explicit-any
        return agent({ task, inputs: {}, resultSchema: RESULT_SCHEMA } as any);
      });
      const resultCell = runtime.getCell(
        space,
        "agent-governance-refused",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const settled = await waitForCellValue<{ error?: string }>(
        runtime,
        result,
        (value) => typeof value?.error === "string" && value.error.length > 0,
      );
      await runtime.settled();

      expect(settled.error).toContain("was refused before it started");
      expect(settled.error).not.toContain("zOther");
      expect(result.withTx().key("pending").get()).toBe(false);
      expect(result.withTx().key("run").get()).toBeUndefined();
    });

    it("refuses a request passing a labeled cell by reference under the static empty ceiling", async () => {
      // Pins the cost of the static row rather than a desired end state. A
      // link position carries its target's label as the pointer's own
      // (`origin:"link"` entries, consumed by the `followRef` read that
      // resolves which reference sits at the slot), so passing a labeled
      // cell is a labeled read of the request, and an empty ceiling refuses
      // it. The ceiling the design gives this sink — the request's own
      // observation ceiling, under which a reference to the requester's data
      // fits — needs the gate to read a ceiling off the request; when that
      // lands, this case flips to asserting the record.
      const { pattern, agent, Cell: BuilderCell } = commonfabric;
      const testPattern = pattern<Record<string, never>>(() => {
        const finished = BuilderCell.of(["Dune", "Solaris"], {
          type: "array",
          items: { type: "string" },
          ifc: { confidentiality: [cfcAtom.user("did:key:zOther")] },
        });
        return agent({
          task: "which of these would a reader of the listed authors like?",
          inputs: { finished },
          resultSchema: RESULT_SCHEMA,
          // deno-lint-ignore no-explicit-any
        } as any);
      });
      const resultCell = runtime.getCell(
        space,
        "agent-governance-reference-refused",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      const settled = await waitForCellValue<{ error?: string }>(
        runtime,
        result,
        (value) => typeof value?.error === "string" && value.error.length > 0,
      );
      await runtime.settled();

      expect(settled.error).toContain("was refused before it started");
      expect(result.withTx().key("run").get()).toBeUndefined();
    });

    it("stages a request that passes an unlabeled cell by reference", async () => {
      const { pattern, agent, Cell: BuilderCell } = commonfabric;
      const testPattern = pattern<Record<string, never>>(() => {
        const finished = BuilderCell.of(["Dune", "Solaris"], {
          type: "array",
          items: { type: "string" },
        });
        return agent({
          task: "which of these would a reader of the listed authors like?",
          inputs: { finished },
          resultSchema: RESULT_SCHEMA,
          // deno-lint-ignore no-explicit-any
        } as any);
      });
      const resultCell = runtime.getCell(
        space,
        "agent-governance-fits",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // The record is what the post-commit effect creates, so its appearance
      // is the evidence that the staging transaction committed.
      const run = await waitForCellValue<{ state?: string }>(
        runtime,
        result.key("run"),
        (value) => value?.state !== undefined,
      );
      await runtime.settled();

      expect(run.state).toBe("queued");
      expect(result.withTx().key("pending").get()).toBe(true);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });
  });
});
