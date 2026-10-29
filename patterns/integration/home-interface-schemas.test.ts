/** Checks host fields, requiredness and literals against compiled Home types. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  sharedSpaceCollectionViewSchema,
  sharedSpaceEntrySchema,
  sharedSpaceProfileViewSchema,
  sharedSpaceReceiptViewSchema,
} from "@commonfabric/home-schemas";
import { Identity } from "@commonfabric/identity";
import {
  ContextualFlowControl,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

/** Collects field paths, requiredness and literal choices without producer metadata. */
function declaredFields(schema: JSONSchema): string[] {
  const fields = new Set<string>();
  const visit = (input: JSONSchema, path: string) => {
    if (typeof input === "boolean") return;
    const node = ContextualFlowControl.resolveSchemaRefsOrThrow(input, schema);
    if (typeof node === "boolean") return;
    const literals = node.enum ??
      (Object.hasOwn(node, "const") ? [node.const] : []);
    for (const value of literals) {
      fields.add(`${path}:literal:${JSON.stringify(value)}`);
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const at = `${path}/${name}`;
      fields.add(
        `${at}:${node.required?.includes(name) ? "required" : "optional"}`,
      );
      visit(child, at);
    }
    if (node.items && !Array.isArray(node.items)) {
      visit(node.items, `${path}[]`);
    }
    if (typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, `${path}/*`);
    }
    for (const arm of node.anyOf ?? []) visit(arm, path);
  };
  visit(schema, "");
  return [...fields].sort();
}

describe("Home interface schemas", () => {
  it("keeps authored observation fields, requiredness and literal choices in the host projections", async () => {
    const owner = await Identity.fromPassphrase("Home schema drift");
    const server = newLoopbackServer();
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL(
              "./fixtures/home-interface-schemas/main.tsx",
              import.meta.url,
            ),
          ),
          root: fromFileUrl(new URL("..", import.meta.url)),
        },
      );
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(program, {
        space: owner.did(),
        tx,
      });
      const emitted = runtime.run(
        tx,
        pattern,
        {},
        runtime.getCell<Record<string, JSONSchema>>(
          owner.did(),
          "compiled schemas",
          undefined,
          tx,
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const schemas = await emitted.pull();
      for (
        const [role, host] of Object.entries({
          entry: sharedSpaceEntrySchema,
          collection: sharedSpaceCollectionViewSchema,
          receipts: sharedSpaceReceiptViewSchema,
          profiles: sharedSpaceProfileViewSchema,
        })
      ) {
        expect(schemas[role]).toBeDefined();
        expect(declaredFields(schemas[role])).toEqual(declaredFields(host));
      }
    } finally {
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });
});
