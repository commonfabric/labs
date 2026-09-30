import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import {
  evaluateConfLabelQuery,
  parseConfLabelTargetPath,
} from "../src/cfc/label-introspection.ts";
import { deriveLabelMetadataTemplateEntries } from "../src/cfc/label-metadata-population.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";

// Inv-12 Stage 2 (SC-25/SC-6; docs/specs/cfc-label-metadata-confidentiality.md
// §3/§5; spec §4.6.4.1-.2): the bounded first-layer label-introspection
// evaluator. Pure-function tests over stored metadata; the tx consumption
// channel and the pattern-facing builtin are covered in
// cfc-label-introspection-channel.test.ts and
// cfc-inspect-conf-label-builtin.test.ts.

const SOURCE_A = { space: "did:key:spacea", id: "of:origin-a", path: [] };
const SOURCE_B = { space: "did:key:spaceb", id: "of:origin-b", path: [] };

const caveatAtom = (source: CfcAtom) => ({
  type: CFC_ATOM_TYPE.Caveat,
  kind: "prompt-influence",
  source,
});

const metadataWith = (
  entries: CfcMetadata["labelMap"]["entries"],
): CfcMetadata => ({
  version: 1,
  schemaHash: "test-schema",
  labelMap: { version: 1, entries },
});

// A derived-component entry guarding /value/body with a source-bearing caveat
// clause: the §4.6.4.2 interim fallback territory (the entry's own effective
// confidentiality is a sound population label for its source fields).
const derivedBodyEntry = (atom: CfcAtom = caveatAtom(SOURCE_A)) => ({
  path: ["body"],
  label: { confidentiality: ["secret", atom] },
  origin: "derived" as const,
});

