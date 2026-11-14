/**
 * The reads that certify a JavaScript action node's static read set when a
 * setup instantiates it: resolving each declared input to the cell the
 * action will read. What they find goes into the scheduler's completeness
 * certificate and into nothing the setup writes, so they are dependency
 * discovery (spec §8.10.1) and take no label into the instantiating
 * transaction's flow join. The action's own run reads the same cell as an
 * ordinary read, in its own transaction, and carries its label.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type Frame, NAME } from "../src/builder/types.ts";
import type { FabricValue } from "@commonfabric/data-model";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-static-read-targets");
const space = signer.did();

/** The confidentiality of another principal's data. */
const BOB = "bob-secret";

describe("cfc-static-read-targets", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let frame: Frame;
  let certificates: { reads: NormalizedFullLink[] }[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The stamps below reach storage at "persist".
      cfcFlowLabels: "persist",
    });
    // Every certificate the runner hands the scheduler, so a case can see
    // what the instantiation resolved.
    certificates = [];
    const scheduler = runtime.scheduler as unknown as {
      subscribe: (action: Action, ...rest: unknown[]) => () => void;
    };
    const subscribe = scheduler.subscribe.bind(runtime.scheduler);
    scheduler.subscribe = (action: Action, ...rest: unknown[]) => {
      const certificate = (action as unknown as {
        completeSchedulerScopeSummary?: { reads: NormalizedFullLink[] };
      }).completeSchedulerScopeSummary;
      if (certificate !== undefined) certificates.push(certificate);
      return subscribe(action, ...rest);
    };
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Seeds a document of Bob's holding `{ x: 21 }`, every read of which carries {@link BOB}. */
  const seedBobsDocument = async (): Promise<IMemorySpaceAddress> => {
    const tx = runtime.edit();
    const id = runtime.getCell(space, "bobs-document", undefined, tx)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(tx, space);
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id,
      path: [],
    };
    seedStoredEnvelope(tx, address, {
      value: { x: 21 },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [BOB] } }],
        },
      },
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    return address;
  };

  /** A pattern whose one node is a certified lift over its argument's `x`. */
  const doubling = () => {
    const double = lift(
      (input: { x: number }) => input.x * 2,
      {
        type: "object",
        properties: { x: { type: "number" } },
      } as const,
      { type: "number" } as const,
      { completeSchedulerScopeSummary: true },
    );
    return pattern<{ x: number }>(({ x }) => ({ doubled: double({ x }) }));
  };

  /** The confidentiality of every entry stored on `link`'s document. */
  const labelsOf = (link: NormalizedFullLink): unknown[] => {
    const tx = runtime.edit();
    try {
      return (readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [])
        .flatMap((entry) => entry.label.confidentiality ?? []);
    } finally {
      tx.abort("label read");
    }
  };

  /**
   * Sets {@link doubling} up on `doubled` over Bob's `x` and stops it, then
   * labels the slot of its argument document that holds the link, as a
   * declared slot does, and returns the result cell, the argument document
   * and Bob's document.
   */
  const setUpOverLabeledSlot = async () => {
    const bobs = await seedBobsDocument();
    const first = doubling();
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "doubled",
      first.resultSchema,
      tx,
    );
    runtime.run(
      tx,
      first,
      { x: runtime.getCellFromLink({ ...bobs, path: ["x"] }, undefined, tx) },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    await runtime.idle();
    runtime.runner.stop(resultCell);
    const argument = getMetaLink(resultCell, "argument")!;
    const labelTx = runtime.edit();
    const document: IMemorySpaceAddress = {
      space: argument.space,
      scope: argument.scope,
      id: argument.id,
      path: [],
    };
    const stored = labelTx.readOrThrow({
      ...document,
      type: "application/json",
    } as IMemorySpaceAddress);
    writeSeedEnvelopeDoc(labelTx, space);
    seedStoredEnvelope(labelTx, document, {
      ...(stored as Record<string, FabricValue>),
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["x"],
            label: { confidentiality: [BOB] },
            origin: "declared",
          }],
        },
      },
    } as FabricValue);
    runtime.prepareTxForCommit(labelTx);
    expect((await labelTx.commit().settled).ok).toBeDefined();
    expect(labelsOf(argument)).toEqual([BOB]);
    certificates = [];
    return { resultCell, argument, bobs };
  };

  describe("a setup that instantiates a certified action over a labeled slot", () => {
    // The setup instantiates the lift again over the stored argument, and
    // certifies its read set by resolving the input through the argument's
    // `x`, which holds the link to Bob's document.

    /** Instantiates the lift again in a transaction of its own, left open. */
    const instantiateAgain = async () => {
      const { resultCell, argument, bobs } = await setUpOverLabeledSlot();
      const next = doubling();
      const tx = runtime.edit();
      runtime.run(
        tx,
        next,
        undefined,
        runtime.getCell(space, "doubled", next.resultSchema, tx),
      );
      return { tx, resultCell, argument, bobs };
    };

    it("takes nothing of the slot's label into the transaction's join", async () => {
      const { tx } = await instantiateAgain();
      try {
        expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      } finally {
        tx.abort("join read");
      }
    });

    it("certifies the cell the input resolves to", async () => {
      const { tx, bobs } = await instantiateAgain();
      tx.abort("certificate read");

      expect(certificates).toHaveLength(1);
      expect(
        certificates[0].reads.map((read) => [read.id, read.path]),
      ).toContainEqual([bobs.id, ["x"]]);
    });

    it("journals the resolving read of the slot", async () => {
      // The read stays in the transaction's read set, which conflict
      // detection and scheduling take from.

      const { tx, argument } = await instantiateAgain();
      try {
        expect(
          [...tx.getReadActivities()].some((read) =>
            read.id === argument.id &&
            JSON.stringify(read.path) === JSON.stringify(["value", "x"])
          ),
        ).toBe(true);
      } finally {
        tx.abort("journal read");
      }
    });

    it("leaves the action's own run to carry the label of what it reads", async () => {
      const { resultCell } = await setUpOverLabeledSlot();
      const next = doubling();
      const tx = runtime.edit();
      runtime.run(tx, next, undefined, resultCell.withTx(tx));
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).ok).toBeDefined();

      await resultCell.key("doubled").pull();
      await runtime.idle();

      expect(resultCell.key("doubled").get()).toBe(42);
      expect(
        labelsOf(
          resultCell.key("doubled").resolveAsCell().getAsNormalizedFullLink(),
        ),
      ).toContain(BOB);
    });
  });

  it("joins a stored name the setup carries over, which it writes", async () => {
    // A same-pattern setup reads the name it carries over from the stored
    // result and writes it, so that read is an ordinary observation.

    const named = pattern<{ x: number }>(({ x }) => ({
      [NAME]: "Doubled",
      doubled: doubling()({ x }),
    }));
    const setupTx = runtime.edit();
    const resultCell = runtime.getCell(space, "named", undefined, setupTx);
    runtime.run(setupTx, named, { x: 21 }, resultCell);
    runtime.prepareTxForCommit(setupTx);
    expect((await setupTx.commit().settled).ok).toBeDefined();
    await runtime.idle();
    runtime.runner.stop(resultCell);
    const link = resultCell.getAsNormalizedFullLink();
    const labelTx = runtime.edit();
    const document: IMemorySpaceAddress = {
      space: link.space,
      scope: link.scope,
      id: link.id,
      path: [],
    };
    const stored = labelTx.readOrThrow({
      ...document,
      type: "application/json",
    } as IMemorySpaceAddress);
    writeSeedEnvelopeDoc(labelTx, space);
    seedStoredEnvelope(labelTx, document, {
      ...(stored as Record<string, FabricValue>),
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [NAME],
            label: { confidentiality: [BOB] },
            origin: "declared",
          }],
        },
      },
    } as FabricValue);
    runtime.prepareTxForCommit(labelTx);
    expect((await labelTx.commit().settled).ok).toBeDefined();

    const tx = runtime.edit();
    runtime.run(tx, named, { x: 21 }, resultCell.withTx(tx));
    try {
      expect(deriveFlowJoin(tx).confidentiality).toContain(BOB);
    } finally {
      tx.abort("join read");
    }
  });
});
