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
import type { GateScenario, GateStep } from "./both-paths-serving.ts";
import { corpusModules, eventOrder, mainPattern } from "./corpus.ts";
import { generateEvent, generateInputs } from "./generate.ts";
import { scenarioAudience } from "./harness.ts";
import { argumentOf } from "./values.ts";

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

/**
 * The scenarios of the two-principal gate for the corpus: one for each
 * module of `patterns/` whose main pattern the crate emits value code for,
 * whether it declares a write policy or not. The argument is the one
 * `runner-corpus.ts` generates (`generateInputs`), as plain values, and the
 * events are those it derives (`eventOrder`, `generateEvent`), each sent to
 * the stream of the result that has the name of the handler's binding, by
 * alice and bob in turn. A module the crate gives no value code, or that
 * requests an effect, is a scenario with the reason it is skipped. An event
 * whose binding no member of the result names cannot be sent by a client,
 * and is counted in the scenario's `unsent`.
 */
export const gateCorpusScenarios = async (
  part?: string,
): Promise<(GateScenario & { unsent?: number })[]> => {
  const scenarios: (GateScenario & { unsent?: number })[] = [];
  for (const module of await corpusModules()) {
    if (part !== undefined && !module.module.includes(part)) continue;
    const name = `corpus${module.module}`;
    const chosen = await mainPattern(module);
    const skipped = (skip: string) =>
      scenarios.push({ name, pieces: [], steps: [], skip });
    if (chosen === undefined) {
      skipped("exports no pattern");
      continue;
    }
    const artifact = chosen.pattern;
    const unsupported =
      (artifact.code as { unsupported?: { kind: string }[] } | undefined)
        ?.unsupported ?? [];
    if (artifact.code === undefined || unsupported.length > 0) {
      skipped(
        `the crate gives no value code${
          unsupported.length > 0 ? `: ${unsupported[0].kind}` : ""
        }`,
      );
      continue;
    }
    const { plan, schemas } = artifact;
    const operations =
      (plan as { operations?: { kind?: string }[] }).operations ?? [];
    if (operations.some(({ kind }) => kind === "effect")) {
      skipped("requests an effect, which the harness does not answer");
      continue;
    }
    const inputs = generateInputs(plan, schemas, await scenarioAudience());
    const result = schemas.find((schema) =>
      schema.id === (plan as { resultSchema?: unknown }).resultSchema
    )?.schema;
    const properties = isObjectNotArray(result) &&
        isObjectNotArray(result.properties)
      ? result.properties
      : {};
    const streams = new Set(
      Object.entries(properties).filter(([, schema]) =>
        isObjectNotArray(schema) && Array.isArray(schema.asCell) &&
        schema.asCell.includes("stream")
      ).map(([member]) => member),
    );
    const steps: GateStep[] = [];
    let unsent = 0;
    for (const binding of eventOrder(plan, "outside first")) {
      const named = (plan.bindings ?? [])[binding] as { name?: string };
      if (named?.name === undefined || !streams.has(named.name)) {
        unsent += 1;
        continue;
      }
      steps.push({
        stream: named.name,
        event: generateEvent(plan, schemas, binding) as GateStep["event"],
        as: steps.length % 2 === 0 ? "alice" : "bob",
      });
    }
    scenarios.push({
      name,
      pieces: [{
        name: "piece",
        module: `patterns${module.module}`,
        ...(chosen.isDefault ? {} : { mainExport: artifact.name }),
        argument: argumentOf({ argument: {}, inputs }),
        as: "alice",
      }],
      steps,
      ...(unsent === 0 ? {} : { unsent }),
    });
  }
  return scenarios;
};
