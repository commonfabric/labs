/**
 * The scenarios of `both-paths.ts` for the corpus: one for each module of
 * `patterns/` whose main pattern the crate accepts and whose schemas
 * declare a writer claim, a UI contract or added integrity. The corpus has
 * no steps of its own, so a scenario starts the pattern on an empty
 * argument as one principal and sends each stream of its result an event,
 * the one the corpus generates for the handler where a binding has the
 * name of the stream: once by that principal with no gesture,
 * and, where a schema of the pattern declares a UI contract, once by a
 * second principal as the gesture of the first contract found.
 */
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { Scenario, ScenarioStep } from "./both-paths.ts";
import { corpusModules, mainPattern } from "./corpus.ts";
import { generateEvent } from "./generate.ts";

/** The members of `ifc` that are write policies, as they stand in JSON. */
const POLICY = /"(writeAuthorizedBy|writePolicyAnyOf|addIntegrity|uiContract)"/;

/** A value of the type `schema` declares, with its required members. */
const valueOf = (schema: unknown, depth = 0): unknown => {
  if (!isObjectNotArray(schema) || depth > 4) return undefined;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "text";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const properties = isObjectNotArray(schema.properties)
        ? schema.properties
        : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(properties)) {
        if (required.includes(name)) members[name] = valueOf(member, depth + 1);
      }
      return members;
    }
    default:
      return undefined;
  }
};

/** The gesture of the first UI contract found in `value`. */
const gestureOf = (
  value: unknown,
): { surface: string; action: string } | undefined => {
  if (Array.isArray(value)) {
    for (const member of value) {
      const found = gestureOf(member);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObjectNotArray(value)) return undefined;
  const contract = value.uiContract;
  if (
    isObjectNotArray(contract) && typeof contract.action === "string" &&
    typeof contract.trustedPattern === "string"
  ) return { surface: contract.trustedPattern, action: contract.action };
  for (const member of Object.values(value)) {
    const found = gestureOf(member);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * The scenarios of the corpus, for the modules whose path holds `part`
 * where it is given.
 */
export const corpusScenarios = async (part?: string): Promise<Scenario[]> => {
  const scenarios: Scenario[] = [];
  for (const module of await corpusModules()) {
    if (part !== undefined && !module.module.includes(part)) continue;
    const chosen = await mainPattern(module);
    if (chosen === undefined || chosen.pattern.code === undefined) continue;
    const { plan, schemas, name } = chosen.pattern;
    if (!POLICY.test(JSON.stringify(schemas))) continue;
    const result = schemas.find((schema) =>
      schema.id === (plan as { resultSchema?: unknown }).resultSchema
    )?.schema;
    const properties = isObjectNotArray(result) &&
        isObjectNotArray(result.properties)
      ? result.properties
      : {};
    const gesture = gestureOf(schemas);
    const steps: ScenarioStep[] = [];
    for (const [member, schema] of Object.entries(properties)) {
      if (
        !isObjectNotArray(schema) || !Array.isArray(schema.asCell) ||
        !schema.asCell.includes("stream")
      ) continue;
      // The event the corpus generates for the handler of the binding that
      // has the member's name, where there is one, and otherwise a value of
      // the type the result declares for the stream.
      const binding = (plan.bindings ?? []).findIndex((bound) =>
        (bound as { name?: string }).name === member
      );
      const event = binding < 0
        ? valueOf(schema)
        : generateEvent(plan, schemas, binding);
      steps.push({ stream: member, event, as: "alice" });
      if (gesture !== undefined) {
        steps.push({ stream: member, event, trustedUi: gesture, as: "bob" });
      }
    }
    scenarios.push({
      name: `corpus${module.module}`,
      pieces: [{
        name: "piece",
        module: `patterns${module.module}`,
        ...(chosen.isDefault ? {} : { mainExport: name }),
        as: "alice",
      }],
      steps,
    });
  }
  return scenarios;
};
