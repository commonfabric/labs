#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run

/**
 * Integration test to reproduce memory leak when using derive() with array.map()
 *
 * Bug: When a cell updates repeatedly and a derived array is created for each update,
 * the old derived arrays are never garbage collected, causing unbounded memory growth.
 *
 * Expected behavior: Memory should stabilize or grow modestly
 * Actual behavior: Memory grows by gigabytes (1GB+ per 100 increments)
 */

import { Identity, Session } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { env } from "@commonfabric/integration";
import { PiecesController } from "@commonfabric/piece/ops";

import { compileAndSavePattern, Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const SPACE_NAME_PREFIX = "runner_integration";

// Test parameters
const INCREMENTS_PER_CLICK = 50; // How many times each click increments (must match .tsx file)
const MAX_MEMORY_INCREASE_RATIO = 2.0; // Fail ratio

console.log("Derive Array Leak Test");
console.log(`Connecting to: ${API_URL}`);
console.log(`Will increment ${INCREMENTS_PER_CLICK} times in one click`);

// Helper to get server process memory (portable across Linux and macOS)
async function getServerMemoryMB(): Promise<number> {
  // Try to find toolshed process - it could be either:
  // 1. Compiled binary: "toolshed" (in CI)
  // 2. Deno script: "deno run --unstable-otel" (local dev)
  let pid: string | undefined;

  // First try compiled binary (CI)
  const pgrepBinary = new Deno.Command("pgrep", {
    args: ["-f", "toolshed"],
    stdout: "piped",
  });
  const { stdout: binaryOut, code: binaryCode } = await pgrepBinary.output();

  if (binaryCode === 0 && binaryOut && binaryOut.length > 0) {
    const pids = new TextDecoder().decode(binaryOut).trim().split("\n");
    // Find the toolshed process (not grep itself)
    pid = pids.find((p) => p && p.trim() !== "");
  }

  // If not found, try Deno script (local dev)
  if (!pid) {
    const pgrepDeno = new Deno.Command("pgrep", {
      args: ["-f", "deno run --unstable-otel"],
      stdout: "piped",
    });
    const { stdout: denoOut, code: denoCode } = await pgrepDeno.output();

    if (denoCode === 0 && denoOut && denoOut.length > 0) {
      pid = new TextDecoder().decode(denoOut).trim().split("\n")[0];
    }
  }

  if (!pid || pid.trim() === "") {
    throw new Error(
      "Could not find toolshed server process. Make sure the server is running.",
    );
  }

  // Then get RSS using portable ps -o format (works on Linux, macOS, BSD)
  const psProcess = new Deno.Command("ps", {
    args: ["-p", pid, "-o", "rss="],
    stdout: "piped",
  });
  const { stdout: psOut } = await psProcess.output();
  const rssKB = parseInt(new TextDecoder().decode(psOut).trim());

  return rssKB / 1024; // Convert KB to MB
}

// Main test function
async function runTest() {
  // The space-name derivation, which supports the legacy space names used
  // during development and nothing else. It is removed once those
  // development-only spaces have been migrated
  // (docs/plans/random-space-identities.md).
  const account = await Identity.fromPassphrase("common user");
  const spaceName = `${SPACE_NAME_PREFIX}-${crypto.randomUUID()}`;
  const space_thingy = await account.derive(spaceName);
  const space_thingy_space = space_thingy.did();
  const session = {
    isPrivate: false,
    spaceName,
    space: space_thingy_space,
    as: space_thingy,
  } as Session;

  // Create storage manager
  const storageManager = StorageManager.open({
    as: session.as,
    memoryHost: new URL(API_URL),
  });

  // Create runtime
  const runtime = new Runtime({
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
    storageManager,
  });

  // Create the pieces controller for the specified space
  const pieces = new PiecesController(session, runtime);
  await pieces.ready;

  // Read the pattern file content
  const patternContent = await Deno.readTextFile(
    "./integration/derive_array_leak.tsx",
  );

  const pattern = await compileAndSavePattern(
    runtime,
    patternContent,
    { space: space_thingy_space },
  );
  console.log("Pattern compiled successfully");

  const piece = (await pieces.runPersistent(pattern, {})).asSchema({
    type: "object",
    properties: {
      value: { type: "number" },
      increment: {
        asCell: ["stream"],
      },
    },
    required: ["value", "increment"],
  });
  console.log("Piece created:", piece.entityId);

  // Settle the piece's initialization writes before sampling the baseline.
  // runtime.idle() drains client-side reactivity; synced() then waits for every
  // pending commit to be confirmed durable by the memory server. The
  // after-measurement below settles the same way, so both samples follow the
  // same barrier.
  await runtime.idle();
  await runtime.storageManager.synced();

  // Measure baseline server memory (where the leak occurs)
  const serverMemoryBeforeMB = await getServerMemoryMB();
  console.log(`Baseline server memory: ${serverMemoryBeforeMB.toFixed(1)} MB`);
  console.log(`Initial counter value: ${piece.get().value}`);

  // Trigger the leak by incrementing
  // The handler increments INCREMENTS_PER_CLICK times per click
  console.log(
    `Clicking increment (${INCREMENTS_PER_CLICK} increments total)...`,
  );
  const incrementStream = piece.key("increment");
  incrementStream.send({});

  // Wait for all updates to complete
  console.log("Waiting for runtime to finish...");
  await runtime.idle();
  await runtime.storageManager.synced();
  console.log(`Final counter value: ${piece.get().value}`);

  // Verify the counter actually incremented
  const finalValue = piece.get().value;
  const expectedValue = INCREMENTS_PER_CLICK;
  if (finalValue !== expectedValue) {
    console.warn(
      `WARNING: Counter value is ${finalValue}, expected ${expectedValue}. ` +
        `This may indicate the derive action failed due to array size.`,
    );
  }

  // Measure server memory after operations complete
  const serverMemoryAfterMB = await getServerMemoryMB();
  const serverMemoryIncreaseMB = serverMemoryAfterMB - serverMemoryBeforeMB;
  const memoryRatio = serverMemoryAfterMB / serverMemoryBeforeMB;

  console.log(`Final server memory: ${serverMemoryAfterMB.toFixed(1)} MB`);
  console.log(
    `Server memory increase: ${serverMemoryIncreaseMB.toFixed(1)} MB (${
      ((memoryRatio - 1) * 100).toFixed(1)
    }% increase)`,
  );
  console.log(`Memory ratio: ${memoryRatio.toFixed(2)}x`);

  // Clean up
  await runtime.dispose();
  await storageManager.close();

  // Check if server memory increase indicates a leak
  if (memoryRatio > MAX_MEMORY_INCREASE_RATIO) {
    console.error(
      `FAIL: Server memory increased to ${memoryRatio.toFixed(2)}x baseline, ` +
        `exceeds limit of ${MAX_MEMORY_INCREASE_RATIO}x`,
    );
    console.error("This indicates a memory leak is present");
    throw new Error(
      `Memory leak detected: ${
        memoryRatio.toFixed(2)
      }x increase (limit: ${MAX_MEMORY_INCREASE_RATIO}x)`,
    );
  }

  console.log(
    `PASS: Memory increase ${
      memoryRatio.toFixed(2)
    }x is within acceptable limit (< ${MAX_MEMORY_INCREASE_RATIO}x)`,
  );
  console.log(`Counter reached ${finalValue} (expected ${expectedValue})`);
}

// The test runs without a per-test deadline. See
// docs/development/waiting-in-tests.md.
Deno.test({
  name: "derive array leak test",
  fn: runTest,
  sanitizeResources: false,
  sanitizeOps: false,
});
