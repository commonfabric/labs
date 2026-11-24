#!/usr/bin/env -S deno run -A

/**
 * This test demonstrates the full layered persistence model:
 * 1. Pattern source code stored in `datum` table (content-addressed)
 * 2. Precious data stored in `datum` table
 * 3. Pattern loaded from storage reacts to data loaded from storage
 * 4. Cross-session reactivity: updating input in a new runtime updates
 *    a result cell from a previous session
 *
 * The test uses multiple runtime instances to prove that both pattern
 * and data are truly persisted and can be loaded fresh from storage.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type Cell,
  experimentalOptionsFromEnv,
  type JSONSchema,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { Identity, type IdentityCreateConfig } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

/** A content-addressed pattern pointer. */
type PatternRef = { identity: string; symbol: string };

const API_URL = new URL(env.API_URL);

const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

// Cell IDs used across phases
const INPUT_CELL_ID_PHASE_2 = "test-input-data";
const INPUT_CELL_ID_PHASE_3 = "test-input-data-phase-3";
const RESULT_CELL_ID_PHASE_2 = "test-pattern-result";
const RESULT_CELL_ID_PHASE_3 = "test-pattern-result-3";

/**
 * A simple pattern that:
 * - Takes a cell reference as input (the "precious" data)
 * - Computes derived values using lift() (defined outside pattern body)
 */
const patternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "",
        "// Define lifts outside the pattern body",
        "const computeSum = lift((data: { values: number[] }) => {",
        "  console.log('[computeSum]', JSON.stringify(data));",
        "  return data.values.reduce((acc: number, v: number) => acc + v, 0);",
        "});",
        "",
        "const formatResult = lift((data: { label: string; sum: number }) => {",
        "  return `${data.label}: ${data.sum}`;",
        "});",
        "",
        "// The pattern argument type is the value type",
        "export default pattern<{ data: { values: number[]; label: string } }>(",
        "  ({ data }) => {",
        "    const sum = computeSum(data);",
        "    const result = formatResult({ label: data.label, sum });",
        "    return { sum, result };",
        "  }",
        ");",
      ].join("\n"),
    },
  ],
};

const inputDataSchema: JSONSchema = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
    label: { type: "string" },
  },
  required: ["values", "label"],
};

type InputData = { values: number[]; label: string };
type ResultData = { sum: number; result: string };

//
// Helper types and functions
//

interface TestContext {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.open>;
}

function createTestContext(identity: Identity): TestContext {
  const storageManager = StorageManager.open({
    as: identity,
    memoryHost: new URL(API_URL),
  });
  const runtime = new Runtime({
    apiUrl: API_URL,
    // The posture this client runs (server-execution v2, testing.md §2):
    // resolved exactly like a deployed entry point — the canonical env
    // mapping, else the first-party default (ON since the flip) — so this
    // process runs the arm the lane's toolshed runs: the DEFAULT lane's
    // unset flag resolves ON, the OFF regression-guard lane's explicit
    // `false` the OFF arm. A bare construction resolves the AMBIENT
    // baseline instead, which post-flip is the P7 review's finding-7
    // mixed posture.
    experimental: withServerExecutionDefault(
      experimentalOptionsFromEnv(Deno.env.get),
    ),
    storageManager,
  });
  return { runtime, storageManager };
}

async function disposeTestContext(ctx: TestContext): Promise<void> {
  await ctx.runtime.dispose();
  await ctx.storageManager.close();
}

function getInputCell(
  runtime: Runtime,
  space: MemorySpace,
  cellId: string,
  tx?: ReturnType<Runtime["edit"]>,
): Cell<InputData> {
  return runtime.getCell(space, cellId, inputDataSchema, tx);
}

function getResultCell(
  runtime: Runtime,
  space: MemorySpace,
  cellId: string,
  tx?: ReturnType<Runtime["edit"]>,
): Cell<ResultData> {
  return runtime.getCell<ResultData>(space, cellId, undefined, tx);
}

//
// Phase functions
//

/**
 * Phase 1: Save pattern and initial data to storage.
 * Returns the pattern ID for use in subsequent phases.
 */
async function phase1SavePatternAndData(
  identity: Identity,
  space: MemorySpace,
): Promise<PatternRef> {
  console.log("\n--- Phase 1: Save pattern and data ---");

  const ctx = createTestContext(identity);

  // Compile the pattern INTO the space: this persists the content-addressed
  // source + compiled docs (the single durable source), so a fresh runtime can
  // recover the pattern by its `{ identity, symbol }` pointer.
  const compiled = await ctx.runtime.patternManager.compilePattern(
    patternProgram,
    { space },
  );
  const patternRef = ctx.runtime.patternManager.getArtifactEntryRef(compiled);
  if (!patternRef) throw new Error("compiled pattern has no entry ref");
  await ctx.runtime.patternManager.flushCompileCacheWrites();
  await ctx.runtime.storageManager.synced();
  console.log(`Pattern saved with identity: ${patternRef.identity}`);

  // Save initial data for Phase 2's instance
  const dataCell = getInputCell(ctx.runtime, space, INPUT_CELL_ID_PHASE_2);
  const initialData: InputData = { values: [1, 2, 3, 4, 5], label: "Numbers" };
  const tx = ctx.runtime.edit();
  dataCell.withTx(tx).set(initialData);
  await tx.commit().settled;
  await ctx.runtime.storageManager.synced();
  console.log("Data saved:", initialData);

  await disposeTestContext(ctx);
  console.log("Runtime 1 disposed (cache cleared)");

  return patternRef;
}

