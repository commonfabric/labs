import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { labelResultSchema } from "../src/builtins/sqlite-builtins.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-declared-observes");
const space = signer.did();

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

describe("CFC declared observation classes (C5)", () => {
  // Epic C stage C5 (docs/specs/cfc-observation-classes.md §8): an authored
  // `ifc.observes` classes the declared entry, and the sqlite null-origin merge
  // uses it to declare its conservative whole-schema union as
  // `observes:"value"` — content-channel only. Shape/enumerate consumers of a
  // query's result rows (length, membership — the count consumer) no longer
  // inherit the union; class-unaware readers still treat the entry as covering
  // (the exact pre-C5 behavior — over-taint, fail-safe).

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const makeRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // A strict writer-fit refuses a tainted write to a store that declares
      // no ceiling. Every output document below declares none, and the
      // assertions on their `derived` and `structure` entries read the labels
      // those writes persisted, so the suite holds the strongest rung that
      // still lets them land.
      cfcEnforcementMode: "enforce-explicit",
      // Persisting flow labels is what puts the declared and derived entries
      // in the documents. Every assertion that goes through `entriesOf` reads
      // one of them.
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  const entriesOf = (id: string): StoredEntry[] => {
    const replica = storageManager!.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  const uri = (id: string) => id as `${string}:${string}`;

  it('labelResultSchema declares null-origin columns as observes:"value"', () => {
    // The sqlite seam, unit level: a null-origin projection declares the
    // whole-schema confidentiality union as a VALUE-class label; a resolved
    // column passes its authored ifc through verbatim.

    const tables = {
      emails: {
        properties: {
          body: { ifc: { confidentiality: ["mail-secret"] } },
          subject: { ifc: { confidentiality: ["subject-secret"] } },
        },
      },
    };
    const { schema, error } = labelResultSchema(
      [
        { output: "n", table: null, column: null },
        { output: "body", table: "emails", column: "body" },
      ],
      tables,
    );
    expect(error).toBeUndefined();
    const props = (schema as {
      properties: {
        result: {
          items: {
            properties: Record<string, { ifc: Record<string, unknown> }>;
          };
        };
      };
    }).properties.result.items.properties;
    expect(props.n.ifc.observes).toBe("value");
    expect([...(props.n.ifc.confidentiality as string[])].sort()).toEqual([
      "mail-secret",
      "subject-secret",
    ]);
    // Resolved origin: authored ifc verbatim (covering unless the author
    // classed it).
    expect(props.body.ifc.observes).toBeUndefined();
    expect(props.body.ifc.confidentiality).toEqual(["mail-secret"]);
  });

  it("authored ifc.observes mints a classed declared entry consumed per class", async () => {
    // The minting walk honors an authored ifc.observes: the declared entry
    // carries the class, and the C1 reader consumes it per class — a
    // nonRecursive (count/length-shaped) read of the doc does not inherit a
    // value-class declared label, while a value read does.

    const rt = makeRuntime();
    const guarded = internSchema(
      {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: { type: "string" },
            ifc: { confidentiality: ["content-secret"], observes: "value" },
          },
        },
      } as JSONSchema,
      true,
    );
    const tx = rt.edit();
    const cell = rt.getCell(space, "dobs-doc", guarded.schema, tx);
    cell.set({ rows: ["a", "b"] });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const id = cell.getAsNormalizedFullLink().id;
    const declared = entriesOf(id).find((e) =>
      e.origin === "declared" && e.path.join("/") === "rows"
    );
    expect(declared).toBeDefined();
    expect(declared!.observes).toBe("value");
    expect(declared!.label.confidentiality).toContainEqual("content-secret");

    // A count-shaped (nonRecursive) read of the labeled path consumes
    // shape+enumerate+covering — NOT the value-class declared label.
    const countTx = rt.edit();
    countTx.readOrThrow({
      space,
      scope: "space",
      id: uri(id),
      type: "application/json",
      path: ["value", "rows"],
    }, { nonRecursive: true });
    const countOut = rt.getCell(space, "dobs-count-out", undefined, countTx);
    const countOutId = countOut.getAsNormalizedFullLink().id;
    countTx.writeOrThrow(
      { space, scope: "space", id: uri(countOutId), path: ["value"] },
      { count: 2 },
    );
    countTx.prepareCfc();
    expect((await countTx.commit()).ok).toBeDefined();
    expect(
      entriesOf(countOutId).filter((e) => e.origin === "derived"),
    ).toEqual([]);

    // A value read still consumes it.
    const valueTx = rt.edit();
    valueTx.readOrThrow({
      space,
      scope: "space",
      id: uri(id),
      type: "application/json",
      path: ["value", "rows"],
    });
    const valueOut = rt.getCell(space, "dobs-value-out", undefined, valueTx);
    const valueOutId = valueOut.getAsNormalizedFullLink().id;
    valueTx.writeOrThrow(
      { space, scope: "space", id: uri(valueOutId), path: ["value"] },
      { copied: true },
    );
    valueTx.prepareCfc();
    expect((await valueTx.commit()).ok).toBeDefined();
    expect(
      entriesOf(valueOutId).find((e) => e.origin === "derived")?.label
        .confidentiality,
    ).toContainEqual("content-secret");
  });

  it("declared shape labels coexist with the frozen existence stamp", async () => {
    // A declared observes:"shape" label must neither suppress the runtime's
    // frozen existence stamp (different component: declared = policy,
    // derived = measurement — review on the freeze follow-up) nor be
    // captured by the freeze carry out of its declared-policy discipline.

    const rt = makeRuntime();
    const secretId = await (async () => {
      const seed = rt.edit();
      const cell = rt.getCell(space, "dobs-shape-secret", undefined, seed);
      const id = cell.getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
        value: { n: 1 },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["secret"] } }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();
      return id;
    })();

    const guarded = internSchema(
      {
        type: "object",
        ifc: { confidentiality: ["declared-members"], observes: "shape" },
      } as JSONSchema,
      true,
    );
    const tx = rt.edit();
    tx.readOrThrow({
      space,
      scope: "space",
      id: uri(secretId),
      type: "application/json",
      path: ["value"],
    });
    const out = rt.getCell(space, "dobs-shape-out", guarded.schema, tx);
    out.set({ created: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const outId = out.getAsNormalizedFullLink().id;
    const entries = entriesOf(outId);
    const declaredShape = entries.find((e) =>
      e.origin === "declared" && e.observes === "shape"
    );
    expect(declaredShape).toBeDefined();
    expect(declaredShape!.label.confidentiality).toContainEqual(
      "declared-members",
    );
    // The runtime existence stamp is NOT suppressed by the declared entry:
    // creation under secret influence must be recorded (SC-4).
    const frozen = entries.find((e) =>
      (e.origin === "derived" || e.origin === "structure") &&
      e.observes === "shape"
    );
    expect(frozen).toBeDefined();
    expect(frozen!.label.confidentiality).toContainEqual("secret");
  });

  it("an invalid ifc.observes value mints a covering entry", async () => {
    // A bogus observes value must not narrow anything: the entry mints
    // covering (over-taint, fail-safe) and every read class consumes it.

    const rt = makeRuntime();
    const guarded = internSchema(
      {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: { type: "string" },
            ifc: { confidentiality: ["content-secret"], observes: "vlaue" },
          },
        },
        // Deliberately invalid class value — the narrowed ifc type rejects
        // it, which is the point of the runtime fallback under test.
      } as unknown as JSONSchema,
      true,
    );
    const tx = rt.edit();
    const cell = rt.getCell(space, "dobs-invalid-doc", guarded.schema, tx);
    cell.set({ rows: ["a"] });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();

    const id = cell.getAsNormalizedFullLink().id;
    const declared = entriesOf(id).find((e) =>
      e.origin === "declared" && e.path.join("/") === "rows"
    );
    expect(declared).toBeDefined();
    expect(declared!.observes).toBeUndefined();

    const countTx = rt.edit();
    countTx.readOrThrow({
      space,
      scope: "space",
      id: uri(id),
      type: "application/json",
      path: ["value", "rows"],
    }, { nonRecursive: true });
    const out = rt.getCell(space, "dobs-invalid-out", undefined, countTx);
    const outId = out.getAsNormalizedFullLink().id;
    countTx.writeOrThrow(
      { space, scope: "space", id: uri(outId), path: ["value"] },
      { count: 1 },
    );
    countTx.prepareCfc();
    expect((await countTx.commit()).ok).toBeDefined();
    expect(
      entriesOf(outId).find((e) => e.origin === "derived")?.label
        .confidentiality,
    ).toContainEqual("content-secret");
  });
});
