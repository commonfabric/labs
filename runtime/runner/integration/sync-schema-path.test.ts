#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert/equals";
import {
  experimentalOptionsFromEnv,
  type JSONSchema,
  type MemorySpace,
  type NormalizedLink,
  Runtime,
  type URI,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { Identity, type IdentityCreateConfig } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { parseLink } from "../src/link-utils.ts";
import { IStorageManager } from "../src/storage/interface.ts";
const { API_URL } = env;

// Create test identity
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};
const identity = await Identity.fromPassphrase("test operator", keyConfig);

console.log("\n=== TEST: Sync Schema uses Path ===");

function read(
  storageManager: IStorageManager,
  space: MemorySpace,
  id: URI,
) {
  const tx = storageManager.edit();
  const { ok: value } = tx.read({
    space,
    type: "application/json",
    id,
    path: ["value"],
  });
  return value?.value;
}

async function test() {
  const runId = crypto.randomUUID();
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
  const addressSchema = {
    type: "object",
    properties: {
      "city": { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;
  const employeeSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;
  const addressesArraySchema = {
    type: "array",
    items: addressSchema,
  } as const satisfies JSONSchema;
  const employeAddressesSchema = {
    type: "object",
    properties: {
      "addresses": addressesArraySchema,
    },
    required: ["addresses"],
  } as const satisfies JSONSchema;

  const space = identity.did();

  // Create an employee cell that has an address
  let tx = runtime1.edit();
  const testEmployeeCell = runtime1.getCell(
    space,
    `storage test employee cell ${runId}`,
    employeeSchema,
    tx,
  );
  const employeeData = {
    name: "Bob",
    address: { city: "Los Angeles" },
  };
  testEmployeeCell.set(employeeData);
  assertEquals(await tx.commit().settled, { ok: {} });

  // Create a cell that points to the address portion of that cell
  tx = runtime1.edit();
  const testAddressesCell = runtime1.getCell(
    space,
    `storage test addresses cell ${runId}`,
    employeAddressesSchema,
    tx,
  );
  testAddressesCell.set({ addresses: [testEmployeeCell.key("address")] });
  assertEquals(await tx.commit().settled, { ok: {} });

  await testAddressesCell.sync();
  await testEmployeeCell.sync();

  await runtime1.storageManager.synced();
  await runtime1.dispose();

  const addressesArrayCell1 = testAddressesCell.key("addresses");
  const addressesArrayCellLink1 = addressesArrayCell1.getAsNormalizedFullLink();

  // Attempt to load on runtime2
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
  const runtime2Tx = runtime2.edit();

  const addressesArrayCell2 = runtime2.getCellFromLink(
    addressesArrayCellLink1,
    addressesArraySchema,
    runtime2Tx,
  );
  const newCell = await addressesArrayCell2.sync();
  await runtime2.storageManager.synced();

  // At this point, we should have the employee's cell in our heap.
  // I don't want to use the sync system, since that will autoload,
  // so instead I'll extract the link myself, and check in the heap.
  // This will be the link to the employee's address field
  const sigilLink = JSON.parse(JSON.stringify(newCell.key(0).getRaw()));
  // The stored link elides what it shares with the slot holding it, so it has
  // to be parsed against that slot to recover the space it lives in.
  const normalizedLink = parseLink(
    sigilLink,
    newCell.key(0),
  ) as NormalizedLink;
  const record = read(
    runtime2.storageManager,
    normalizedLink.space!,
    normalizedLink.id!,
  );
  assertEquals(record, employeeData);
  await runtime2.dispose();
}

async function runTest() {
  await test();
  console.log("\nDone");
}

Deno.test({
  name: "sync schema path test",
  fn: runTest,
  sanitizeResources: false,
  sanitizeOps: false,
});
