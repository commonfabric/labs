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

import { Identity } from "@commonfabric/identity";

import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type Frame, NAME } from "../src/builder/types.ts";
import type { FabricValue } from "@commonfabric/data-model";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { isSchedulerDependencyRead } from "../src/storage/reactivity-log.ts";
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

/** The confidentiality stored at the argument slot that holds the link. */
const SLOT = "slot-secret";

/** The confidentiality of a third principal's data. */
const CAROL = "carol-secret";

describe("cfc-static-read-targets", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let frame: Frame;
  let certificates: { reads: NormalizedFullLink[] }[];
  let others: Runtime[];

  /**
   * Records in `into` every certificate `on` hands its scheduler, so a case
   * can see what an instantiation resolved.
   */
  const recordCertificates = (
    on: Runtime,
    into: { reads: NormalizedFullLink[] }[],
  ): void => {
    const scheduler = on.scheduler as unknown as {
      subscribe: (action: Action, ...rest: unknown[]) => () => void;
    };
    const subscribe = scheduler.subscribe.bind(on.scheduler);
    scheduler.subscribe = (action: Action, ...rest: unknown[]) => {
      const certificate = (action as unknown as {
        completeSchedulerScopeSummary?: { reads: NormalizedFullLink[] };
      }).completeSchedulerScopeSummary;
      if (certificate !== undefined) into.push(certificate);
      return subscribe(action, ...rest);
    };
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The stamps below reach storage at "persist".
      cfcFlowLabels: "persist",
    });
    certificates = [];
    recordCertificates(runtime, certificates);
    others = [];
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    for (const other of others) await other.dispose();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Seeds the document `cause` holding `value`, every read of which carries
   * `atom`.
   */
  const seedDocument = async (
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<IMemorySpaceAddress> => {
    const tx = runtime.edit();
    const id = runtime.getCell(space, cause, undefined, tx)
      .getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(tx, space);
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id,
      path: [],
    };
    seedStoredEnvelope(tx, address, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    } as FabricValue);
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
   * labels the slot of its argument document that holds the link with
   * {@link SLOT}, as a declared slot does, and returns the result cell, the
   * argument document and Bob's document.
   */
  const setUpOverLabeledSlot = async () => {
    const bobs = await seedDocument("bobs-document", { x: 21 }, BOB);
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
            label: { confidentiality: [SLOT] },
            origin: "declared",
          }],
        },
      },
    } as FabricValue);
    runtime.prepareTxForCommit(labelTx);
    expect((await labelTx.commit().settled).ok).toBeDefined();
    expect(labelsOf(argument)).toEqual([SLOT]);
    certificates.length = 0;
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
          [...(tx.getReadActivities?.() ?? [])].some((read) =>
            read.id === argument.id &&
            JSON.stringify(read.path) === JSON.stringify(["value", "x"])
          ),
        ).toBe(true);
      } finally {
        tx.abort("journal read");
      }
    });

    it("leaves the action's own run to carry the label stored at the slot it reads through", async () => {
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
      ).toContain(SLOT);
    });

    it("keeps the resolving read a conflict dependency of the transaction", async () => {
      // A change to the slot the input resolves through, committed while the
      // instantiating transaction is open, refuses that transaction's commit.

      const { tx, argument, bobs } = await instantiateAgain();
      const change = runtime.edit();
      runtime.getCellFromLink({ ...argument, path: ["x"] }, undefined, change)
        .setRaw(
          runtime.getCellFromLink({ ...bobs, path: [] }, undefined, change)
            .getAsLink(),
        );
      runtime.prepareTxForCommit(change);
      expect((await change.commit().settled).ok).toBeDefined();

      // A write of the transaction's own, so its commit is not elided.
      runtime.getCell<number>(space, "elsewhere", undefined, tx).set(1);
      runtime.prepareTxForCommit(tx);
      const result = await tx.commit().settled;
      expect(result.error).toBeDefined();
    });
  });

  it("certifies an action under a read ceiling a link it resolves through exceeds, and refuses the action's own read", async () => {
    // Bob's `x` is a link to Carol's `y`, and the runtime's read ceiling
    // admits Carol's label and not Bob's. The setup resolves the input
    // through Bob's slot to certify the action, which takes nothing of the
    // slot into anything, and the action's own run, which reads the value
    // through that slot, is refused there.

    const carol = await seedDocument("carols-document", { y: 21 }, CAROL);
    const bob = await seedDocument("bobs-chain", {
      x: runtime.getCellFromLink({ ...carol, path: ["y"] }).getAsLink(),
    } as FabricValue, BOB);
    const reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      cfcReadMaxConfidentiality: [CAROL],
      cfcReadOnExceed: "fail",
    });
    others.push(reader);
    const readerCertificates: { reads: NormalizedFullLink[] }[] = [];
    recordCertificates(reader, readerCertificates);
    const errors: unknown[] = [];
    reader.scheduler.onError((error) => errors.push(error));
    const testPattern = doubling();

    const tx = reader.edit();
    const resultCell = reader.getCell(
      space,
      "ceiling-chain",
      testPattern.resultSchema,
      tx,
    );
    reader.run(tx, testPattern, {
      x: reader.getCellFromLink({ ...bob, path: ["x"] }, undefined, tx),
    }, resultCell);
    reader.prepareTxForCommit(tx);
    expect((await tx.commit().settled).ok).toBeDefined();
    expect(readerCertificates).toHaveLength(1);
    await resultCell.key("doubled").pull().catch((error) => errors.push(error));
    await reader.idle();

    expect(errors.map(String)).toContainEqual(
      expect.stringMatching(/read ceiling/),
    );
  });

  it("resolves an input several actions share once in the transaction", () => {
    // The reads share the transaction's resolution memo, which is keyed by
    // their metadata, so a second action over the same input resolves
    // nothing again.

    const source = runtime.getCell<number>(space, "shared-source");
    const resolvingReads = (actions: number): number => {
      const lifts = Array.from({ length: actions }, () =>
        lift(
          (input: { x: number }) => input.x * 2,
          {
            type: "object",
            properties: { x: { type: "number" } },
          } as const,
          { type: "number" } as const,
          { completeSchedulerScopeSummary: true },
        ));
      const testPattern = pattern<{ x: number }>(({ x }) =>
        Object.fromEntries(
          lifts.map((each, index) => [`d${index}`, each({ x })]),
        )
      );
      const tx = runtime.edit();
      try {
        source.withTx(tx).set(21);
        runtime.run(
          tx,
          testPattern,
          { x: source.withTx(tx) },
          runtime.getCell(
            space,
            `shared-${actions}`,
            testPattern.resultSchema,
            tx,
          ),
        );
        return [...(tx.getReadActivities?.() ?? [])].filter((read) =>
          isSchedulerDependencyRead(read.meta)
        ).length;
      } finally {
        tx.abort("read count");
      }
    };

    const once = resolvingReads(1);
    expect(once).toBeGreaterThan(0);
    expect(resolvingReads(8)).toBe(once);
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
