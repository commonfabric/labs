import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Pattern } from "../src/builder/types.ts";
import { filter, FILTER_INPUT_SCHEMA } from "../src/builtins/filter.ts";
import { flatMap, FLATMAP_INPUT_SCHEMA } from "../src/builtins/flatmap.ts";
import { map, MAP_INPUT_SCHEMA } from "../src/builtins/map.ts";
import {
  listCoordinatorPlan,
  listElementResultCell,
} from "../src/builtins/list-coordinator-plan.ts";
import { useCancelGroup } from "../src/cancel.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import { getPatternIdentityRef } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

/** A row whose source version is visible in its derived label. */
function rowProgram(
  version: string,
  predicate = false,
  scoped = false,
): RuntimeProgram {
  return {
    main: "/row.tsx",
    files: [{
      name: "/row.tsx",
      contents: `import { computed, pattern, Writable } from "commonfabric";
        export default pattern<{ element: number }>(({ element }) => {
          const count = ${
        scoped
          ? `Writable.perSession.of(${version === "candidate" ? 100 : 0})`
          : "Writable.of(0)"
      }.for("count");
          const label = computed(() => "${version}:" + (element + count.get()));
          return ${
        predicate
          ? `computed(() => element + count.get() >= ${
            version === "candidate" ? 1 : 2
          })`
          : "[label]"
      };
        });`,
    }],
  };
}

