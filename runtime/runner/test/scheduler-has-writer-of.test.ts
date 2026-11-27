import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("scheduler has writer of");
const space = signer.did() as MemorySpace;

describe("scheduler-has-writer-of", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  /** The document a writer declares, as its user instance's link. */
  let output: NormalizedFullLink;

  beforeEach(() => {
    storage = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    output = runtime.getCell<string>(
      space,
      "has-writer-of output",
      undefined,
      undefined,
      "user",
    ).getAsNormalizedFullLink();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /** Subscribes a node declaring a write to `output` at `scope`. */
  const subscribeWriter = (scope: "space" | "user" | "session") =>
    runtime.scheduler.subscribe(() => {}, {
      reads: [],
      shallowReads: [],
      writes: [toMemorySpaceAddress({ ...output, scope })],
    });

  /** Whether the scheduler names a writer of `output`'s instance at `scope`. */
  const hasWriterAt = (scope: "space" | "user" | "session") =>
    runtime.scheduler.hasWriterOf({ space, id: output.id, scope });

  it("returns `true` for the instance a node declares a write to", () => {
    subscribeWriter("user");

    expect(hasWriterAt("user")).toBe(true);
  });

  it("returns `true` for an instance narrower than the scope the node declares", () => {
    // A derivation declared at space scope writes its output at the scope its
    // reads narrow to, and the write index keys it by the declared scope.

    subscribeWriter("space");

    expect(hasWriterAt("user")).toBe(true);
    expect(hasWriterAt("session")).toBe(true);
  });

  it("returns `false` for a document no node declares a write to", () => {
    expect(hasWriterAt("user")).toBe(false);
  });

  it("returns `false` once the writer is unsubscribed", () => {
    const cancel = subscribeWriter("space");

    cancel();

    expect(hasWriterAt("space")).toBe(false);
  });
});
