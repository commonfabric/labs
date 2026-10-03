/**
 * An integrity floor (§8.12.4.1) at or below a link the runtime staged, as a
 * list builtin stages a callback's capture, is met only by the value the link
 * brings there: staging writes none of that value and mints none of the
 * slot's integrity. The value is credited where it lives (§8.2.6). A source
 * holding nothing at the floored path brings nothing there, and a walk to the
 * value that cannot finish through a stored link credits nothing.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import type { IFCLabel } from "../../src/cfc/mod.ts";
import { recordCapturedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc-staged-link-floor");
const space = signer.did();

const ADMIN = "admin-approved";

/** A string whose value has to carry the `ADMIN` endorsement. */
const floored: JSONSchema = {
  type: "string",
  ifc: { requiredIntegrity: [ADMIN] },
};

/**
 * The argument a list builtin stages captures into: a captured record at
 * `params/record`, whose `secret` is floored, and a captured field at
 * `params/secret`, floored itself.
 */
const argumentSchema: JSONSchema = {
  type: "object",
  properties: {
    params: {
      type: "object",
      properties: {
        record: { type: "object", properties: { secret: floored } },
        secret: floored,
      },
    },
  },
};

/** A document read by key, whatever it holds. */
interface Tree {
  [key: string]: Tree;
}

describe("staged-link-floor", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      cfcWriteFloor: "enforce",
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  /** The cell at `path` of the document `id`. */
  function cellAt(
    tx: IExtendedStorageTransaction,
    id: string,
    path: readonly string[],
  ): Cell<Tree> {
    let cell = runtime.getCell<Tree>(space, id, undefined, tx);
    for (const key of path) cell = cell.key(key);
    return cell;
  }

  /**
   * Stores `value` in the document `id`, with `label` at `path`, as a document
   * an earlier transaction wrote under its own schema.
   */
  async function seed(
    id: string,
    value: FabricValue,
    label: IFCLabel = {},
    path: string[] = [],
  ): Promise<void> {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      id: cellAt(tx, id, []).getAsNormalizedFullLink().id,
      type: "application/json",
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path, label }] },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
  }

  /** A link to `path` of the document `id`, as a stored value holds one. */
  function linkTo(id: string, path: readonly string[]): FabricValue {
    const tx = runtime.edit();
    const link = cellAt(tx, id, path).getAsLink();
    tx.abort();
    return link;
  }

  /**
   * Stages a capture of `path` of the document `id` at `params/<at>` of a new
   * argument, as a list builtin stages one, and returns the commit's error.
   */
  async function stage(
    at: "record" | "secret",
    id: string,
    path: readonly string[],
  ): Promise<string | undefined> {
    const tx = runtime.edit();
    const argument = runtime.getCell(
      space,
      `argument-${at}-${id}-${path.join("/")}`,
      argumentSchema,
      tx,
    );
    argument.set({
      params: { [at]: cellAt(tx, id, path).getAsWriteRedirectLink() },
    });
    recordCapturedArgumentFields(tx, argument.getAsNormalizedFullLink(), [
      "params",
    ]);
    runtime.prepareTxForCommit(tx);
    return (await tx.commit()).error?.message;
  }

  const refusedAt = (at: string) =>
    `write floor failed at /params/${at} (requiredIntegrity, §8.12.4.1)`;

  it("credits a captured field with the label of the document holding its value, and of none its stored links pass through", async () => {
    // m/secret → p/secret. `m` labels the slot holding its link, and `p`,
    // which holds the value, endorses nothing. `e` holds an endorsed value.
    await seed("p", { secret: "unendorsed" });
    await seed("m", { secret: linkTo("p", ["secret"]) }, {
      integrity: [ADMIN],
    }, ["secret"]);
    await seed("e", { secret: "ok" }, { integrity: [ADMIN] }, ["secret"]);
    await seed("to-e", { secret: linkTo("e", ["secret"]) });

    expect(await stage("secret", "m", ["secret"])).toContain(
      refusedAt("secret"),
    );
    expect(await stage("record", "m", [])).toContain(
      refusedAt("record/secret"),
    );
    expect(await stage("secret", "p", ["secret"])).toContain(
      refusedAt("secret"),
    );
    expect(await stage("secret", "to-e", ["secret"])).toBeUndefined();
  });

  it("commits a captured field whose source holds nothing there", async () => {
    await seed("empty", {});
    await seed("via", { secret: linkTo("empty", ["secret"]) });

    expect(await stage("secret", "empty", ["secret"])).toBeUndefined();
    expect(await stage("secret", "via", ["secret"])).toBeUndefined();
  });

  it("refuses a capture whose stored link leads into a document this replica does not hold", async () => {
    // Nothing has been written to `absent`, so what it holds is unknown.
    await seed("to-absent", { secret: linkTo("absent", ["secret"]) });

    expect(await stage("secret", "to-absent", ["secret"])).toContain(
      refusedAt("secret"),
    );
    expect(await stage("record", "to-absent", [])).toContain(
      refusedAt("record/secret"),
    );
  });

  for (const crossDocument of [false, true]) {
    const where = crossDocument ? "across documents" : "in their own document";

    it(`refuses, and finishes, a capture whose stored links grow its path ${where}`, async () => {
      // `loop-a` labels the slot holding its link, which holds no value.
      const slotLabel = { integrity: [ADMIN] };
      if (crossDocument) {
        await seed("loop-a", { x: linkTo("loop-b", ["y"]) }, slotLabel, ["x"]);
        await seed("loop-b", { y: linkTo("loop-a", ["x", "z"]) });
      } else {
        await seed("loop-a", { x: linkTo("loop-a", ["x", "z"]) }, slotLabel, [
          "x",
        ]);
      }

      expect(await stage("record", "loop-a", ["x"])).toContain(
        refusedAt("record/secret"),
      );
      expect(await stage("secret", "loop-a", ["x", "secret"])).toContain(
        refusedAt("secret"),
      );
    });
  }
});
