import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { CellKind, JSONSchema } from "@commonfabric/api";
import { isReadableCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("readable cell capability test");

Deno.test("isReadableCell follows the runtime cell capability", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });

  try {
    const kinds = [
      "cell",
      "readonly",
      "comparable",
      "opaque",
      "sqlite",
      "stream",
      "writeonly",
    ] as const satisfies readonly CellKind[];
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        kinds.map((kind) => [kind, { type: "number", asCell: [kind] }]),
      ),
      additionalProperties: false,
    } satisfies JSONSchema;
    const root = runtime.getCell(
      signer.did(),
      "readable-cell-capability",
      schema,
    );

    expect(isReadableCell(root.key("cell"))).toBe(true);
    expect(isReadableCell(root.key("readonly"))).toBe(true);
    for (const kind of kinds.slice(2)) {
      expect(isReadableCell(root.key(kind))).toBe(false);
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