/**
 * Phase 2: Load pattern and data from storage, run pattern, verify output.
 */
async function phase2LoadAndVerify(
  identity: Identity,
  space: MemorySpace,
  patternRef: PatternRef,
): Promise<void> {
  console.log("\n--- Phase 2: Load pattern and data from storage ---");

  const ctx = createTestContext(identity);

  // Load pattern from storage by content identity (fresh cache)
  const pattern = await ctx.runtime.patternManager.loadPatternByIdentity(
    patternRef.identity,
    patternRef.symbol,
    space,
  );
  if (!pattern) throw new Error("pattern failed to load by identity");
  console.log("Pattern loaded from storage");

  // Load data cell from storage
  const dataCell = getInputCell(ctx.runtime, space, INPUT_CELL_ID_PHASE_2);
  await dataCell.sync();
  console.log(`Data loaded: ${JSON.stringify(dataCell.get())}`);

  // Create result cell and run pattern
  const resultCell = getResultCell(ctx.runtime, space, RESULT_CELL_ID_PHASE_2);
  const tx = ctx.runtime.edit();
  const runResult = ctx.runtime.run(
    tx,
    pattern,
    { data: dataCell },
    resultCell,
  );
  await tx.commit().settled;
  const pulled = await runResult.pull();

  const output = runResult.getAsQueryResult();
  console.log(`Pulled result: ${JSON.stringify(pulled)}`);
  console.log(`Computed result: ${JSON.stringify(output)}`);

  // Verify
  assertEquals(output.sum, 15, "Sum should be 1+2+3+4+5=15");
  assertEquals(
    output.result,
    "Numbers: 15",
    "Result should be formatted correctly",
  );

  // Sync to storage so Phase 3 can load this instance
  await ctx.runtime.storageManager.synced();

  await disposeTestContext(ctx);
  console.log("Runtime 2 disposed (cache cleared)");
}

/**
 * Phase 3: Create a second pattern instance with its own input cell, verify
 * reactivity within the same session, AND verify that updating this instance's
 * input does NOT affect Phase 2's instance.
 */
async function phase3ReactivityAndIsolation(
  identity: Identity,
  space: MemorySpace,
  patternRef: PatternRef,
): Promise<void> {
  console.log("\n--- Phase 3: Reactivity and instance isolation ---");

  const ctx = createTestContext(identity);

  // Load pattern from storage by content identity (fresh cache)
  const pattern = await ctx.runtime.patternManager.loadPatternByIdentity(
    patternRef.identity,
    patternRef.symbol,
    space,
  );
  if (!pattern) throw new Error("pattern failed to load by identity");
  console.log("Pattern loaded from storage (third runtime)");

  // Create a NEW input cell for Phase 3's instance (same initial values)
  const dataCell3 = getInputCell(ctx.runtime, space, INPUT_CELL_ID_PHASE_3);
  const resultCell3 = getResultCell(ctx.runtime, space, RESULT_CELL_ID_PHASE_3);

  // Set up Phase 3's pattern instance (writes need transaction)
  let tx = ctx.runtime.edit();
  const initialData: InputData = { values: [1, 2, 3, 4, 5], label: "Numbers" };
  dataCell3.withTx(tx).set(initialData);
  console.log("Created new input cell for Phase 3:", initialData);

  const runResult3 = ctx.runtime.run(
    tx,
    pattern,
    { data: dataCell3 },
    resultCell3,
  );

  const phase3Commit = await tx.commit().settled;
  assert(
    phase3Commit.ok,
    `Phase 3 setup commit failed: ${JSON.stringify(phase3Commit)}`,
  );

  // Also load and start Phase 2's instance to verify isolation
  // NOTE: This sync is required - without it, Phase 2's pattern sees undefined inputs
  // because the input cell data isn't auto-loaded from storage.
  const dataCell2 = getInputCell(ctx.runtime, space, INPUT_CELL_ID_PHASE_2);
  await dataCell2.sync();

  const resultCell2 = getResultCell(ctx.runtime, space, RESULT_CELL_ID_PHASE_2);
  await ctx.runtime.start(resultCell2);
  console.log("Started Phase 2's instance for isolation check");
  await runResult3.pull();
  await resultCell2.pull();

  // Verify both instances have initial state
  const phase3Before = runResult3.getAsQueryResult();
  const phase2Before = resultCell2.getAsQueryResult();
  console.log("Phase 3 result before update: sum =", phase3Before.sum);
  console.log("Phase 2 result before update: sum =", phase2Before.sum);

  assertEquals(phase3Before.sum, 15, "Phase 3 sum should be 15");
  assertEquals(phase2Before.sum, 15, "Phase 2 sum should be 15");

  // Update Phase 3's input data (NOT Phase 2's)
  const updatedData: InputData = { values: [10, 20, 30], label: "Big numbers" };
  console.log("Updating Phase 3's input to:", updatedData);

  tx = ctx.runtime.edit();
  dataCell3.withTx(tx).set(updatedData);
  await tx.commit().settled;

  // Wait for reactivity to propagate
  await runResult3.pull();
  await resultCell2.pull();

  const phase3After = runResult3.getAsQueryResult();
  const phase2After = resultCell2.getAsQueryResult();
  console.log("Phase 3 result after update: sum =", phase3After.sum);
  console.log("Phase 2 result after update: sum =", phase2After.sum);

  // Verify Phase 3's instance reacted to its input change
  assertEquals(phase3After.sum, 60, "Phase 3 sum should be 10+20+30=60");
  assertEquals(
    phase3After.result,
    "Big numbers: 60",
    "Phase 3 result should reflect updated data",
  );

  // Verify Phase 2's instance did NOT change (isolation)
  assertEquals(
    phase2After.sum,
    15,
    "Phase 2 sum should still be 15 (isolation)",
  );
  assertEquals(
    phase2After.result,
    "Numbers: 15",
    "Phase 2 result should be unchanged (isolation)",
  );

  // Sync to storage before disposing so Phase 4 can see the changes
  await ctx.runtime.storageManager.synced();

  await disposeTestContext(ctx);
  console.log("Runtime 3 disposed (cache cleared)");
}

