import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "pattern scope object read schema",
);

// The sibling of pattern-scope-array-read-schema.test.ts for the shapes the
// node-based analyzer cannot instantiate. A pattern-scope `.get()` of a cell
// whose type contains `unknown` reads back as `Readonly<{…}>` or as a tuple;
// the transformer used to set the reliable Type aside for such a node and
// analyze the node instead, which dropped an object view's whole declared
// surface to `{}` and opened a tuple view to `true`. The descriptor the
// derived cell carries is what a sync of it asks the server for, so it must
// keep the declaration the author wrote, `unknown` members included.
const PROGRAM = (type: string, use: string) => `
import { type Default, pattern, type Writable } from 'commonfabric';
export default pattern<
  { source: Writable<${type}> },
  { n: number }
>(({ source }) => {
  const view = source.get();
  const n = ${use};
  return { n };
});`;

describe("pattern-scope object read schema", () => {
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

  const viewSchema = async (type: string, use: string) => {
    const pattern = await runtime.patternManager.compilePattern(
      PROGRAM(type, use),
    );
    const descriptor = pattern.derivedInternalCells?.find((candidate) =>
      candidate.partialCause === "view"
    );
    expect(descriptor).toBeDefined();
    return descriptor!.schema;
  };

  it("keeps an object view's members when one of them is `unknown`", async () => {
    const schema = await viewSchema(
      "{ topic: unknown; title: string } | Default<{ topic: null; title: '' }>",
      "view.title.length",
    );
    expect(schema).toEqual({
      type: "object",
      properties: { topic: { type: "unknown" }, title: { type: "string" } },
      required: ["topic", "title"],
    });
  });

  it("keeps a `Record<string, unknown>` view's value declaration", async () => {
    const schema = await viewSchema(
      "Record<string, unknown> | Default<{}>",
      "Object.keys(view).length",
    );
    // The type-based form: the record arm carries the value declaration.
    expect(JSON.stringify(schema)).toContain(
      '"additionalProperties":{"type":"unknown"}',
    );
    expect(ContextualFlowControl.isTrueSchema(schema!)).toBe(false);
  });

  it("keeps a tuple view of `unknown` reference-only rather than open", async () => {
    const schema = await viewSchema(
      "[unknown, unknown] | Default<[null, null]>",
      "view.length",
    );
    expect(schema).toEqual({ type: "array", items: { type: "unknown" } });
    expect(ContextualFlowControl.isTrueSchema(schema!)).toBe(false);
  });
});
