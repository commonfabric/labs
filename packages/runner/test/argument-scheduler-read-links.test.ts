/**
 * Pins the schema/value alignment of the argument scheduler-read collector
 * (`collectArgumentSchedulerReadLinks`): write-redirect links bound in tuple
 * (prefixItems) slot positions are visited like `items`-covered elements, so
 * links bound in the tuple positions of a prefixItems-only schema stay under
 * scheduler read tracking.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("argument scheduler read links");
const space = signer.did();

describe("argument scheduler read links", () => {
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
    value: unknown,
    resultCell: Cell<any>,
  ): NormalizedFullLink[] =>
    runtime.runner.accessForTestingOnly.collectArgumentSchedulerReadLinks(
      argumentSchema as JSONSchema | undefined,
      value,
      resultCell,
    );

  it("visits tuple (prefixItems) slot elements", () => {
    const resultCell = runtime.getCell(space, "sched-read-result");
    const sourceCell = runtime.getCell<number>(space, "sched-read-source");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "number" }],
        },
      },
    };
    const value = {
      route: [sourceCell.getAsWriteRedirectLink({ base: resultCell })],
    };

    const links = collect(argumentSchema, value, resultCell);
    expect(links.length).toBe(1);
    expect(links[0].id).toBe(sourceCell.getAsNormalizedFullLink().id);
  });

  it("visits items-covered elements past the tuple slots", () => {
    // Parity pin: `items` covers the rest region beside `prefixItems`.
    const resultCell = runtime.getCell(space, "sched-read-rest-result");
    const sourceCell = runtime.getCell<number>(space, "sched-read-rest-src");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
        },
      },
    };
    const value = {
      route: ["label", sourceCell.getAsWriteRedirectLink({ base: resultCell })],
    };

    const links = collect(argumentSchema, value, resultCell);
    expect(links.length).toBe(1);
    expect(links[0].id).toBe(sourceCell.getAsNormalizedFullLink().id);
  });
});