/**
 * Phase 4: Cross-session reactivity - create a NEW runtime, load the result
 * cell from Phase 3, start the existing pattern instance, update the input,
 * and verify the result updates reactively.
 *
 * This demonstrates that:
 * - A pattern instance can be resumed from storage in a fresh runtime
 * - Updating the input cell causes the result to update reactively
 */
async function phase4CrossSessionReactivity(
  identity: Identity,
  space: MemorySpace,
): Promise<void> {
  console.log("\n--- Phase 4: Cross-session reactivity ---");

  const ctx = createTestContext(identity);

  // Load the result cell from Phase 3 (by the same cause/ID)
  const resultCell = getResultCell(ctx.runtime, space, RESULT_CELL_ID_PHASE_3);

  // Start the existing pattern instance - this rehydrates the reactive graph
  await ctx.runtime.start(resultCell);
  console.log("Started existing pattern instance");

  // Load Phase 3's input cell
  const dataCell = getInputCell(ctx.runtime, space, INPUT_CELL_ID_PHASE_3);
  await dataCell.sync();

  // Verify current state (should be from Phase 3's update: sum=60)
  await resultCell.pull();
  const before = resultCell.getAsQueryResult();
  console.log(
    "Result before update: sum =",
    before.sum,
    ", result =",
    before.result,
  );
  assertEquals(before.sum, 60, "Sum should be 60 from Phase 3");
  assertEquals(before.result, "Big numbers: 60");

  // Now update the input in this new runtime
  const newData: InputData = { values: [100, 200], label: "Hundreds" };
  console.log("Updating data to:", newData);

  const tx = ctx.runtime.edit();
  dataCell.withTx(tx).set(newData);
  await tx.commit().settled;

  // Wait for reactivity to propagate
  await resultCell.pull();

  const after = resultCell.getAsQueryResult();
  console.log(
    "Result after update: sum =",
    after.sum,
    ", result =",
    after.result,
  );

  // Verify the pattern reacted to the data change across sessions
  assertEquals(after.sum, 300, "Sum should be 100+200=300");
  assertEquals(
    after.result,
    "Hundreds: 300",
    "Result should reflect updated data",
  );

  await disposeTestContext(ctx);
  console.log("Runtime 4 disposed");
}

//
// Main test
//

async function testPatternAndDataPersistence() {
  console.log("\n=== TEST: Pattern and Data Persistence ===");

  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `pattern-data-persistence-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  const patternRef = await phase1SavePatternAndData(identity, space);
  await phase2LoadAndVerify(identity, space, patternRef);
  await phase3ReactivityAndIsolation(identity, space, patternRef);
  await phase4CrossSessionReactivity(identity, space);

  console.log("\n=== TEST PASSED ===");
}

Deno.test({
  name: "pattern and data persistence - full reactive cycle",
  fn: testPatternAndDataPersistence,
  sanitizeResources: false,
  sanitizeOps: false,
});
