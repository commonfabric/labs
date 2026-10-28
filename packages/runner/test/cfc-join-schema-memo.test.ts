/**
 * A join of a schema as its own document is kept per canonical schema: the
 * references it reaches are resolved on the first join and on none after it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import { ContextualFlowControl } from "../src/cfc.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";

describe("cfc-join-schema-memo", () => {
  // Releasing the registry lease clears the registry and with it every memo
  // of a resolution success, so each test joins into an empty memo.
  let release: () => void;
  let resolutions: number;
  let resolving: { restore(): void };

  beforeEach(() => {
    release = acquireSchemaRegistryLease();
    resolutions = 0;
    const original = ContextualFlowControl.resolveSchemaRefsOrThrow;
    resolving = stub(
      ContextualFlowControl,
      "resolveSchemaRefsOrThrow",
      (schema: JSONSchemaObj, fullSchema?: JSONSchema) => {
        resolutions++;
        return original(schema, fullSchema);
      },
    );
  });

  afterEach(() => {
    resolving.restore();
    release();
  });

  /** A schema whose confidentiality is reached through a reference. */
  const labeled = (): JSONSchemaObj => ({
    type: "object",
    properties: { note: { $ref: "#/$defs/Note" } },
    $defs: { Note: { type: "string", ifc: { confidentiality: ["secret"] } } },
  });

  const atomsOf = (schema: JSONSchema): unknown[] => [
    ...(ContextualFlowControl.lubSchema(schema) ?? []),
  ];

  it("resolves a schema's references on its first join and on none after it", () => {
    expect(atomsOf(labeled())).toEqual(["secret"]);
    const afterFirst = resolutions;
    expect(afterFirst).toBeGreaterThan(0);

    // A structurally equal schema is the same schema to the join.
    expect(atomsOf(labeled())).toEqual(["secret"]);
    expect(resolutions).toBe(afterFirst);
  });

  it("resolves the references of a schema it has not joined", () => {
    atomsOf(labeled());
    const afterFirst = resolutions;

    const other: JSONSchemaObj = {
      ...labeled(),
      $defs: { Note: { type: "string", ifc: { confidentiality: ["other"] } } },
    };
    expect(atomsOf(other)).toEqual(["other"]);
    expect(resolutions).toBeGreaterThan(afterFirst);
  });

  it("joins a schema again once the document its first join lacked has arrived", () => {
    const document: JSONSchemaObj = {
      type: "string",
      ifc: { confidentiality: ["remote"] },
    };
    const hash = internSchemaAsTaggedHashString(document);
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { note: { $ref: `cid:${hash}` } },
    };
    expect(() => atomsOf(schema)).toThrow();

    registerSchemaDocument(hash, document);
    expect(atomsOf(schema)).toEqual(["remote"]);
    const afterArrival = resolutions;
    expect(atomsOf(schema)).toEqual(["remote"]);
    expect(resolutions).toBe(afterArrival);
  });
});
