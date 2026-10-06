/**
 * Pins the runner half of the `completeSchedulerScopeSummary` contract: a
 * lift whose module carries the transformer-emitted completeness marker is
 * subscribed with a concrete scope-summary certificate — `complete: true`,
 * the piece link, and a read set bounded to the declared reads plus the
 * runner's own framework reads (argument container, result cell, structural
 * meta links, scheduling writes). A lift without the marker is subscribed
 * with no certificate at all — absence is the fail-closed arm for raw
 * modules and unproven sources.
 *
 * This is the runner-side counterpart of ts-transformers'
 * pipeline-regressions emission pins ("complete source lifts emit scheduler
 * scope proof including proven-empty"). The mutation it kills: a runner
 * that ignores `module.completeSchedulerScopeSummary` (the stage C.1
 * deletion this restore reverts) produces no certificate, and the
 * opted-in assertions below go red.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { lift } from "../src/builder/module.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("scheduler scope summary");
const space = signer.did();

type ScopeSummaryCertificate = {
  complete: true;
  piece: NormalizedFullLink;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
  materializerWriteEnvelopes: NormalizedFullLink[];
  directOutputs: NormalizedFullLink[];
};

type AnnotatedCapture = {
  completeSchedulerScopeSummary?: ScopeSummaryCertificate;
  reads?: NormalizedFullLink[];
  writes?: NormalizedFullLink[];
};

describe("scheduler scope summary certificate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let frame: Frame;
  let tx: IExtendedStorageTransaction;
  let captured: AnnotatedCapture[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Capture every action the runner hands the scheduler, annotations
    // included, then pass it through so instantiation proceeds normally.
    captured = [];
    const scheduler = runtime.scheduler as unknown as {
      subscribe: (action: Action, ...rest: unknown[]) => () => void;
    };
    const realSubscribe = scheduler.subscribe.bind(runtime.scheduler);
    scheduler.subscribe = (action: Action, ...rest: unknown[]) => {
      captured.push(action as unknown as AnnotatedCapture);
      return realSubscribe(action, ...rest);
    };
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
    await storageManager?.close();
  });

  const linkKey = (link: NormalizedFullLink): string =>
    `${link.id}|${(link.path ?? []).join("/")}`;

  it("subscribes a marker-carrying lift with a complete certificate whose reads bound the declared surface", async () => {
    const double = lift(
      (input: { x: number }) => input.x * 2,
      {
        type: "object",
        properties: { x: { type: "number" } },
      } as const,
      { type: "number" } as const,
      { completeSchedulerScopeSummary: true },
    );
    const testPattern = pattern<{ x: number }>(({ x }) => ({
      doubled: double({ x }),
    }));

    const resultCell = runtime.getCell(
      space,
      "scope-summary-on",
      testPattern.resultSchema,
      tx,
    );
    runtime.run(tx, testPattern, { x: 21 }, resultCell);
    await tx.commit().settled;
    await runtime.idle();

    const certified = captured.filter(
      (action) => action.completeSchedulerScopeSummary !== undefined,
    );
    expect(certified.length).toBe(1);
    const summary = certified[0].completeSchedulerScopeSummary!;
    expect(summary.complete).toBe(true);
    expect(summary.piece.id).toBeDefined();

    // The certificate's read set is a bounded superset of the action's
    // declared reads: every declared read appears, and the framework reads
    // (argument container, result/piece cell, scheduling writes) ride along
    // so a complete space-only lift is not mistaken for a contradiction.
    const summaryReadKeys = new Set(summary.reads.map(linkKey));
    for (const read of certified[0].reads ?? []) {
      expect(summaryReadKeys.has(linkKey(read))).toBe(true);
    }
    expect(summaryReadKeys.has(linkKey(summary.piece))).toBe(true);
    const summaryWriteKeys = new Set(summary.writes.map(linkKey));
    for (const write of certified[0].writes ?? []) {
      expect(summaryWriteKeys.has(linkKey(write))).toBe(true);
      // Scheduling writes are part of the certified read surface too (the
      // runner reads direct output cells while diffing before writing).
      expect(summaryReadKeys.has(linkKey(write))).toBe(true);
    }
    expect(summary.directOutputs.length).toBeGreaterThan(0);
    expect(summary.materializerWriteEnvelopes).toEqual([]);
  });

  it("subscribes a marker-less lift with no certificate (fail-closed)", async () => {
    const double = lift(
      (input: { x: number }) => input.x * 2,
      {
        type: "object",
        properties: { x: { type: "number" } },
      } as const,
      { type: "number" } as const,
    );
    const testPattern = pattern<{ x: number }>(({ x }) => ({
      doubled: double({ x }),
    }));

    const resultCell = runtime.getCell(
      space,
      "scope-summary-off",
      testPattern.resultSchema,
      tx,
    );
    runtime.run(tx, testPattern, { x: 21 }, resultCell);
    await tx.commit().settled;
    await runtime.idle();

    expect(captured.length).toBeGreaterThan(0);
    for (const action of captured) {
      expect(action.completeSchedulerScopeSummary).toBeUndefined();
    }
  });
});
