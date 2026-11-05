import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pattern scope array read schema");

// A pattern-scope `.get()` of an array cell lowers to a derived cell that
// holds the read. What schema that cell carries decides what a sync of it
// asks the server for: a trivially-permissive schema is a request for the
// cell's whole reachable graph, which is what the setup kick and the resume
// wave issue when they load it. `unknown` is the reference-only declaration
// (docs/specs/link-schema-precedence.md) — compare by identity, do not read
// through — so a view of `unknown[]` must keep that declaration rather than
// widen to everything. The view reads back as `readonly unknown[]`, and the
// schema generator used to lose the shape at the `readonly` operator.
const PROGRAM = (elements: string) => `
import { type Default, pattern, type Writable } from 'commonfabric';
export default pattern<
  { members: Writable<${elements}[] | Default<[]>> },
  { count: number }
>(({ members }) => {
  const view = members.get();
  const count = view.length;
  return { count };
});`;

describe("pattern-scope array read schema", () => {
  let server: ReturnType<typeof newSharedServer>;
  let sm: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    sm = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await sm.close();
    await server.close();
  });

  const viewDescriptor = async (elements: string) => {
    const pattern = await runtime.patternManager.compilePattern(
      PROGRAM(elements),
    );
    const descriptor = pattern.derivedInternalCells?.find((candidate) =>
      candidate.partialCause === "view"
    );
    expect(descriptor).toBeDefined();
    return descriptor!;
  };

  it("keeps a view of `unknown[]` reference-only rather than open", async () => {
    const { schema } = await viewDescriptor("unknown");
    expect(schema).toEqual({ type: "array", items: { type: "unknown" } });
    expect(ContextualFlowControl.isTrueSchema(schema!)).toBe(false);
  });

  it("keeps a view of `number[]` shaped", async () => {
    const { schema } = await viewDescriptor("number");
    expect(schema).toEqual({ type: "array", items: { type: "number" } });
  });
});
