import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { writtenPrincipalOf } from "../../src/builder/principal-of.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const alice = await Identity.fromPassphrase("written-principal-of alice");
const bob = await Identity.fromPassphrase("written-principal-of bob");
const space: MemorySpace = alice.did();

/** An entry at the root claiming the value represents each of `subjects`. */
const representing = (...subjects: string[]) => ({
  path: [],
  label: {
    integrity: subjects.map((subject) => ({
      kind: "represents-principal",
      subject,
    })),
  },
  origin: "declared",
});

describe("writtenPrincipalOf()", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let openTxs: IExtendedStorageTransaction[];

  beforeEach(() => {
    openTxs = [];
    storage = StorageManager.emulate({ as: alice });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    for (const tx of openTxs) tx.abort(new Error("test-only"));
    await runtime.idle();
    await runtime.dispose();
    await storage.close();
  });

  /** Calls `writtenPrincipalOf(target)` in a `kind` frame over a fresh transaction. */
  const callIn = (target: unknown, kind: "handler" | "lift" = "lift") => {
    const tx = runtime.edit();
    openTxs.push(tx);
    const frame = pushFrame({
      runtime,
      tx,
      space,
      frameKind: kind,
      ...(kind === "handler" ? { inHandler: true } : {}),
    });
    try {
      return writtenPrincipalOf(target);
    } finally {
      popFrame(frame);
    }
  };

  /** The id of the document `cause` names. */
  const idOf = (cause: string): URI =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  /**
   * Stores `value` at the document `cause` names with a root label claiming
   * it represents each of `subjects`, or with no label for none.
   */
  const seed = async (
    cause: string,
    value: FabricValue,
    ...subjects: string[]
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: [] },
      {
        value,
        ...(subjects.length === 0 ? {} : {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries: [representing(...subjects)] },
          },
        }),
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    return runtime.getCell(space, cause);
  };

  /**
   * Replaces the label of the document `cause` names with a root label
   * claiming it represents `subject`, leaving its value as it is.
   */
  const relabel = async (cause: string, subject: string) => {
    const tx = runtime.edit();
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: ["cfc"] },
      {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [representing(subject)] },
      } as never,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * A profile labeled as Bob's whose `picture` field is a write redirect to a
   * cell of its own holding the bytes 1, 2, 3, labeled as written by each of
   * `by`, and the profile's `picture` field.
   */
  const picture = async (...by: string[]) => {
    const cell = await seed(
      "picture",
      new FabricBytes(new Uint8Array([1, 2, 3])),
      ...by,
    );
    const profile = await seed(
      "profile",
      { name: "Bob", picture: cell.getAsWriteRedirectLink() },
      bob.did(),
    );
    return profile.key("picture");
  };

  it("returns the principal the label of the field's own cell names, in a computation and in a handler", async () => {
    const field = await picture(bob.did());

    expect(callIn(field)).toBe(bob.did());
    expect(callIn(field, "handler")).toBe(bob.did());
  });

  it("returns the principal who wrote the value, whoever the profile represents", async () => {
    expect(callIn(await picture(alice.did()))).toBe(alice.did());
  });

  it("returns `undefined` for a value stored without a label, or one said to represent two principals", async () => {
    expect(callIn(await picture())).toBeUndefined();
    expect(callIn(await picture(bob.did(), alice.did()))).toBeUndefined();
  });

  it("returns `undefined` for a value held in the document of the field that names it", async () => {
    const profile = await seed(
      "profile",
      { name: "Bob", picture: new FabricBytes(new Uint8Array([4, 5])) },
      bob.did(),
    );

    expect(callIn(profile.key("picture"))).toBeUndefined();
  });

  it("returns `undefined` for a field that links into a field of another document", async () => {
    const other = await seed(
      "other",
      { picture: new FabricBytes(new Uint8Array([6])) },
      bob.did(),
    );
    const profile = await seed(
      "profile",
      { name: "Bob", picture: other.key("picture").getAsWriteRedirectLink() },
      bob.did(),
    );

    expect(callIn(profile.key("picture"))).toBeUndefined();
  });

  it("returns `undefined` for a field whose cell holds a link to a value its owner wrote", async () => {
    const elsewhere = await seed(
      "elsewhere",
      new FabricBytes(new Uint8Array([7])),
      bob.did(),
    );
    const cell = await seed("picture", elsewhere.getAsLink());
    const profile = await seed(
      "profile",
      { name: "Bob", picture: cell.getAsWriteRedirectLink() },
      bob.did(),
    );

    expect(callIn(profile.key("picture"))).toBeUndefined();
  });

  it("returns `undefined` for a field whose links run in a cycle", async () => {
    const profile = await seed(
      "profile",
      {
        name: "Bob",
        picture: runtime.getCell(space, "profile").key("picture")
          .getAsWriteRedirectLink(),
      },
      bob.did(),
    );

    expect(callIn(profile.key("picture"))).toBeUndefined();
  });

  it("runs a `lift()` that called it again when the value's label changes", async () => {
    const field = await picture(alice.did());
    let runs = 0;
    const argumentSchema = {
      type: "object",
      properties: { target: { type: "unknown", asCell: ["cell"] } },
    } as const satisfies JSONSchema;
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const writer = lift(
      (input: { target?: unknown }) => {
        runs++;
        return writtenPrincipalOf(input.target) ?? "none";
      },
      argumentSchema,
      { type: "string" },
    );
    const probe = pattern(
      ({ target }) => ({ writer: writer({ target }) }),
      argumentSchema,
      { type: "object", properties: { writer: { type: "string" } } },
    );
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      probe,
      { target: field },
      runtime.getCell(space, "written-principal-of-lift", undefined, tx),
    ) as Cell<{ writer?: string }>;
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.sink(() => {});
    try {
      await waitForCellValue(
        runtime,
        result.key("writer"),
        (value) => value === alice.did(),
        { stuckLabel: "the lift to name alice as the writer" },
      );
      expect(runs).toBe(1);

      await relabel("picture", bob.did());
      await waitForCellValue(
        runtime,
        result.key("writer"),
        (value) => value === bob.did(),
        { stuckLabel: "the lift to follow the label to bob" },
      );
      expect(runs).toBe(2);
    } finally {
      cancel();
    }
  });

  it("returns `undefined` for a target of `undefined`", () => {
    expect(callIn(undefined)).toBeUndefined();
  });

  it("throws when called outside a handler or a reactive computation", async () => {
    const field = await picture(bob.did());

    expect(() => writtenPrincipalOf(field)).toThrow(
      "can only be called from a handler or a reactive computation",
    );
  });
});
