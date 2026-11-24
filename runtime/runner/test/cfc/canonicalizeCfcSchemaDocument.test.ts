import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";

import {
  canonicalizeCfcSchemaDocument,
  encodedLocalDefinitionRef,
} from "../../src/cfc/schema-refs.ts";

describe("canonicalizeCfcSchemaDocument()", () => {
  it("keeps apart a minted definition naming another and one naming a missing definition spelled like a class", () => {
    // Definitions are compared with each local ref written as the class of
    // the definition it names. `\u00000` is how the class of `A` would be
    // written under a one-character marker, so a ref to a missing definition
    // of that name must not read as a ref to `A`.

    const ref = encodedLocalDefinitionRef;
    const document = {
      type: "object",
      properties: {
        p: { $ref: ref("__cfc_x_1_a") },
        q: { $ref: ref("__cfc_x_2_a") },
      },
      $defs: {
        A: { type: "string" },
        __cfc_x_1_a: { $ref: ref("A") },
        __cfc_x_2_a: { $ref: ref("\u00000") },
      },
    } as const satisfies JSONSchema;

    expect(canonicalizeCfcSchemaDocument(document)).toEqual(document);
  });

  it("folds a minted definition onto another that means the same", () => {
    const ref = encodedLocalDefinitionRef;
    expect(canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        p: { $ref: ref("__cfc_x_1_a") },
        q: { $ref: ref("__cfc_x_2_a") },
      },
      $defs: {
        A: { type: "string" },
        __cfc_x_1_a: { $ref: ref("A") },
        __cfc_x_2_a: { $ref: ref("A") },
      },
    })).toEqual({
      type: "object",
      properties: {
        p: { $ref: ref("__cfc_x_1_a") },
        q: { $ref: ref("__cfc_x_1_a") },
      },
      $defs: {
        A: { type: "string" },
        __cfc_x_1_a: { $ref: ref("A") },
      },
    });
  });
});
