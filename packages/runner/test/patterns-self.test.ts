// SELF references: patterns that reference their own output cell for
// self-referential data structures, serialization, and type inference.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

// Import types from public API for compile-time type tests
import { type Reactive } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { type JSONSchema, SELF } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - SELF", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    ({
      pattern,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should provide SELF reference in pattern for self-referential types", async () => {
    // Define schemas using JSON schema notation
    const InputSchema = {
      type: "object",
      properties: {
        label: { type: "string", default: "Node" },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        label: { type: "string" },
        children: {
          type: "array",
          items: { type: "object" }, // Self-referential
          default: [],
        },
        hasSelf: { type: "boolean" },
      },
    } as const satisfies JSONSchema;

    // Create a pattern that uses SELF
    const treeNodePattern = pattern(
      (input: any) => {
        const label = input.label;
        const self = input[SELF];

        // children typed as array of self
        const children = [] as (typeof self)[];

        return {
          label,
          children,
          hasSelf: self !== undefined,
        };
      },
      InputSchema,
      OutputSchema,
    );

    const resultCell = runtime.getCell<{
      label: string;
      children: any[];
      hasSelf: boolean;
    }>(
      space,
      "should provide SELF reference in pattern",
      OutputSchema,
      tx,
    );

    const result = runtime.run(
      tx,
      treeNodePattern,
      { label: "Root" },
      resultCell,
    );
    tx.commit();

    const value = await result.pull();

    // Verify SELF was available
    expect(value.hasSelf).toBe(true);
    expect(value.label).toBe("Root");
    expect(value.children).toEqual([]);
  });

  it("should serialize SELF reference to resultRef path", () => {
    const InputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        self: { type: "object" },
      },
    } as const satisfies JSONSchema;

    // Pattern that exposes self in output
    const selfRefPattern = pattern(
      (input: any) => {
        const self = input[SELF];
        return {
          name: input.name,
          self, // Expose the self reference
        };
      },
      InputSchema,
      OutputSchema,
    );

    // Check the serialized pattern structure
    const serialized = JSON.parse(JSON.stringify(selfRefPattern));

    // The self field in the result should be an alias to result
    expect(serialized.result.self.$alias.cell).toEqual("result");
    expect(serialized.result.self.$alias.path).toEqual([]);
  });

  it("should allow SELF in pattern function as well as pattern", async () => {
    const InputSchema = {
      type: "object",
      properties: {
        value: { type: "number", default: 0 },
      },
    } as const satisfies JSONSchema;

    const OutputSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        selfAvailable: { type: "boolean" },
      },
    } as const satisfies JSONSchema;

    // Pattern (not pattern) that uses SELF
    const selfPattern = pattern(
      (input: any) => {
        const self = input[SELF];
        return {
          value: input.value,
          selfAvailable: self !== undefined,
        };
      },
      InputSchema,
      OutputSchema,
    );

    const resultCell = runtime.getCell<{
      value: number;
      selfAvailable: boolean;
    }>(
      space,
      "should allow SELF in pattern function",
      OutputSchema,
      tx,
    );

    const result = runtime.run(tx, selfPattern, { value: 42 }, resultCell);
    tx.commit();

    const value = await result.pull();

    expect(value.selfAvailable).toBe(true);
    expect(value.value).toBe(42);
  });

  it("should correctly infer SELF type (TypeScript types, compile-time check)", () => {
    // This test verifies SELF type inference using the PUBLIC API types from @commonfabric/api
    // The @ts-expect-error directives verify that SELF is NOT typed as `any`
    // If SELF were `any`, the "wrong type" assignments would succeed,
    // making @ts-expect-error unused - which is itself a compile error

    interface TreeNode {
      name: string;
      children: TreeNode[];
    }

    const treePattern = pattern<{ name: string }, TreeNode>(
      ({ name, [SELF]: self }) => {
        // Positive type tests: these assignments SHOULD work
        const _correctType: Reactive<TreeNode> = self;
        const _correctChildren: Reactive<TreeNode[]> = self.children;
        const _correctName: Reactive<string> = self.name;

        // Negative type tests: these should NOT work (verified by @ts-expect-error)
        // If self were ApiReactive<any>, these would succeed, making @ts-expect-error unused
        // @ts-expect-error - self should not be assignable to ApiReactive<{ wrong: true }>
        const _wrongType: Reactive<{ wrong: true }> = self;
        // @ts-expect-error - children should not be assignable to ApiReactive<string[]>
        const _wrongChildren: Reactive<string[]> = self.children;

        // Use self in the return type
        const children: (typeof self)[] = [];

        return { name, children };
      },
    );

    // Verify it's a valid pattern at runtime
    expect(treePattern).toBeDefined();
    expect(typeof treePattern).toBe("function");
  });
});
