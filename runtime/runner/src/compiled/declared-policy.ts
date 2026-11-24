/**
 * The write policies that the types of a compiled pattern declare for the
 * documents of an instance other than the result document of the instance
 * a piece was started with: the argument document of every instance, by
 * the argument type of its pattern, and the result document of an instance
 * a body or a handler made, by the result type of its pattern.
 *
 * A compiled piece writes those documents under no schema of a reference,
 * so the commit preparation would hold a write of them to no claim: a
 * handler of another pattern that is handed a cell of the argument, typed
 * with no claim, would write a position the argument type protects. The
 * adapter records the schema of the type for each transaction that writes
 * such a document, with each `ifc` record reduced to its write policies
 * (`withPoliciesAlone`), and the stored envelope of the document then
 * names it for every later writer. The shape the schema declares is kept
 * whole: a later write under the type's own schema is then a write under
 * the shape the envelope names, and no change of it.
 */
import { deepFreeze } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { JSONSchema } from "../builder/types.ts";
import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { argumentOf } from "../../../../base/pattern-compiler/exec/store.ts";
import { type ResultPolicy, writePoliciesOf } from "./result-policy.ts";

/** The write policies declared for one document. */
export type DeclaredPolicy = {
  readonly policy: ResultPolicy;
  /** Which type of the pattern declares it. */
  readonly of: "argument" | "result";
};

/** The members of `ifc` that are write policies. */
const POLICY_KEYS = [
  "writeAuthorizedBy",
  "writePolicyAnyOf",
  "uiContract",
  "addIntegrity",
];

/**
 * A copy of a schema in which each `ifc` record holds its write policies
 * and nothing else, and is left out where it holds none. The copy shares
 * no object with the schema.
 */
const withPoliciesAlone = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(withPoliciesAlone);
  if (!isObjectNotArray(node)) return node;
  const copy: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(node)) {
    if (name !== "ifc" || !isObjectNotArray(member)) {
      copy[name] = withPoliciesAlone(member);
      continue;
    }
    // A policy is copied whole: the copy is frozen, and the schema it is
    // made from is the caller's to change.
    const kept = Object.fromEntries(
      Object.entries(member).filter(([key]) => POLICY_KEYS.includes(key))
        .map(([key, policy]) => [key, structuredClone(policy)]),
    );
    if (Object.keys(kept).length > 0) copy.ifc = kept;
  }
  return copy;
};

/**
 * What `declaredBy` gave for each schema it was asked for, `null` for one
 * that declares no write policy. A handler's write asks for the schema of
 * its handle at every change, and the schemas of a plan are objects the
 * executor keeps for as long as the instance runs.
 */
const DECLARED = new WeakMap<object, ResultPolicy | null>();

/**
 * The write policies that `schema` declares, with the schema whole but for
 * its other labels, or `undefined` where it declares none. The schema it
 * gives is frozen, and is the same object each time for one `schema`.
 */
export const declaredBy = (schema: unknown): ResultPolicy | undefined => {
  if (!isObjectNotArray(schema)) return undefined;
  const known = DECLARED.get(schema);
  if (known !== undefined) return known ?? undefined;
  const policy = writePoliciesOf(schema);
  const declared = policy === undefined ? null : {
    schema: deepFreeze(withPoliciesAlone(schema)) as JSONSchema,
    claimed: policy.claimed,
  };
  DECLARED.set(schema, declared);
  return declared ?? undefined;
};

/** The schema of `artifact` that its plan names under `member`. */
const schemaOf = (
  artifact: Artifact,
  member: "argumentSchema" | "resultSchema",
): unknown => {
  const id = (artifact.plan as Record<string, unknown>)[member];
  return artifact.schemas.find((schema) => schema.id === id)?.schema;
};

/** The declared write policies of the documents of the instances of a piece. */
export class DeclaredPolicies {
  readonly #byDocument = new Map<string, DeclaredPolicy>();

  /**
   * Notes the policies of the documents of the instance `instance` of
   * `artifact`: of its argument document, and with `result` of its result
   * document, which is the document the instance is named by.
   */
  declare(instance: string, artifact: Artifact, result: boolean): void {
    const ofArgument = declaredBy(schemaOf(artifact, "argumentSchema"));
    if (ofArgument !== undefined) {
      this.#byDocument.set(argumentOf(instance), {
        policy: ofArgument,
        of: "argument",
      });
    }
    if (!result) return;
    const ofResult = declaredBy(schemaOf(artifact, "resultSchema"));
    if (ofResult !== undefined) {
      this.#byDocument.set(instance, { policy: ofResult, of: "result" });
    }
  }

  /** The policy declared for the document `doc`, where one is. */
  of(doc: string): DeclaredPolicy | undefined {
    return this.#byDocument.get(doc);
  }
}

/**
 * The argument of an instance of `artifact` with the default its argument
 * type declares for each field `argument` leaves out, and the names of the
 * fields that were filled, where the argument type declares a write policy.
 * For any other pattern, and where no field is filled, `argument` itself
 * and no name. Only the fields of the argument are filled, and nothing
 * below a field: a field the argument holds, a reference among them, is
 * left as it is.
 *
 * Today's setup writes the defaults of an argument type into the argument
 * document. A protected field then holds its default from the start, and a
 * handler's write of that value is an attempt the field's policy decides,
 * and no installation of a default
 * (`writeInstallsInitialSchemaDefault` of `cfc/prepare.ts`).
 */
export const argumentWithDefaults = (
  artifact: Artifact,
  argument: unknown,
): { argument: unknown; filled: string[] } => {
  const schema = declaredBy(schemaOf(artifact, "argumentSchema"))?.schema;
  if (
    !isObjectNotArray(schema) || !isObjectNotArray(schema.properties) ||
    (argument !== undefined && !isObjectNotArray(argument))
  ) return { argument, filled: [] };
  const held = (argument ?? {}) as Record<string, unknown>;
  const with_: Record<string, unknown> = { ...held };
  const filled: string[] = [];
  for (const [name, member] of Object.entries(schema.properties)) {
    if (
      Object.hasOwn(held, name) && held[name] !== undefined ||
      !isObjectNotArray(member) || member.default === undefined
    ) continue;
    with_[name] = structuredClone(member.default);
    filled.push(name);
  }
  return filled.length === 0
    ? { argument, filled }
    : { argument: with_, filled };
};
