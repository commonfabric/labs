#!/usr/bin/env -S deno run -A

import {
  deepEqual,
  experimentalOptionsFromEnv,
  type JSONSchema,
  Runtime,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { Identity, IdentityCreateConfig } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
const { API_URL } = env;

// Create test identity
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};
const identity = await Identity.fromPassphrase("test operator", keyConfig);

console.log("\n=== TEST: Simple object persistence ===");

async function test() {
  // First runtime - save data
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
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
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(API_URL),
    }),
  });

  const schema = {
    type: "object",
    properties: {
      message: { type: "string" },
      count: { type: "number" },
    },
    required: ["message", "count"],
  } as const satisfies JSONSchema;

  const cause = "test-object-" + Date.now();
  const cell1 = runtime1.getCell(identity.did(), cause, schema);
  await cell1.sync();

  const tx = runtime1.edit();
  cell1.withTx(tx).set({ message: "Hello World", count: 42 });
  tx.commit();

  await runtime1.storageManager.synced();
  const cell1Contents = JSON.parse(JSON.stringify(cell1.get()));

  await runtime1.dispose();

  // Second runtime - fetch data
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
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
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(API_URL),
    }),
  });

  const cell2 = runtime2.getCell(identity.did(), cause, schema);
  await cell2.sync();
  await runtime2.storageManager.synced();

  const cell2Contents = JSON.parse(JSON.stringify(cell2.get()));

  await runtime2.dispose();

  return [cell1Contents, cell2Contents];
}

async function runTest() {
  for (let i: number = 1; i <= 20; i++) {
    const [result1, result2] = await test();
    if (!deepEqual(result1, result2)) {
      console.error("Mismatched results for iteration", i, result1, result2);
      throw new Error(`Mismatched results for iteration ${i}`);
    }
    if (i % 5 == 0) {
      console.log("completed", i, "...");
    }
  }

  console.log("\nDone");
}

Deno.test({
  name: "basic persistence test",
  fn: runTest,
  sanitizeResources: false,
  sanitizeOps: false,
});
