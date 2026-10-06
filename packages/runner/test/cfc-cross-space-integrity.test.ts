import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { type CfcConfClause, clausesEqual } from "../src/cfc/clause.ts";
import { evaluateExchangeRules } from "../src/cfc/exchange-eval.ts";
import { commitmentAwareEquals } from "../src/cfc/label-representation.ts";
import type { IFCLabel } from "../src/cfc/mod.ts";
import {
  buildCfcPolicySnapshot,
  type ExchangeRule,
} from "../src/cfc/policy.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// Cross-space integrity & declassification — expressing the four scenarios and
// pinning where the gaps are.
//
//   1. A value created in space A gets integrity; referenced from space B, the
//      integrity is retained (the reference/no-copy path — the mechanism that
//      actually crosses spaces today).
//   2. Declassify while releasing the value: confidentiality is widened/dropped
//      at a boundary; integrity is UNTOUCHED (exchange rules never modify it).
//   3. Only a subset is declassified: per-path labels + clause-locality scope a
//      declassification to one field/clause, leaving siblings confined.
//
// Key facts pinned by explicit tests:
//   - The LINK (a reference) is what carries a label across a space boundary.
//     `exactCopyOf` compares two paths within ONE value tree, but a path may
//     HOLD a cross-space link — so an exact copy OF A LINK verifies the copy
//     AND carries the source label across (1d). Copying the resolved BYTES does
//     not carry anything (1e): the reference is load-bearing.
//   - Linking a whole object does NOT project it to a narrower schema — the
//     full source labelMap crosses, undeclared sibling fields included (3d).
//     Per-field links copy exactly the chosen subset (3e).
//   - `passThrough` (the spec's §8.2 reference annotation) is unimplemented
//     and FAILS CLOSED (3a). `projection` (§8.3) IS implemented — verified at
//     commit with scoped-integrity carry (3a′ shows the subset-declaration
//     sliver; full behavior in cfc-projection.test.ts).

const signer = await Identity.fromPassphrase("cfc-cross-space-integrity");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("cfc-cross-space-integrity B"))
  .did();

type LabelMapEntry = {
  path: string[];
  label: IFCLabel;
  origin?: string;
};
type PersistedDoc = {
  value?: unknown;
  cfc?: { labelMap?: { entries: LabelMapEntry[] } };
} | undefined;

const readDoc = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  space: MemorySpace,
  id: string,
): PersistedDoc =>
  (storageManager.open(space).replica as unknown as {
    getDocument(id: string): PersistedDoc;
  }).getDocument(id);

const entriesFor = (doc: PersistedDoc, path: string[]): LabelMapEntry[] =>
  (doc?.cfc?.labelMap?.entries ?? []).filter((e) =>
    e.path.length === path.length && e.path.every((p, i) => p === path[i])
  );

const makeRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });

