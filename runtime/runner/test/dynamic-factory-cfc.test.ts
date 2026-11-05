import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type {
  BuilderFunctionsAndConstants,
  FabricValue,
  JSONSchema,
  ModuleFactory,
  Reactive,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("dynamic factory cfc test");
const space = signer.did();

const ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const FACTORY_REF = {
  identity: "DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "selectedFactory",
} as const;

type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;

type StoredLabelEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("dynamic Factory@1 CFC provenance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;
  let selectedFactory: ModuleFactory<
    { value: number },
    { result: number }
  >;
  let selectedShell: FabricValue;
  let executions: number;
  let observeNextExecution: (() => void) | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    invokeFactory = (commonfabric as unknown as {
      __cfHelpers: { invokeFactory: InvokeFactory };
    }).__cfHelpers.invokeFactory;
    executions = 0;
    selectedFactory = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions++;
        observeNextExecution?.();
        observeNextExecution = undefined;
        return { result: value * 10 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(selectedFactory, FACTORY_REF);
    selectedShell = createFactoryShell(sealFactoryState(selectedFactory));
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      identity === FACTORY_REF.identity && symbol === FACTORY_REF.symbol
        ? selectedFactory
        : undefined;
    runtime.patternManager.isArtifactAvailableInSpace = (identity) =>
      identity === FACTORY_REF.identity;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  function outerPattern() {
    const argumentSchema = {
      type: "object",
      properties: {
        factory: { asFactory: MODULE_CONTRACT },
        value: { type: "number" },
      },
      required: ["factory", "value"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    return commonfabric.pattern<
      { factory: unknown; value: number },
      { result: number }
    >(
      ({ factory, value }) =>
        invokeFactory<{ value: number }, { result: number }>(
          factory,
          { value },
          MODULE_CONTRACT,
        ),
      argumentSchema,
      RESULT_SCHEMA,
    );
  }

  function scheduledOuterPattern() {
    const argumentSchema = {
      type: "object",
      properties: {
        factory: { asFactory: MODULE_CONTRACT },
        value: { type: "number" },
      },
      required: ["factory", "value"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const consumer = commonfabric.lift(
      (
        { factory, value }: {
          factory: ModuleFactory<{ value: number }, { result: number }>;
          value: number;
        },
      ) => {
        expect(factory).toBe(selectedFactory);
        return { result: value * 10 };
      },
      argumentSchema,
      RESULT_SCHEMA,
    );
    return commonfabric.pattern<
      {
        factory: ModuleFactory<{ value: number }, { result: number }>;
        value: number;
      },
      { result: number }
    >(
      (input) => consumer(input),
      argumentSchema,
      RESULT_SCHEMA,
    );
  }

  async function commit(tx: IExtendedStorageTransaction): Promise<void> {
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  function selectorCell(name: string) {
    return runtime.getCell<unknown>(space, name);
  }

  async function writeSelection(
    selector: ReturnType<typeof selectorCell>,
    value: FabricValue,
    confidentiality: string,
  ): Promise<void> {
    const link = selector.getAsNormalizedFullLink();
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space: link.space,
      scope: link.scope,
      id: link.id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [confidentiality] },
          }],
        },
      },
    });
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  function storedLabels(id: string): StoredLabelEntry[] {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredLabelEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  }

  it("carries the selector label through the materialized lift action", async () => {
    const selector = selectorCell("dynamic-factory-cfc-selector");
    await writeSelection(selector, selectedShell, "selected-code-secret");

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-cfc-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 3 },
      resultCell,
    );
    await commit(tx);

    expect(await within(result.pull(), "CFC-labeled factory result")).toEqual({
      result: 30,
    });
    await runtime.idle();

    const resultLink = result.resolveAsCell().getAsNormalizedFullLink();
    const labels = storedLabels(resultLink.id);
    expect(
      labels.some((entry) =>
        entry.origin === "derived" &&
        entry.label.confidentiality?.includes("selected-code-secret")
      ),
    ).toBe(true);
  });

  it("carries a scheduled factory input label through callback readiness", async () => {
    const selector = selectorCell("scheduled-factory-cfc-selector");
    await writeSelection(selector, selectedShell, "scheduled-code-secret");

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "scheduled-factory-cfc-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      scheduledOuterPattern(),
      { factory: selector, value: 6 },
      resultCell,
    );
    await commit(tx);

    expect(await within(result.pull(), "scheduled CFC factory result"))
      .toEqual({ result: 60 });
    await runtime.idle();

    const labels = storedLabels(
      result.resolveAsCell().getAsNormalizedFullLink().id,
    );
    expect(
      labels.some((entry) =>
        entry.origin === "derived" &&
        entry.label.confidentiality?.includes("scheduled-code-secret")
      ),
    ).toBe(true);
  });

  it("restarts the selected child when only the selector label changes", async () => {
    const selector = selectorCell("dynamic-factory-label-only-selector");
    await writeSelection(selector, selectedShell, "selected-code-a");

    const tx = runtime.edit();
    const value = runtime.getCell<number>(
      space,
      "dynamic-factory-label-only-value",
      { type: "number" },
      tx,
    );
    value.set(4);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-label-only-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value },
      resultCell,
    );
    await commit(tx);
    expect(await within(result.pull(), "initial labeled factory result"))
      .toEqual({ result: 40 });
    await runtime.idle();
    const executionsBeforeLabelChange = executions;

    const nextExecution = new Promise<void>((resolve) => {
      observeNextExecution = resolve;
    });
    await writeSelection(selector, selectedShell, "selected-code-b");
    await within(nextExecution, "label-only factory restart");
    await runtime.idle();

    expect(executions).toBe(executionsBeforeLabelChange + 1);
    expect(await within(result.pull(), "label-only replacement result"))
      .toEqual({ result: 40 });

    // The identical result above remains the last committed A-derived value:
    // its second write was a byte-for-byte no-op. Once this live generation
    // writes different output bytes, the current B selector label must be the
    // provenance that persists.
    const changedInput = runtime.edit();
    value.withTx(changedInput).set(5);
    await commit(changedInput);
    expect(await within(result.pull(), "B-labeled changed result")).toEqual({
      result: 50,
    });
    await runtime.idle();
    const labels = storedLabels(
      result.resolveAsCell().getAsNormalizedFullLink().id,
    );
    const derivedConfidentiality = labels
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []);
    expect(derivedConfidentiality).toContain("selected-code-b");
  });

  it("recovers from a preloaded invalid selection after reporting it", async () => {
    const selector = selectorCell("dynamic-factory-invalid-selector");
    const seed = runtime.edit();
    selector.withTx(seed).set({ invalid: "not-a-factory" });
    await commit(seed);

    let observeError!: (error: Error) => void;
    const reportedError = new Promise<Error>((resolve) => {
      observeError = resolve;
    });
    runtime.scheduler.onError((error) => observeError(error));

    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-invalid-recovery-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 5 },
      resultCell,
    );
    await commit(tx);

    expect((await within(reportedError, "invalid selector diagnostic")).message)
      .toContain("admitted FabricFactory");
    expect(executions).toBe(0);

    const nextExecution = new Promise<void>((resolve) => {
      observeNextExecution = resolve;
    });
    const replacement = runtime.edit();
    selector.withTx(replacement).set(selectedShell);
    await commit(replacement);
    await within(nextExecution, "valid replacement execution");
    await runtime.idle();

    expect(await within(result.pull(), "valid replacement result")).toEqual({
      result: 50,
    });
    expect(executions).toBe(1);
  });
});
