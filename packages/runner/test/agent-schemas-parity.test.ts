/**
 * The `AgentRun` record and agent queue have two statements: the JSON schemas
 * the runtime reads and writes through, here in the runner, and the
 * pattern-facing types in `packages/patterns/system`. The runner cannot
 * import from the patterns package, so this holds the two together by
 * reading the pattern sources as text.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { AGENT_RUN_ERROR_CODES } from "../src/agent-error-codes.ts";
import {
  AGENT_RUN_STATES,
  AgentQueueIndexSchema,
  AgentRunRecordSchema,
} from "../src/builtins/agent-schemas.ts";

const read = (path: string): string =>
  Deno.readTextFileSync(new URL(path, import.meta.url));

/** The body of `export type <name> = { … };` in `source`. */
const typeBody = (source: string, name: string): string => {
  const start = source.indexOf(`export type ${name} = {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n};", start);
  return source.slice(start, end);
};

/** The body of `export type <name> = …;` in `source`. */
const unionBody = (source: string, name: string): string => {
  const start = source.indexOf(`export type ${name} =`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

/** The property names a type body declares at its top level. */
const declaredIn = (body: string): string[] =>
  [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]).toSorted();

const propertiesOf = (schema: unknown): Record<string, unknown> =>
  (schema as { properties: Record<string, unknown> }).properties;

describe("agent schemas parity", () => {
  const agentRun = read("../../patterns/system/agent-run.tsx");
  const agentQueue = read("../../patterns/system/agent-queue.tsx");

  it("names every record property in the pattern-facing `AgentRun` type", () => {
    const body = typeBody(agentRun, "AgentRun");

    expect(declaredIn(body)).toEqual(
      Object.keys(propertiesOf(AgentRunRecordSchema)).toSorted(),
    );
  });

  it("names every state and error code in the pattern-facing unions", () => {
    const states = unionBody(agentRun, "AgentRunState");
    const errorCodes = unionBody(agentRun, "AgentRunErrorCode");
    for (const state of AGENT_RUN_STATES) {
      expect(states).toContain(`| "${state}"`);
    }
    for (const code of AGENT_RUN_ERROR_CODES) {
      expect(errorCodes).toContain(`| "${code}"`);
    }
  });

  it("names every queue property in the pattern-facing queue types", () => {
    const queue = propertiesOf(AgentQueueIndexSchema);
    const output = typeBody(agentQueue, "AgentQueueOutput");
    for (const name of Object.keys(queue)) {
      expect(output).toMatch(new RegExp(`^ {2}${name}\\??:`, "m"));
    }

    const entry = typeBody(agentQueue, "AgentQueueEntry");
    const entrySchema = (queue.entries as { items: unknown }).items;
    expect(declaredIn(entry))
      .toEqual(Object.keys(propertiesOf(entrySchema)).toSorted());

    const runner = typeBody(agentQueue, "AgentRunnerEntry");
    expect(declaredIn(runner))
      .toEqual(Object.keys(propertiesOf(queue.agentRunner)).toSorted());
  });
});