// Seed a doc's stored CFC metadata directly (an ungated path-[] full-document
// write — how the runtime itself persists it) in an ARBITRARY space, so a later
// cross-space link to it carries the label. `entries` are the per-path labels.
const seedLabeledDoc = async (
  runtime: Runtime,
  space: MemorySpace,
  id: string,
  value: FabricValue,
  entries: LabelMapEntry[],
): Promise<string> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(space, id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, {
    space,
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
  return docId;
};

// An address a `LinkReference` endorsement carries: the plaintext address, or
// the digest marker standing in for it.
type EndorsementAddress =
  | { space: string; id: string; path: string[] }
  | { digestOf: string };

const isLinkReference = (atom: unknown): atom is {
  type: string;
  source: EndorsementAddress;
  target: EndorsementAddress;
} =>
  isObjectOrArray(atom) &&
  (atom as { type?: unknown }).type ===
    "https://commonfabric.org/cfc/atom/LinkReference";

describe("CFC cross-space integrity", () => {
  it("scenario 1a — a value created in a space gets integrity (declared)", async () => {
    // Primitive: a value gets integrity. Declared `ifc.integrity` with a
    // non-reserved atom persists as an `origin: "declared"` entry, exactly like
    // declared confidentiality. (Reserved runtime-minted atoms — LlmDerived,
    // PolicyCertified, … — are gated to builtin identities and would be
    // stripped here; a plain string or custom-URL atom is the author-mintable
    // form.)

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        spaceA,
        "s1a-origin",
        {
          type: "object",
          properties: {
            reading: { type: "string", ifc: { integrity: ["gps-reading"] } },
          },
          required: ["reading"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.set({ reading: "37.77,-122.41" });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceA,
        parseLink(cell.getAsLink()).id!,
      );
      expect(entriesFor(doc, ["reading"])).toContainEqual({
        path: ["reading"],
        label: { integrity: ["gps-reading"] },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 1b — same-space exactCopyOf carries integrity onto the copy", async () => {
    // Same-space verbatim copy: `exactCopyOf` is content-address verified and
    // carries the SOURCE integrity onto the copy (§8.4). This is the "verbatim
    // copy retains integrity" primitive — but note the space constraint below.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        spaceA,
        "s1b-exactcopy",
        {
          type: "object",
          properties: {
            reading: {
              type: "string",
              ifc: { integrity: ["gps-reading"], confidentiality: ["secret"] },
            },
            confirmed: { type: "string", ifc: { exactCopyOf: ["reading"] } },
          },
          required: ["reading", "confirmed"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.set({ reading: "37.77,-122.41", confirmed: "37.77,-122.41" });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceA,
        parseLink(cell.getAsLink()).id!,
      );
      // The copy inherits BOTH axes of the source, unfiltered (§8.4.2).
      expect(entriesFor(doc, ["confirmed"])).toContainEqual({
        path: ["confirmed"],
        label: { confidentiality: ["secret"], integrity: ["gps-reading"] },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 1c — a cross-space link retains the source integrity (+ endorsement)", async () => {
    // Scenario 1 proper (reference / no-copy): space B holds a LINK to the
    // labeled value in space A. Traversing the link yields the source integrity
    // PRESERVED plus a runtime-minted `LinkReference` endorsement that records
    // BOTH spaces (§3.7.2: integrity = target ∪ link-endorsement), and the
    // source confidentiality carried across the boundary (§3.7.1). This is the
    // mechanism that genuinely crosses spaces today.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const srcId = await seedLabeledDoc(
        runtime,
        spaceA,
        "s1c-src",
        "37.77,-122.41",
        [{
          path: [],
          label: {
            integrity: ["gps-reading"],
            confidentiality: ["space-a-secret"],
          },
        }],
      );

      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s1c-src", undefined, tx);
      const sink = runtime.getCell(
        spaceB,
        "s1c-sink",
        {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ ref: src as unknown as string });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const sinkId = parseLink(sink.getAsLink()).id!;
      const doc = readDoc(storageManager, spaceB, sinkId);
      const entries = entriesFor(doc, ["ref"]);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.origin).toBe("link");
      // Source integrity preserved…
      expect(entry.label.integrity).toContain("gps-reading");
      // …plus the endorsement recording the edge from space A to space B.
      // The endorsement addresses are commitment-classified fields, so
      // `commitmentAwareEquals` reads the plaintext address and the digest
      // marker standing in for it alike.
      const linkRef = (entry.label.integrity ?? []).find(isLinkReference);
      expect(linkRef).toBeDefined();
      expect(
        commitmentAwareEquals(linkRef!.source, {
          space: spaceA,
          id: srcId,
          path: [],
        }),
      ).toBe(true);
      expect(
        commitmentAwareEquals(linkRef!.target, {
          space: spaceB,
          id: sinkId,
          path: ["ref"],
        }),
      ).toBe(true);
      // Source confidentiality carried across the space boundary.
      expect(entry.label.confidentiality).toContain("space-a-secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 1d — exactCopyOf of a cross-space link carries integrity and verifies the copy", async () => {
    // Verbatim copy across spaces, DONE RIGHT: carry the REFERENCE.
    // `exactCopyOf` compares two paths within one value tree — but a path may
    // HOLD a link into another space, and the label it copies is that path's
    // (link-carried) label. So a field whose source is a cross-space link is
    // (a) verified as an exact copy AND (b) carries the source's integrity
    // across the boundary. This is the "verbatim copy retains integrity across
    // spaces" scenario — the reference is the carrier, and exactCopyOf is the
    // verified claim on top of it.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      await seedLabeledDoc(runtime, spaceA, "s1d-src", "37.77,-122.41", [{
        path: [],
        label: {
          integrity: ["gps-reading"],
          confidentiality: ["space-a-secret"],
        },
      }]);

      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s1d-src", undefined, tx);
      const sink = runtime.getCell(
        spaceB,
        "s1d-sink",
        {
          type: "object",
          properties: {
            reading: { type: "string" },
            confirmed: { type: "string", ifc: { exactCopyOf: ["reading"] } },
          },
          required: ["reading", "confirmed"],
        } as const satisfies JSONSchema,
        tx,
      );
      // Both fields hold the SAME cross-space link; exactCopyOf verifies it.
      sink.set({
        reading: src as unknown as string,
        confirmed: src as unknown as string,
      });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceB,
        parseLink(sink.getAsLink()).id!,
      );
      const confirmedInt = entriesFor(doc, ["confirmed"])
        .flatMap((e) => e.label.integrity ?? []);
      // The verified copy carries the source integrity across the boundary,
      // including the cross-space endorsement.
      expect(confirmedInt).toContain("gps-reading");
      expect(confirmedInt.find(isLinkReference)).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 1d — a tampered exactCopyOf (copy ≠ source) is rejected", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        spaceA,
        "s1d-reject",
        {
          type: "object",
          properties: {
            reading: { type: "string", ifc: { integrity: ["gps-reading"] } },
            confirmed: { type: "string", ifc: { exactCopyOf: ["reading"] } },
          },
          required: ["reading", "confirmed"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.set({ reading: "37.77,-122.41", confirmed: "tampered" });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "exactCopyOf failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 1e — a resolved-byte copy across spaces is unendorsed (carry the reference, not the bytes)", async () => {
    // The boundary of scenario 1d: copying the RESOLVED VALUE (plain bytes)
    // rather than the reference does NOT carry the label. Once a handler
    // materializes bytes, the runtime has no basis to attest they are the same
    // labeled thing, so the copy is a fresh, unendorsed value. This is not a
    // bug — it is why the REFERENCE (link) is load-bearing for cross-space
    // integrity: carry the link (scenario 1c/1d), not the extracted bytes.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const srcId = await seedLabeledDoc(
        runtime,
        spaceA,
        "s1e-src",
        "37.77,-122.41",
        [{ path: [], label: { integrity: ["gps-reading"] } }],
      );

      // Actually READ the labeled source and write its MATERIALIZED value (not a
      // link) into space B — the "a handler read it and copied the bytes" path.
      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s1e-src", undefined, tx);
      const materialized = src.get() as string;
      expect(materialized).toBe("37.77,-122.41");
      const copy = runtime.getCell(
        spaceB,
        "s1e-copy",
        {
          type: "object",
          properties: { reading: { type: "string" } },
          required: ["reading"],
        } as const satisfies JSONSchema,
        tx,
      );
      copy.set({ reading: materialized });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceB,
        parseLink(copy.getAsLink()).id!,
      );
      // The copied bytes equal the source, but the source's declared integrity
      // did not ride along — materializing severed the provenance. (Under the
      // default cfcFlowLabels:"off"; a flow-persisting deployment would stamp a
      // separate `derived` taint component, never the source's declared label.)
      expect((doc?.value as { reading?: string })?.reading).toBe(
        "37.77,-122.41",
      );
      // The source carries the atom the copy must not, and the value read
      // above pins the copy document the entries below are read from.
      expect(
        entriesFor(readDoc(storageManager, spaceA, srcId), [])
          .flatMap((e) => e.label.integrity ?? []),
      ).toContain("gps-reading");
      const integrity = entriesFor(doc, ["reading"])
        .flatMap((e) => e.label.integrity ?? []);
      expect(integrity).not.toContain("gps-reading");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 3a [GAP] — the passThrough ifc annotation fails closed (unimplemented)", async () => {
    // GAP (remaining): the spec's reference annotation (§8.2 `passThrough`) is
    // unimplemented; a write through a schema declaring it FAILS CLOSED rather
    // than being silently ignored. Reference behaviors stay reachable via
    // per-path labels and links (scenarios 1c / 3).

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(spaceA, "s3a-passThrough", {
        type: "object",
        properties: {
          field: {
            type: "string",
            ifc: { passThrough: { from: "/other", path: "/lat" } },
          },
        },
        required: ["field"],
      } as unknown as JSONSchema, tx);
      cell.set({ field: "x" });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(String((result.error as Error | undefined)?.message)).toContain(
        "unsupported trust-sensitive claim passThrough",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 3a′ — the projection ifc annotation verifies and carries a scoped label", async () => {
    // Scenario 3a′ — the §8.3 `projection` annotation IS implemented: the
    // ergonomic "declare this field is a scoped projection" syntax verifies at
    // commit (the target must equal the claimed source field) and carries the
    // source's confidentiality in full plus its integrity SCOPED to the
    // projected pointer, so the projected field can never claim whole-object
    // integrity. Mismatch/wildcard/malformed fail-closed behavior and the
    // provenance-class drops live in cfc-projection.test.ts.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        spaceA,
        "s3a-projection",
        {
          type: "object",
          properties: {
            measurement: {
              type: "object",
              properties: { lat: { type: "number" } },
              ifc: {
                confidentiality: ["location"],
                integrity: [{ type: "gps-reading" }],
              },
            },
            latitude: {
              type: "number",
              ifc: { projection: { from: "/measurement", path: "/lat" } },
            },
          },
          required: ["measurement", "latitude"],
        } as const satisfies JSONSchema,
        tx,
      );
      cell.set({ measurement: { lat: 37.77 }, latitude: 37.77 });
      tx.prepareCfc();
      const result = await tx.commit().settled;
      expect(result.ok).toBeDefined();

      const docId = parseLink(cell.getAsLink()).id!;
      const [entry] = entriesFor(
        readDoc(storageManager, spaceA, docId),
        ["latitude"],
      );
      expect(entry?.label.confidentiality).toEqual(["location"]);
      expect(entry?.label.integrity).toEqual([
        { type: "gps-reading", scope: { projection: "/lat" } },
      ]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 3b — a cross-space link to a sub-path carries only that subset's label", async () => {
    // Scenario 3 (reference variant): referencing only a SUBSET. A link to a
    // sub-path of the source carries only that sub-path's label — the sibling
    // field's label stays behind. This is the "solve the subset with
    // references, at least partially" case.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      // Source has DIFFERENT labels on two fields.
      await seedLabeledDoc(
        runtime,
        spaceA,
        "s3b-src",
        { lat: "37.77", secret: "classified" },
        [
          { path: ["lat"], label: { integrity: ["gps-reading"] } },
          { path: ["secret"], label: { confidentiality: ["top-secret"] } },
        ],
      );

      // Space B links ONLY the `lat` sub-path.
      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s3b-src", undefined, tx);
      const sink = runtime.getCell(
        spaceB,
        "s3b-sink",
        {
          type: "object",
          properties: { lat: { type: "string" } },
          required: ["lat"],
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ lat: src.key("lat") as unknown as string });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceB,
        parseLink(sink.getAsLink()).id!,
      );
      const entries = entriesFor(doc, ["lat"]);
      expect(entries).toHaveLength(1);
      // The subset's own integrity crossed…
      expect(entries[0].label.integrity).toContain("gps-reading");
      // …and the sibling `secret`'s confidentiality did NOT leak in.
      const allConf = (doc?.cfc?.labelMap?.entries ?? [])
        .flatMap((e) => e.label.confidentiality ?? []);
      expect(allConf).not.toContain("top-secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 3d — a whole-object cross-space link carries undeclared sibling labels (no projection)", async () => {
    // Subset — the SUBTLE part. Source data carries MORE fields than the
    // destination schema declares:
    //   { foo: { bar, secret }, baz, secret }   vs   { foo: { bar }, baz }
    //
    // GOTCHA: linking the WHOLE object does NOT project it to the schema. The
    // link carries the source's FULL labelMap — the undeclared `foo.secret` and
    // top-level `secret` labels come across too. A narrower destination schema
    // is a read-time VIEW, not a projection: it does not sanitize the
    // reference. The secret fields stay confined by their OWN confidentiality
    // labels (so this is safe, not a leak), but "only the right fields crossed"
    // is FALSE here.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      await seedLabeledDoc(
        runtime,
        spaceA,
        "s3d-src",
        { foo: { bar: "a", secret: "b" }, baz: "hi", secret: "another" },
        [
          { path: ["foo", "bar"], label: { integrity: ["bar-ok"] } },
          {
            path: ["foo", "secret"],
            label: { confidentiality: ["foo-secret"] },
          },
          { path: ["baz"], label: { integrity: ["baz-ok"] } },
          { path: ["secret"], label: { confidentiality: ["top-secret"] } },
        ],
      );

      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s3d-src", undefined, tx);
      // Destination schema declares ONLY foo.bar and baz.
      const sink = runtime.getCell(
        spaceB,
        "s3d-sink",
        {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                foo: {
                  type: "object",
                  properties: { bar: { type: "string" } },
                },
                baz: { type: "string" },
              },
            },
          },
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ data: src as unknown as string });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceB,
        parseLink(sink.getAsLink()).id!,
      );
      const allConf = (doc?.cfc?.labelMap?.entries ?? [])
        .flatMap((e) => e.label.confidentiality ?? []);
      // The undeclared secret fields' labels DID cross (the schema did not
      // project them out).
      expect(allConf).toContain("foo-secret");
      expect(allConf).toContain("top-secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("scenario 3e — per-field cross-space links copy exactly the chosen subset", async () => {
    // Subset — DONE RIGHT: link the specific sub-paths. Only the selected
    // fields' labels cross; the undeclared `secret` fields are never
    // referenced, so their labels (and values) stay entirely behind. This is
    // how you copy a genuine subset by reference, integrity-preserving and
    // leak-free.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime(storageManager);
    try {
      await seedLabeledDoc(
        runtime,
        spaceA,
        "s3e-src",
        { foo: { bar: "a", secret: "b" }, baz: "hi", secret: "another" },
        [
          { path: ["foo", "bar"], label: { integrity: ["bar-ok"] } },
          {
            path: ["foo", "secret"],
            label: { confidentiality: ["foo-secret"] },
          },
          { path: ["baz"], label: { integrity: ["baz-ok"] } },
          { path: ["secret"], label: { confidentiality: ["top-secret"] } },
        ],
      );

      const tx = runtime.edit();
      const src = runtime.getCell(spaceA, "s3e-src", undefined, tx);
      const sink = runtime.getCell(
        spaceB,
        "s3e-sink",
        {
          type: "object",
          properties: { bar: { type: "string" }, baz: { type: "string" } },
          required: ["bar", "baz"],
        } as const satisfies JSONSchema,
        tx,
      );
      // Link ONLY the chosen leaves.
      sink.set({
        bar: src.key("foo").key("bar") as unknown as string,
        baz: src.key("baz") as unknown as string,
      });
      tx.prepareCfc();
      expect((await tx.commit().settled).error).toBeUndefined();

      const doc = readDoc(
        storageManager,
        spaceB,
        parseLink(sink.getAsLink()).id!,
      );
      const allConf = (doc?.cfc?.labelMap?.entries ?? [])
        .flatMap((e) => e.label.confidentiality ?? []);
      const allInt = (doc?.cfc?.labelMap?.entries ?? [])
        .flatMap((e) => e.label.integrity ?? []);
      // Chosen fields' integrity crossed…
      expect(allInt).toContain("bar-ok");
      expect(allInt).toContain("baz-ok");
      // …and NEITHER secret's confidentiality did.
      expect(allConf).not.toContain("foo-secret");
      expect(allConf).not.toContain("top-secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

// Scenario 2 — declassify while releasing/copying the value. Declassification
// is a boundary-time rewrite expressed by EXCHANGE RULES: a rule adds an
// alternative to (or drops) a CONFIDENTIALITY clause, gated by evidence. The
// rewrite is never persisted, and — critically for "copy retains integrity" —
// the rules operate on confidentiality ONLY and never touch integrity. So a
// declassified copy keeps every integrity claim it had.
//
// These use the exchange evaluator directly, which is the label transform the
// sink/egress boundary applies under `cfcPolicyEvaluation: "enforce"`.

const BOB = "did:key:bob";
const userBob = cfcAtom.user(BOB);
const spaceASecret = cfcAtom.space(spaceA);
const bobReadsA = cfcAtom.hasRole(BOB, spaceA, "reader");
const gpsReading = "gps-reading";

const snapshotOf = (rules: readonly ExchangeRule[], id = "test-policy") =>
  buildCfcPolicySnapshot([{ id, rules }])!;

const clauseSetsEqual = (
  a: readonly unknown[],
  b: readonly unknown[],
): boolean =>
  a.length === b.length &&
  a.every((clause) =>
    b.some((other) =>
      clausesEqual(clause as CfcConfClause, other as CfcConfClause)
    )
  ) &&
  b.every((clause) =>
    a.some((other) =>
      clausesEqual(clause as CfcConfClause, other as CfcConfClause)
    )
  );

// A value confined to space A may be released to a reader of space A: the rule
// adds User($p) as an alternative to the Space($s) clause when the label proves
// HasRole($p, $s, reader). (The §4.3.3 space-reader rule.)
const spaceReaderRule: ExchangeRule = {
  id: "space-reader-release",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
};

// A full declassification: drop the space clause entirely when a publish
// approval is present in the value's integrity.
const PUBLISH_APPROVED = { type: "https://example.com/atoms/PublishApproved" };
const publishRule: ExchangeRule = {
  id: "publish-drop",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: { integrity: [PUBLISH_APPROVED] },
  post: { dropClause: true },
};

describe("CFC declassification while copying (exchange rules)", () => {
  it("scenario 2a — releasing to a reader widens confidentiality, integrity untouched", () => {
    // Declassify by WIDENING the audience, integrity retained.

    const result = evaluateExchangeRules(
      { confidentiality: [spaceASecret], integrity: [bobReadsA, gpsReading] },
      snapshotOf([spaceReaderRule]),
    );
    expect(result.exhausted).toBe(false);
    // Confidentiality clause now admits User(bob) as an alternative — Bob may
    // observe the released copy.
    expect(clauseSetsEqual(result.label.confidentiality!, [
      { anyOf: [spaceASecret, userBob] },
    ])).toBe(true);
    // Integrity is byte-identical to the input — declassification never alters
    // it, so the copy keeps its "gps-reading" provenance (and the HasRole fact).
    expect(result.label.integrity).toContain(gpsReading);
    expect(result.label.integrity).toContainEqual(bobReadsA);
  });

  it("scenario 2b — a publish approval drops the clause; integrity survives", () => {
    // Declassify FULLY (drop the clause → public), integrity retained.

    const result = evaluateExchangeRules(
      {
        confidentiality: [spaceASecret],
        integrity: [PUBLISH_APPROVED, gpsReading],
      },
      snapshotOf([publishRule]),
    );
    expect(result.exhausted).toBe(false);
    // The space clause is gone — the value is now public.
    expect(result.label.confidentiality ?? []).toHaveLength(0);
    // The integrity claims are still present.
    expect(result.label.integrity).toContain(gpsReading);
    expect(result.label.integrity).toContainEqual(PUBLISH_APPROVED);
  });

  it("scenario 2c — without the evidence, nothing is declassified", () => {
    // No evidence → no declassification (fail-closed). The confidentiality
    // clause stands; nothing is released.

    const result = evaluateExchangeRules(
      { confidentiality: [spaceASecret], integrity: [gpsReading] },
      snapshotOf([spaceReaderRule, publishRule]),
    );
    expect(result.firings).toEqual([]);
    expect(result.label.confidentiality).toEqual([spaceASecret]);
    expect(result.label.integrity).toContain(gpsReading);
  });

  it("scenario 3c — a referenced policy declassifies only its home clause", () => {
    // Scenario 3 (declassify only the SUBSET): clause-locality. A `referenced`
    // policy fires only on the clause that carries its hash-bound ref atom —
    // its "home clause" — leaving sibling clauses confined even when the same
    // evidence would satisfy the guard there. Combined with per-path labels
    // (scenario 3b), this scopes a declassification to exactly one part of the
    // value; integrity is still untouched.

    const spaceB2 = cfcAtom.space(spaceB);
    const bobReadsB = cfcAtom.hasRole(BOB, spaceB, "reader");
    const shareSnapshot = buildCfcPolicySnapshot([{
      id: "share-flow",
      selection: "referenced" as const,
      rules: [spaceReaderRule],
    }])!;
    const shareRef = cfcAtom.policyRef(
      "share-flow",
      BOB,
      shareSnapshot.records[0].digest,
    );

    const result = evaluateExchangeRules(
      {
        // Clause 0 carries the share ref (declassifiable); clause 1 (space B) is
        // an independent, unreferenced requirement.
        confidentiality: [{ anyOf: [spaceASecret, shareRef] }, spaceB2],
        integrity: [bobReadsA, bobReadsB, gpsReading],
      },
      shareSnapshot,
    );

    // Only clause 0 widened; the space-B sibling stayed confined despite
    // bobReadsB satisfying the guard shape.
    expect(clauseSetsEqual(result.label.confidentiality!, [
      { anyOf: [spaceASecret, shareRef, userBob] },
      spaceB2,
    ])).toBe(true);
    expect(result.label.integrity).toContain(gpsReading);
  });
});