describe("list-child-upgrade-transaction", () => {
  for (
    const [name, builtin, schema, scoped] of [
      ["map", map, MAP_INPUT_SCHEMA, false],
      ["flatMap", flatMap, FLATMAP_INPUT_SCHEMA, false],
      ["filter", filter, FILTER_INPUT_SCHEMA, false],
      ["map", map, MAP_INPUT_SCHEMA, true],
    ] as const
  ) {
    it(`keeps an aborted ${name} reconcile from replacing an upgraded ${scoped ? "session-scoped" : "shared"} child after its family loads`, async () => {
      const signer = await Identity.fromPassphrase(
        `list child upgrade ${name}`,
      );
      const space = signer.did();
      const server = newSharedServer();
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const readerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const [cancel, addCancel] = useCancelGroup();
      const naming = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const predicate = name === "filter";
      try {
        const previous = await writer.patternManager.compilePattern(
          rowProgram("previous", predicate, scoped),
          { space },
        );
        const candidate = await writer.patternManager.compilePattern(
          rowProgram("candidate", predicate, scoped),
          { space },
        );
        await reader.patternManager.compilePattern(
          rowProgram("previous", predicate, scoped),
          {
            space,
          },
        );
        const previousRef = writer.patternManager.getArtifactEntryRef(
          previous,
        )!;
        const candidateRef = writer.patternManager.getArtifactEntryRef(
          candidate,
        )!;
        const setup = writer.edit();
        const inputs = writer.getCell(space, "inputs", undefined, setup);
        inputs.set({ list: [1], op: { $patternRef: previousRef } });
        const parent = writer.getCell(space, "parent", undefined, setup);
        const output = writer.getCell(space, "output")
          .getAsNormalizedFullLink();
        const plan = listCoordinatorPlan(
          writer,
          setup,
          name,
          inputs,
          schema,
          parent,
          output,
        );
        const child = listElementResultCell(
          writer,
          setup,
          name,
          plan.container,
          plan.elementKeys.get(0)!,
        );
        plan.container.set([child]);
        expect((await setup.commit().settled).error).toBeUndefined();
        await writer.runSynced(child.withTx(), previous, {
          element: plan.list![0].withTx(),
        });
        await writer.scheduler.idleWithPendingCommits();
        await writerStorage.synced();

        const readerInputs = reader.getCellFromLink<{
          list: number[];
          op: Pattern;
        }>(
          inputs.getAsNormalizedFullLink(),
        );
        const readerParent = reader.getCellFromLink(
          parent.getAsNormalizedFullLink(),
        );
        const readerChild = reader.getCellFromLink(
          child.getAsNormalizedFullLink(),
        );
        await readerInputs.asSchema(schema).sync();
        await readerChild.asSchema({ type: "object", properties: {} }).sync();
        await reader.getCellFromLink(plan.container.getAsNormalizedFullLink())
          .asSchema({ type: "array", items: { asCell: ["cell"] } }).sync();
        const failures: unknown[] = [];
        reader.pieceStartCommitFailureObserver = (failure) =>
          failures.push(failure);
        reader.runner.accessForTestingOnly.dependencySyncer = async (
          cell,
          pattern,
          argument,
          sync,
        ) => {
          naming.resolve();
          await release.promise;
          return await sync(cell, pattern, argument);
        };
        const coordinator = builtin(
          readerInputs,
          () => {},
          addCancel,
          {},
          readerParent,
          reader,
          output,
        );
        if (typeof coordinator === "function") {
          throw new Error("Expected coordinator");
        }
        const reconcile = reader.edit();
        const action = Promise.resolve(coordinator.action(reconcile)).catch(
          (error: unknown) => error,
        );
        await naming.promise;
        reconcile.abort("The parent source update superseded this reconcile");

        await writer.runSynced(child.withTx(), candidate);
        expect(await child.withTx().asSchema(candidate.resultSchema).pull())
          .toEqual(predicate ? true : ["candidate:1"]);
        await writer.scheduler.idleWithPendingCommits();
        await writerStorage.synced();
        release.resolve();
        const outcome = await action;
        await reader.scheduler.idleWithPendingCommits();
        await readerStorage.synced();
        await readerChild.sync();
        expect(getPatternIdentityRef(readerChild)).toEqual(candidateRef);
        if (scoped) {
          const descriptor = candidate.derivedInternalCells?.find((entry) =>
            entry.partialCause === "count"
          );
          if (descriptor === undefined) {
            throw new Error("Expected scoped count");
          }
          expect(
            getDerivedInternalCell(readerChild, descriptor).getRawUntyped(),
          )
            .toBeUndefined();
          await reader.runner.startWithCommit(readerChild);
          expect(await readerChild.asSchema(candidate.resultSchema).pull())
            .toEqual(["candidate:101"]);
        } else {
          expect(await readerChild.pull()).toEqual(
            predicate ? true : ["candidate:1"],
          );
        }
        expect(outcome).toBeInstanceOf(RetryImmediately);
        expect(failures).toEqual([]);
      } finally {
        release.resolve();
        reader.runner.accessForTestingOnly.dependencySyncer = undefined;
        cancel();
        await reader.dispose({ closeStorage: false });
        await writer.dispose({ closeStorage: false });
        await readerStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }

  for (
    const [name, builtin, schema] of [
      ["map", map, MAP_INPUT_SCHEMA],
      ["flatMap", flatMap, FLATMAP_INPUT_SCHEMA],
      ["filter", filter, FILTER_INPUT_SCHEMA],
    ] as const
  ) {
    it(`loads a cold ${name} batch larger than the scheduler retry budget`, async () => {
      const signer = await Identity.fromPassphrase(`list child batch ${name}`);
      const space = signer.did();
      const server = newSharedServer();
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const readerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const [cancel, addCancel] = useCancelGroup();
      try {
        const program = rowProgram("candidate", name === "filter");
        const pattern = await writer.patternManager.compilePattern(program, {
          space,
        });
        await reader.patternManager.compilePattern(program, { space });
        const ref = writer.patternManager.getArtifactEntryRef(pattern)!;
        const values = Array.from(
          { length: MAX_RETRIES_FOR_REACTIVE * 2 },
          (_, i) => i + 1,
        );
        const setup = writer.edit();
        const inputs = writer.getCell(space, "inputs", undefined, setup);
        inputs.set({ list: values, op: { $patternRef: ref } });
        const parent = writer.getCell(space, "parent", undefined, setup);
        const output = writer.getCell(space, "output")
          .getAsNormalizedFullLink();
        const plan = listCoordinatorPlan(
          writer,
          setup,
          name,
          inputs,
          schema,
          parent,
          output,
        );
        const children = values.map((_, index) =>
          listElementResultCell(
            writer,
            setup,
            name,
            plan.container,
            plan.elementKeys.get(index)!,
          )
        );
        plan.container.set([]);
        expect((await setup.commit().settled).error).toBeUndefined();
        for (const [index, child] of children.entries()) {
          await writer.runSynced(child.withTx(), pattern, {
            element: plan.list![index].withTx(),
          });
        }
        await writer.scheduler.idleWithPendingCommits();
        await writerStorage.synced();

        const readerInputs = reader.getCellFromLink<
          { list: number[]; op: Pattern }
        >(inputs.getAsNormalizedFullLink());
        await readerInputs.asSchema(schema).sync();
        await reader.getCellFromLink(plan.container.getAsNormalizedFullLink())
          .asSchema({ type: "array", items: { asCell: ["cell"] } }).sync();
        await Promise.all(
          children.map((child) =>
            reader.getCellFromLink(child.getAsNormalizedFullLink()).asSchema({
              type: "object",
              properties: {},
            }).sync()
          ),
        );
        const named = new Set<string>();
        reader.runner.accessForTestingOnly.dependencySyncer = async (
          cell,
          pattern,
          argument,
          sync,
        ) => {
          named.add(cell.getAsNormalizedFullLink().id);
          return await sync(cell, pattern, argument);
        };
        const coordinator = builtin(
          readerInputs,
          () => {},
          addCancel,
          {},
          reader.getCellFromLink(parent.getAsNormalizedFullLink()),
          reader,
          output,
        );
        if (typeof coordinator === "function") {
          throw new Error("Expected coordinator");
        }
        coordinator.onActionRegistered?.(coordinator.action);
        addCancel(
          reader.scheduler.register(coordinator.action, { isEffect: true }),
        );
        await reader.scheduler.idleWithPendingCommits();
        expect(named.size).toBe(values.length);
        // The scheduler must finish the reconcile, not merely finish loading
        // the final child after exhausting its immediate retry budget.
        const aggregate = reader.getCellFromLink(
          plan.container.getAsNormalizedFullLink(),
        );
        expect(await aggregate.pull()).toEqual(
          name === "filter"
            ? values
            : name === "flatMap"
            ? values.map((value) => `candidate:${value}`)
            : values.map((value) => [`candidate:${value}`]),
        );
      } finally {
        reader.runner.accessForTestingOnly.dependencySyncer = undefined;
        cancel();
        await reader.dispose({ closeStorage: false });
        await writer.dispose({ closeStorage: false });
        await readerStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }
});
