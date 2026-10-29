import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import type { JSONSchemaObj } from "@commonfabric/api";
import { resolveExternalRootRefForStructure } from "../src/index.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";

describe("resolveExternalRootRefForStructure", () => {
  it("keeps an empty $defs whose body names a local definition", () => {
    // The empty-`$defs` strip exists so a member view that gained nothing
    // from its group compares as the writer's sanitized input. Its guard is
    // the invariant that the strip can never orphan a `#/...` reference —
    // even one that already dangles, as here, where the document arrives
    // with an empty group of its own. The resolution returns the document
    // as stored, dangling reference and all.
    const document = {
      type: "array",
      items: { $ref: "#/$defs/Row" },
      $defs: {},
    } as const satisfies JSONSchemaObj;
    const hash = internSchemaAsTaggedHashString(document);
    registerSchemaDocument(hash, document);

    const resolved = resolveExternalRootRefForStructure({
      $ref: `cid:${hash}`,
    });

    expect(resolved.$defs).toEqual({});
    expect((resolved.items as JSONSchemaObj).$ref).toBe("#/$defs/Row");
  });
});