describe("CFC label introspection evaluator (inv-12 Stage 2)", () => {
  it("retains concrete shape confidentiality for a wildcard target", () => {
    const metadata = metadataWith([{
      path: ["items", "0"],
      origin: "derived",
      label: { confidentiality: ["private selection"] },
    }]);
    const evaluation = evaluateConfLabelQuery(metadata, ["items", "*"], {});
    expect(evaluation.result.status).toBe("ok");
    expect(evaluation.consumedConfidentiality).toEqual(["private selection"]);
  });

  it("keeps legacy link fields unavailable in an upgraded envelope", () => {
    for (const complete of [false, true]) {
      const entry = {
        path: ["body"],
        origin: "link" as const,
        ...(complete && {
          observes: "followRef" as const,
          referenceAcquisition: "complete" as const,
        }),
        label: { confidentiality: [caveatAtom(SOURCE_A)] },
      };
      const templates = deriveLabelMetadataTemplateEntries([entry], 3);
      expect(templates.length > 0).toBe(complete);
      const metadata = {
        ...metadataWith([entry, ...templates]),
        version: 3 as const,
      };
      const evaluation = evaluateConfLabelQuery(metadata, ["body"], {
        source: SOURCE_A,
      });
      expect(evaluation.result.status).toBe(complete ? "ok" : "notAvailable");
    }
  });

  it("protects an empty query below a privately selected structure", () => {
    const metadata = metadataWith([{
      path: [],
      origin: "structure",
      observes: "shape",
      label: { confidentiality: ["selection"] },
    }]);
    const evaluation = evaluateConfLabelQuery(metadata, ["missing"], {});
    expect(evaluation.result).toEqual({ status: "ok", atoms: [] });
    expect(evaluation.consumedConfidentiality).toEqual(["selection"]);
  });

  it("retains ancestor selection under a more specific metadata template", () => {
    const metadata = metadataWith([
      {
        path: [],
        origin: "structure",
        observes: "shape",
        label: { confidentiality: ["selection"] },
      },
      {
        path: ["cfc", "labels", "value", "missing"],
        origin: "label-metadata",
        observes: "labelMetadata",
        label: { confidentiality: ["field"] },
      },
    ]);
    const evaluation = evaluateConfLabelQuery(metadata, ["missing"], {});
    expect(evaluation.result).toEqual({ status: "ok", atoms: [] });
    expect(evaluation.consumedConfidentiality).toEqual(["field", "selection"]);
  });

  it("retains selection observations when a later field is unavailable", () => {
    const evaluation = evaluateConfLabelQuery(
      metadataWith([
        {
          path: [],
          origin: "structure",
          observes: "shape",
          label: { confidentiality: ["selection"] },
        },
        {
          path: ["body"],
          origin: "declared",
          label: { confidentiality: [caveatAtom(SOURCE_A)] },
        },
      ]),
      ["body"],
      { source: SOURCE_A },
    );
    expect(evaluation.result).toEqual({ status: "notAvailable" });
    expect(evaluation.consumedConfidentiality).toEqual(["selection"]);
  });

  describe("target path parsing (first-layer addressing)", () => {
    it("maps the payload pointer to the canonical /value entry path", () => {
      expect(parseConfLabelTargetPath("/body")).toEqual(["body"]);
      expect(parseConfLabelTargetPath("")).toEqual([]);
      expect(parseConfLabelTargetPath("/a/0/b")).toEqual(["a", "0", "b"]);
    });

    it("refuses envelope-metadata paths (no labels-of-labels)", () => {
      // `/cfc/...` is the envelope metadata subtree: a payload-path query
      // there would be introspecting labels OF labels (§4.6.4.1 first-layer
      // rule). The parse rejects so the evaluator's caller collapses to
      // notAvailable.
      expect(parseConfLabelTargetPath("/cfc/labels/value/body"))
        .toBeUndefined();
      expect(parseConfLabelTargetPath("/cfc")).toBeUndefined();
    });

    it("treats an explicit /value prefix as the payload root prefix", () => {
      // Payload paths are value-relative (§4.6.5): "/value/body" is the
      // ENVELOPE spelling of payload "/body" and normalizes to it.
      expect(parseConfLabelTargetPath("/value/body")).toEqual(["body"]);
      // So a root payload field named `value` is reached through the prefix.
      expect(parseConfLabelTargetPath("/value/value")).toEqual(["value"]);
    });

    it("refuses malformed pointers", () => {
      // Not a JSON pointer (no leading slash): fail closed like every other
      // unevaluable input.
      expect(parseConfLabelTargetPath("body")).toBeUndefined();
    });
  });

  describe("match evaluation", () => {
    it("finds atoms matching an atomType query (public consultation)", () => {
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: CFC_ATOM_TYPE.Caveat },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0]).toMatchObject({
        targetPath: "/body",
        clauseIndex: 1,
        alternativeIndex: 0,
        atomIndex: 0,
      });
      expect(result.atoms[0].atom).toEqual(caveatAtom(SOURCE_A));
      // The projection reveals the whole atom, including its source field —
      // source-protected even though type/kind are public (§4.6.4.2: the atom
      // value label is the join of the fields the projection reveals).
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("protects an empty type-query result with the derived selection label", () => {
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: CFC_ATOM_TYPE.Expires },
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
      // The type field adds no restriction, but selecting the label did.
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("matches a source query on a derived entry and consumes the fallback label", () => {
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      // §4.6.4.2 interim rule: the source field's observation label falls back
      // to the derived entry's own effective confidentiality.
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("establishing a source miss still consumes the per-field labels", () => {
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_B },
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
      // The miss was established by testing the protected source field:
      // the consumed set carries the same population label as a hit.
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("protects a miss established from a derived label field absence", () => {
      // Neither atom has a source field. Its absence is still part of the
      // metadata shape selected under the derived confidentiality.
      const metadata = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [
            "secret",
            { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" },
          ],
        },
        origin: "derived" as const,
      }]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("requires every present predicate to match (AND semantics)", () => {
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: CFC_ATOM_TYPE.Caveat, caveatKind: "other-kind" },
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
    });

    it("matches bare string atoms by atomType (a type-only atom)", () => {
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: ["secret"] },
        origin: "derived" as const,
      }]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: "secret" },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0].atom).toBe("secret");
      // Projecting a tag reveals that it was selected into this label.
      expect(consumedConfidentiality).toEqual(["secret"]);
    });

    it("addresses alternatives inside an anyOf clause", () => {
      const metadata = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [{
            anyOf: [
              { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" },
              { type: CFC_ATOM_TYPE.Space, id: "did:key:spacea" },
            ],
          }],
        },
        origin: "derived" as const,
      }]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: CFC_ATOM_TYPE.Space },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0]).toMatchObject({
        clauseIndex: 0,
        alternativeIndex: 1,
        atomIndex: 0,
      });
    });

    it("only inspects the label stored at the exact target path (first layer)", () => {
      const metadata = metadataWith([
        derivedBodyEntry(),
        {
          path: ["body", "nested"],
          label: { confidentiality: ["internal"] },
          origin: "derived" as const,
        },
      ]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        {},
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      // Only the /value/body entry's atoms — never ancestors, never
      // descendants; effective-label resolution is the display path's job.
      expect(result.atoms.map((a) => a.targetPath)).toEqual([
        "/body",
        "/body",
      ]);
    });
  });

  describe("outcome normalization (§4.6.4.1)", () => {
    it("returns notAvailable for missing metadata", () => {
      const { result } = evaluateConfLabelQuery(undefined, ["body"], {});
      expect(result).toEqual({ status: "notAvailable" });
    });

    it("fails closed on declared-entry source consultation", () => {
      // Declared (authored) entries carry no containment guarantee: their
      // source-bearing fields are unobservable under the interim population
      // rule, so a query needing them collapses to notAvailable.
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: [caveatAtom(SOURCE_A)] },
        origin: "declared" as const,
      }]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result).toEqual({ status: "notAvailable" });
      expect(consumedConfidentiality).toEqual([]);
    });

    it("fails closed on legacy (component-less) entries' source fields", () => {
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: [caveatAtom(SOURCE_A)] },
      }]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result).toEqual({ status: "notAvailable" });
    });

    it("collapses a matching-but-unreadable projection to notAvailable", () => {
      // atomType is public, so the query itself is evaluable — but the
      // matched atom's projection would reveal a declared entry's source
      // field, which is unobservable. The whole result collapses: omitting
      // the atom would misreport a match as a miss, and returning it would
      // disclose the field.
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: [caveatAtom(SOURCE_A)] },
        origin: "declared" as const,
      }]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: CFC_ATOM_TYPE.Caveat },
      );
      expect(result).toEqual({ status: "notAvailable" });
    });

    it("returns byte-identical notAvailable across all hidden arms", () => {
      const missing = evaluateConfLabelQuery(undefined, ["body"], {});
      const unreadableMatch = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: [caveatAtom(SOURCE_A)] },
          origin: "declared" as const,
        }]),
        ["body"],
        { atomType: CFC_ATOM_TYPE.Caveat },
      );
      const unevaluableQuery = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: [caveatAtom(SOURCE_A)] },
          origin: "declared" as const,
        }]),
        ["body"],
        { source: SOURCE_A },
      );
      expect(JSON.stringify(missing.result)).toBe(
        JSON.stringify(unreadableMatch.result),
      );
      expect(JSON.stringify(missing.result)).toBe(
        JSON.stringify(unevaluableQuery.result),
      );
      // No protected consumption reported on any hidden arm.
      expect(missing.consumedConfidentiality).toEqual([]);
      expect(unreadableMatch.consumedConfidentiality).toEqual([]);
      expect(unevaluableQuery.consumedConfidentiality).toEqual([]);
    });

    it("returns ok+[] for an envelope with no entry at the target path", () => {
      // The envelope exists; atom presence is public under the default
      // profile, so the caller may learn "no label here" without protected
      // consumption.
      const metadata = metadataWith([derivedBodyEntry()]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["other"],
        {},
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
      expect(consumedConfidentiality).toEqual([]);
    });
  });

  describe("commitment-form interplay (Stage 1)", () => {
    it("digest-matches a source query against a committed field", () => {
      const committed = caveatAtom(commitCfcFieldValue(SOURCE_A));
      const metadata = metadataWith([derivedBodyEntry(committed)]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      // Committed stays committed: the projection returns the STORED form
      // verbatim — never the plaintext the query happened to supply.
      expect(result.atoms[0].atom).toEqual(committed);
    });

    it("digest-misses a source query against a different committed field", () => {
      const committed = caveatAtom(commitCfcFieldValue(SOURCE_A));
      const metadata = metadataWith([derivedBodyEntry(committed)]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_B },
      );
      expect(result).toEqual({ status: "ok", atoms: [] });
      // A miss over a committed field is still a membership observation and
      // consumes the same per-field labels.
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("walks array-shaped alternatives element-wise", () => {
      // A crafted alternative that IS an array: the projection walk visits
      // every element. String elements are type-only tags (public) on a
      // derived entry...
      const derived = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: [{ anyOf: [["tag-a", "tag-b"]] }] },
          origin: "derived" as const,
        }]),
        ["body"],
        {},
      );
      expect(derived.result.status).toBe("ok");
      if (derived.result.status !== "ok") throw new Error("unreachable");
      expect(derived.result.atoms).toHaveLength(1);
      expect(derived.consumedConfidentiality).toEqual([
        { anyOf: [["tag-a", "tag-b"]] },
      ]);

      // ...while an array smuggling a source-bearing atom on a DECLARED
      // entry fails closed through the element walk.
      const declared = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: {
            confidentiality: [{ anyOf: [["tag-a", caveatAtom(SOURCE_A)]] }],
          },
          origin: "declared" as const,
        }]),
        ["body"],
        {},
      );
      expect(declared.result).toEqual({ status: "notAvailable" });
    });

    it("stops a public wrapper field from smuggling a protected nested atom", () => {
      // `authored-by.subject` is table-public, so the walk recurses into its
      // value — where a crafted nested Caveat atom resets the classification
      // context. Its `source` is protected: fail-closed on a declared entry,
      // the derived fallback on a derived one.
      const smuggling = {
        kind: "authored-by",
        subject: caveatAtom(SOURCE_A),
      };
      const declared = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: [smuggling] },
          origin: "declared" as const,
        }]),
        ["body"],
        { caveatKind: "authored-by" },
      );
      expect(declared.result).toEqual({ status: "notAvailable" });

      const derived = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: ["secret", smuggling] },
          origin: "derived" as const,
        }]),
        ["body"],
        { caveatKind: "authored-by" },
      );
      expect(derived.result.status).toBe("ok");
      if (derived.result.status !== "ok") throw new Error("unreachable");
      expect(derived.result.atoms).toHaveLength(1);
      expect(derived.consumedConfidentiality).toContainEqual("secret");
    });

    it("labels a whole-atom commitment marker by the protected chain", () => {
      // A clause alternative that IS a bare marker (crafted data; Stage 1
      // commits fields, not atoms): projecting it is a protected
      // observation — derived entries fall back, declared entries collapse.
      const marker = commitCfcFieldValue(SOURCE_A);
      const derived = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: ["secret", marker] },
          origin: "derived" as const,
        }]),
        ["body"],
        {},
      );
      expect(derived.result.status).toBe("ok");
      expect(derived.consumedConfidentiality).toContainEqual("secret");

      const declared = evaluateConfLabelQuery(
        metadataWith([{
          path: ["body"],
          label: { confidentiality: [marker] },
          origin: "declared" as const,
        }]),
        ["body"],
        {},
      );
      expect(declared.result).toEqual({ status: "notAvailable" });
    });

    it("fails closed on committed fields of declared entries too", () => {
      const committed = caveatAtom(commitCfcFieldValue(SOURCE_A));
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: [committed] },
        origin: "declared" as const,
      }]);
      const { result } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result).toEqual({ status: "notAvailable" });
    });
  });

  describe("population rule field classes", () => {
    it("keeps table-public fields public (authored attribution)", () => {
      // authored-by subjects are classified `public` (disclosure is the
      // feature): projecting the claim atom consumes nothing protected even
      // on a declared entry.
      const metadata = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [{ kind: "authored-by", subject: "did:key:alice" }],
        },
        origin: "declared" as const,
      }]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { atomType: undefined, caveatKind: "authored-by" },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      expect(result.atoms).toHaveLength(1);
      expect(consumedConfidentiality).toEqual([]);
    });

    it("treats structure entries as derived-component for the fallback", () => {
      // `structure` entries are flow-join-derived (§8.5.6.1 membership taint
      // rides the same §8.9.2 conservative join), so the containment argument
      // holds for them exactly as for `derived`.
      const metadata = metadataWith([{
        path: ["body"],
        label: { confidentiality: ["secret", caveatAtom(SOURCE_A)] },
        origin: "structure" as const,
      }]);
      const { result, consumedConfidentiality } = evaluateConfLabelQuery(
        metadata,
        ["body"],
        { source: SOURCE_A },
      );
      expect(result.status).toBe("ok");
      expect(consumedConfidentiality).toContainEqual("secret");
    });

    it("gates family-specific predicates on the atom family", () => {
      // policyName/resourceClass/originUri are family-qualified fields
      // (spec: "resource/policy/origin fields"): a Builtin atom that merely
      // HAS a `name` field must not satisfy a policyName query, and a
      // crafted `kind` on an unrelated typed family is not a caveat kind
      // (codex/cubic P2 on the Stage 2 PR). The family test rides the
      // public `type` observation, so gating consumes nothing protected.
      const metadata = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [
            { type: CFC_ATOM_TYPE.Builtin, name: "workspace" },
            {
              type: CFC_ATOM_TYPE.User,
              kind: "prompt-influence",
              subject: "did:key:u",
            },
            {
              type: CFC_ATOM_TYPE.User,
              class: "confidential",
              subject: "did:key:u",
            },
            {
              type: CFC_ATOM_TYPE.User,
              uri: "https://example.com",
              subject: "did:key:u",
            },
          ],
        },
        origin: "derived" as const,
      }]);
      expect(
        evaluateConfLabelQuery(metadata, ["body"], { policyName: "workspace" })
          .result,
      ).toEqual({ status: "ok", atoms: [] });
      expect(
        evaluateConfLabelQuery(metadata, ["body"], {
          caveatKind: "prompt-influence",
        }).result,
      ).toEqual({ status: "ok", atoms: [] });
      expect(
        evaluateConfLabelQuery(metadata, ["body"], {
          resourceClass: "confidential",
        }).result,
      ).toEqual({ status: "ok", atoms: [] });
      expect(
        evaluateConfLabelQuery(metadata, ["body"], {
          originUri: "https://example.com",
        }).result,
      ).toEqual({ status: "ok", atoms: [] });

      // The genuine families still match: Caveat kinds, kind-shaped claim
      // atoms (type-less — the kind discriminator IS their family), Origin
      // URIs.
      const genuine = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [
            caveatAtom(SOURCE_A),
            { kind: "authored-by", subject: "did:key:alice" },
            { type: CFC_ATOM_TYPE.Origin, uri: "https://mail.example.com" },
          ],
        },
        origin: "derived" as const,
      }]);
      const byKind = evaluateConfLabelQuery(genuine, ["body"], {
        caveatKind: "prompt-influence",
      });
      expect(byKind.result.status).toBe("ok");
      if (byKind.result.status !== "ok") throw new Error("unreachable");
      expect(byKind.result.atoms).toHaveLength(1);
      const byClaim = evaluateConfLabelQuery(genuine, ["body"], {
        caveatKind: "authored-by",
      });
      expect(byClaim.result.status).toBe("ok");
      if (byClaim.result.status !== "ok") throw new Error("unreachable");
      expect(byClaim.result.atoms).toHaveLength(1);
      const byOrigin = evaluateConfLabelQuery(genuine, ["body"], {
        originUri: "https://mail.example.com",
      });
      expect(byOrigin.result.status).toBe("ok");
      if (byOrigin.result.status !== "ok") throw new Error("unreachable");
      expect(byOrigin.result.atoms).toHaveLength(1);
    });

    it("supports resourceClass/policyName/originUri equality", () => {
      const metadata = metadataWith([{
        path: ["body"],
        label: {
          confidentiality: [
            {
              type: CFC_ATOM_TYPE.Resource,
              class: "confidential",
              subject: "did:key:owner",
            },
            { type: CFC_ATOM_TYPE.Policy, name: "workspace", hash: "h1" },
          ],
        },
        origin: "derived" as const,
      }]);
      // Policy.name is table-public: consultation consumes nothing.
      const byPolicy = evaluateConfLabelQuery(metadata, ["body"], {
        policyName: "workspace",
      });
      expect(byPolicy.result.status).toBe("ok");
      if (byPolicy.result.status !== "ok") throw new Error("unreachable");
      expect(byPolicy.result.atoms).toHaveLength(1);

      // Resource.class is not table-public: consultation rides the
      // protected chain (derived fallback here — the entry has no
      // confidentiality beyond the atoms themselves, so the fallback join is
      // the entry's own clause set).
      const byClass = evaluateConfLabelQuery(metadata, ["body"], {
        resourceClass: "confidential",
      });
      expect(byClass.result.status).toBe("ok");
      if (byClass.result.status !== "ok") throw new Error("unreachable");
      expect(byClass.result.atoms).toHaveLength(1);

      // The absent origin field still reveals the derived metadata shape.
      const byOrigin = evaluateConfLabelQuery(metadata, ["body"], {
        originUri: "https://example.com",
      });
      expect(byOrigin.result).toEqual({ status: "ok", atoms: [] });
      expect(byOrigin.consumedConfidentiality).toEqual(
        metadata.labelMap.entries[0].label.confidentiality,
      );
    });
  });
});
