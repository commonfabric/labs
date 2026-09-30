// Stream and promise support tests: verifying that stream cells and
// running promises work correctly with schemas.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell, isStream } from "../src/cell.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - Streams and Promises", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Stream Support", () => {
    it("should handle nested streams in objects", () => {
      const c = runtime.getCell<{ user: { profile: { name: string } } }>(
        space,
        "should handle nested streams in objects 1",
        undefined,
        tx,
      );
      c.set({ user: { profile: { name: "John" } } });

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  notifications: {
                    type: "object",
                    asCell: ["stream"],
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value?.user?.profile?.name).toBe("John");
      expect(isStream(value?.user?.profile?.notifications)).toBe(true);
    });

    it("creates a stream for a declared stream property the value lacks", () => {
      const c = runtime.getCell<{
        name: string;
        // Missing events property
      }>(
        space,
        "creates a stream for a declared stream property the value lacks 1",
        undefined,
        tx,
      );
      c.set({
        name: "Test Doc",
        // Missing events property
      });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          events: {
            type: "object",
            asCell: ["stream"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("Test Doc");
      expect(isStream(value.events)).toBe(true);
    });

    it("should behave correctly when both asCell cell and asCell stream are in the schema", () => {
      const c = runtime.getCell<{ cellData: { value: number } }>(
        space,
        "should behave correctly when both asCell and asCell stream are in the schema 1",
        undefined,
        tx,
      );
      c.set({ cellData: { value: 42 } });

      const schema = {
        type: "object",
        properties: {
          cellData: {
            type: "object",
            asCell: ["cell"],
          },
          streamData: {
            type: "object",
            asCell: ["stream"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(isCell(value.cellData)).toBe(true);
      expect(value?.cellData?.get()?.value).toBe(42);

      expect(isStream(value.streamData)).toBe(true);
    });
  });

  describe("Running Promise", () => {
    it("should allow setting a promise when none is running", async () => {
      await runtime.idle();

      const { promise, resolve } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise;
      expect(runtime.scheduler.runningPromise).toBeDefined();
      resolve(space);
      await promise;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should throw when trying to set a promise while one is running", async () => {
      await runtime.idle();

      const { promise: promise1, resolve: resolve1 } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise1;
      expect(runtime.scheduler.runningPromise).toBeDefined();

      const { promise: promise2 } = Promise.withResolvers();
      expect(() => {
        runtime.scheduler.runningPromise = promise2;
      }).toThrow("Cannot set running while another promise is in progress");

      resolve1(space);
      await promise1;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should clear the promise after it rejects", async () => {
      await runtime.idle();

      const { promise, reject } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise.catch(() => {});

      // Now reject after the handler is in place
      reject(new Error("test error"));

      // Wait for both the rejection to be handled and the promise to be cleared
      await runtime.scheduler.runningPromise;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should allow setting undefined when no promise is running", async () => {
      await runtime.idle();

      runtime.scheduler.runningPromise = undefined;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });
  });
});
