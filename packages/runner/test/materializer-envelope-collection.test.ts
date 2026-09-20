/**
 * Pins the brand/path filtering of the materializer envelope collector
 * (`collectWritableCellArgumentLinks`): only `cell`/`writeonly`-branded
 * argument-schema positions whose paths overlap `materializerWriteInputPaths`
 * become envelopes. Stream-branded positions never do — a stream send writes
 * no address, so a send-classified write path in the metadata must not
 * materialize an envelope at the stream address. This is the runner half of
 * the transformer-side emission pin ("send-only computed keeps stream paths
 * in write metadata but never brands them collectible" in ts-transformers'
 * pipeline-regressions).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { trustExecutable } from "./support/trusted-builder.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase(
  "materializer envelope collection",
);
const space = signer.did();

describe("materializer envelope collection", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // The fixtures' schemas are plain literals; they declare themselves here,
  // where the walk is handed them.
  const collect = (
    argumentSchema: unknown,
    inputs: unknown,
    resultCell: Cell<any>,
    writeInputPaths?: readonly (readonly string[])[],
  ): NormalizedFullLink[] =>
    runtime.runner.accessForTestingOnly.collectWritableCellArgumentLinks(
      argumentSchema as JSONSchema | undefined,
      inputs,
      resultCell,
      writeInputPaths,
    );

  const setup = () => {
    const resultCell = runtime.getCell(space, "envelope-result");
    const notifyCell = runtime.getCell(space, "envelope-notify-stream");
    const targetCell = runtime.getCell<number>(space, "envelope-target");
    const argumentSchema = {
      type: "object",
      properties: {
        notify: { asCell: ["stream"] },
        target: { type: "number", asCell: ["cell"] },
      },
    };
    const inputs = {
      notify: notifyCell.getAsWriteRedirectLink({ base: resultCell }),
      target: targetCell.getAsWriteRedirectLink({ base: resultCell }),
    };
    return { resultCell, targetCell, argumentSchema, inputs };
  };

  it("collects cell-branded write paths but prunes stream-branded ones", () => {
    const { resultCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["notify"],
      ["target"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("collects nothing for a send-only write-path set", () => {
    // The send-only computed shape: analyzed write metadata names only the
    // stream. The cell-branded arg does not path-match, the stream path does
    // not brand-match — "collect none" is the correct, precise result (more
    // precise than the opaque-result fallback's collect-all-writable-args).
    const { resultCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["notify"],
    ]);
    expect(envelopes).toEqual([]);
  });

  it("collects the cell-branded path when the metadata names it alone", () => {
    const { resultCell, targetCell, argumentSchema, inputs } = setup();
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["target"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("collects from undeclared keys via an additionalProperties grant", () => {
    // The rest claim covers only keys `properties` does not declare.
    const resultCell = runtime.getCell(space, "envelope-map-result");
    const targetCell = runtime.getCell<number>(space, "envelope-map-target");
    const declaredCell = runtime.getCell<number>(space, "envelope-map-decl");
    const argumentSchema = {
      type: "object",
      properties: {
        bag: {
          type: "object",
          properties: { declared: { type: "number" } },
          additionalProperties: { type: "number", asCell: ["cell"] },
        },
      },
    };
    const inputs = {
      bag: {
        declared: declaredCell.getAsWriteRedirectLink({ base: resultCell }),
        extra: targetCell.getAsWriteRedirectLink({ base: resultCell }),
      },
    };
    const envelopes = collect(argumentSchema, inputs, resultCell, [["bag"]]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("collects items-covered elements past the tuple slots at their index", () => {
    const resultCell = runtime.getCell(space, "envelope-rest-result");
    const targetCell = runtime.getCell<number>(space, "envelope-rest-target");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number", asCell: ["cell"] },
        },
      },
    };
    const inputs = {
      route: ["label", targetCell.getAsWriteRedirectLink({ base: resultCell })],
    };
    const envelopes = collect(argumentSchema, inputs, resultCell, [["route"]]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("falls back conservatively when value and schema misalign", () => {
    // A non-array value under a tuple/items schema and a non-record value
    // under an additionalProperties schema take the same-value/same-path
    // conservative visits.
    const resultCell = runtime.getCell(space, "envelope-misaligned-result");
    const targetCell = runtime.getCell<number>(space, "envelope-mis-target");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "number", asCell: ["cell"] }],
          items: { type: "number" },
        },
        bag: {
          type: "object",
          additionalProperties: { type: "number", asCell: ["cell"] },
        },
      },
    };
    const inputs = {
      // Misaligned: a single link where the schema says array/record.
      route: targetCell.getAsWriteRedirectLink({ base: resultCell }),
      bag: targetCell.getAsWriteRedirectLink({ base: resultCell }),
    };
    const envelopes = collect(argumentSchema, inputs, resultCell, [
      ["route"],
      ["bag"],
    ]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);

    // Primitive values under rest schemas take the conservative visit and
    // collect nothing.
    expect(collect(argumentSchema, { route: 1, bag: 2 }, resultCell, [
      ["route"],
      ["bag"],
    ])).toEqual([]);
  });

  it("descends combinator branches at the same position", () => {
    const resultCell = runtime.getCell(space, "envelope-anyof-result");
    const targetCell = runtime.getCell<number>(space, "envelope-anyof-target");
    const argumentSchema = {
      type: "object",
      properties: {
        target: {
          anyOf: [
            { type: "number" },
            { type: "number", asCell: ["cell"] },
          ],
        },
      },
    };
    const inputs = {
      target: targetCell.getAsWriteRedirectLink({ base: resultCell }),
    };
    const envelopes = collect(argumentSchema, inputs, resultCell, [["target"]]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });

  it("collects cell-branded tuple (prefixItems) slot positions", () => {
    // The walk descends `prefixItems`, so a `cell` brand in a tuple slot is
    // collected as an envelope.
    const resultCell = runtime.getCell(space, "envelope-tuple-result");
    const targetCell = runtime.getCell<number>(space, "envelope-tuple-target");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "number", asCell: ["cell"] }],
        },
      },
    };
    const inputs = {
      route: [targetCell.getAsWriteRedirectLink({ base: resultCell })],
    };
    const envelopes = collect(argumentSchema, inputs, resultCell, [["route"]]);
    expect(envelopes.length).toBe(1);
    expect(envelopes[0].id).toBe(targetCell.getAsNormalizedFullLink().id);
  });
});

describe("materializer envelope branch selection", () => {
  // The branch at the runner's envelope-derivation site: presence of
  // materializerWriteInputPaths switches envelope collection off the
  // opaque-result fallback (collect ALL writable args) onto the path-filtered
  // collector — for a send-only computed with an unwritten writable arg, that
  // flips "collect all" to "collect none". Intended precision: with analyzed
  // write metadata, writable args that were never written would appear in the
  // write paths if written. Pinned here at the only level where the branch
  // selection is observable (the scheduler's materializer index after a real
  // runner-driven run).

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const triConditionPattern = (withWriteMetadata: boolean) => ({
    argumentSchema: {
      type: "object",
      properties: {
        notifyArg: { type: "object" },
        targetArg: { type: "number" },
      },
    },
    resultSchema: {},
    result: { out: { $alias: { partialCause: "out", path: [] } } },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: () => 42,
          argumentSchema: {
            type: "object",
            properties: {
              notify: { asCell: ["stream"] },
              target: { type: "number", asCell: ["cell"] },
            },
          },
          resultSchema: { asCell: ["opaque"] },
          ...(withWriteMetadata
            ? { materializerWriteInputPaths: [["notify"]] }
            : {}),
        },
        inputs: {
          notify: { $alias: { cell: "argument", path: ["notifyArg"] } },
          target: { $alias: { cell: "argument", path: ["targetArg"] } },
        },
        outputs: { $alias: { partialCause: "out", path: [] } },
      },
    ],
  });

  // Runs the pattern to idle, and returns the write envelopes each action
  // ended up registered under, read from the scheduler's
  // `scheduler.materializer.register` markers: an action's latest marker
  // says whether it is a materializer, and under which writes.
  const runPattern = async (
    withWriteMetadata: boolean,
  ): Promise<Map<string, string[]>> => {
    const writesByAction = new Map<string, string[]>();
    const listener = (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type !== "scheduler.materializer.register") return;
      writesByAction.set(marker.actionId, marker.writes);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
    try {
      const resultCell = runtime.getCell(
        space,
        `branch-selection-${withWriteMetadata}`,
      );
      const result = runtime.run(
        undefined,
        trustExecutable(
          runtime,
          triConditionPattern(withWriteMetadata) as never,
        ),
        { notifyArg: {}, targetArg: 1 } as never,
        resultCell as never,
      );
      await result.pull();
      await runtime.idle();
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
    return writesByAction;
  };

  const materializers = (writesByAction: Map<string, string[]>) =>
    [...writesByAction.values()].filter((writes) => writes.length > 0);

  it("send-only write metadata suppresses the opaque-result fallback", async () => {
    const registered = materializers(await runPattern(true));
    // The stream path does not brand-match and the writable arg does not
    // path-match: no envelopes, so the action never registers as a
    // materializer.
    expect(registered).toHaveLength(0);
  });

  it("without write metadata the opaque-result fallback collects writable args", async () => {
    const registered = materializers(await runPattern(false));
    expect(registered).toHaveLength(1);
    // The registered envelope addresses the writable arg's backing entity,
    // which lives in the test's space.
    expect(registered[0].length).toBeGreaterThan(0);
    for (const write of registered[0]) {
      expect(write.startsWith(`${space}/`)).toBe(true);
    }
  });
});
