import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import {
  type CfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "../src/cfc/label-view-core.ts";
import { cfcLabelViewFromMetadata } from "../src/cfc/label-view-state.ts";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { serializeForLLMObservation } = llmDialogTestHelpers;

describe("CFC observation precision (C4)", () => {
  // Epic C stage C4 — consumer precision (C0 §7): the observation ceiling and
  // label views consume entries per observation class. A public value read of a
  // child under a secret container `shape` no longer inherits the container's
  // shape label (the flat model took the max), and an opaque link handle is a
  // followRef observation consuming the pointer's label only.

  const view = (entries: CfcLabelView["entries"]): CfcLabelView => ({
    version: 1,
    entries,
  });

  it("view built from metadata carries effective classes (link ⇒ followRef)", () => {
    const built = cfcLabelViewFromMetadata(
      {
        version: 1,
        schemaHash: "h",
        labelMap: {
          version: 1,
          entries: [
            {
              path: ["slot"],
              label: { confidentiality: ["ptr"] },
              origin: "link",
            },
            {
              path: ["items"],
              label: { confidentiality: ["members"] },
              origin: "structure",
              observes: "shape",
            },
            { path: [], label: { confidentiality: ["covering"] } },
          ],
        },
      },
      [],
    );
    expect(built).toBeDefined();
    const byPath = Object.fromEntries(
      built!.entries.map((e) => [e.path.join("/"), e.observes ?? "covering"]),
    );
    expect(byPath).toEqual({
      slot: "followRef",
      items: "shape",
      "": "covering",
    });
  });

  it("container shape labels apply at the container node, not at addressed children", () => {
    // The C4 precision win: the container's membership label surfaces at the
    // container node (enumerating it reveals membership) but an ADDRESSED
    // child does not inherit it — the caller named the path.

    const labelView = view([
      {
        path: ["items"],
        label: { confidentiality: ["members-secret"] },
        observes: "shape",
      },
      {
        path: ["items", "0"],
        label: { confidentiality: ["child-value"] },
        observes: "value",
      },
    ]);
    expect(
      cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: ["items", "0"],
      }),
    ).toEqual(["child-value"]);
    expect(
      cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: ["items"],
      }),
    ).toEqual(["members-secret"]);
  });

  it("value observations skip followRef entries and keep covering parity", () => {
    // Value observations never consume pointer labels; covering entries stay
    // byte-identical to the pre-C4 join (parity for legacy views).

    const labelView = view([
      { path: [], label: { confidentiality: ["covering-root"] } },
      {
        path: ["slot"],
        label: { confidentiality: ["pointer-label"] },
        observes: "followRef",
      },
    ]);
    expect(
      cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: ["slot"],
      }),
    ).toEqual(["covering-root"]);
  });

  it("followRef observations consume the pointer label and nothing else", () => {
    const labelView = view([
      { path: [], label: { confidentiality: ["covering-root"] } },
      {
        path: ["slot"],
        label: { confidentiality: ["pointer-label"] },
        observes: "followRef",
      },
    ]);
    expect(
      cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: ["slot"],
        observes: "followRef",
      }),
    ).toEqual(["pointer-label"]);
  });

  it("merge keeps distinct classes at one path separate", () => {
    const merged = mergeCfcLabelViews([
      view([{
        path: ["a"],
        label: { confidentiality: ["v"] },
        observes: "value",
      }]),
      view([{
        path: ["a"],
        label: { confidentiality: ["s"] },
        observes: "shape",
      }]),
    ]);
    expect(merged!.entries.length).toBe(2);
    expect(merged!.entries.map((e) => e.observes).sort()).toEqual([
      "shape",
      "value",
    ]);
  });

  it("rebase drops ancestor shape/enumerate/followRef, keeps content", () => {
    // Slicing a view below a container: content labels inherit down;
    // node-anchored channels (shape/enumerate/followRef) do not.

    const sliced = rebaseCfcLabelView(
      view([
        { path: [], label: { confidentiality: ["covering-root"] } },
        {
          path: [],
          label: { confidentiality: ["root-content"] },
          observes: "value",
        },
        {
          path: [],
          label: { confidentiality: ["members-secret"] },
          observes: "shape",
        },
        {
          path: [],
          label: { confidentiality: ["order-secret"] },
          observes: "enumerate",
        },
        {
          path: [],
          label: { confidentiality: ["pointer-label"] },
          observes: "followRef",
        },
        {
          path: ["items", "0", "deep"],
          label: { confidentiality: ["deep-secret"] },
          observes: "shape",
        },
      ]),
      ["items", "0"],
    );
    const atoms = sliced!.entries.flatMap((e) => e.label.confidentiality ?? []);
    expect(atoms.sort()).toEqual([
      "covering-root",
      "deep-secret",
      "root-content",
    ]);
    // The descendant keeps its class through the slice.
    expect(
      sliced!.entries.find((e) => e.path.join("/") === "deep")?.observes,
    ).toBe("shape");
  });

  it("opaque handles report the pointer label as their observation", () => {
    // LLM serialization end-to-end: the ceiling forces an opaque handle; the
    // handle is a followRef observation reporting the POINTER's label — not
    // the empty observation it used to be (an SC-8 under-report at the LLM
    // boundary), and not the target content label that forced the redaction.

    const labelView = view([
      {
        path: [],
        label: { confidentiality: ["secret-content"] },
        observes: "value",
      },
      {
        path: [],
        label: { confidentiality: ["pointer-label"] },
        observes: "followRef",
      },
    ]);
    const rootLink = {
      id: "of:c4-secret-doc",
      space: "did:key:test",
      scope: "space" as const,
      path: [],
      type: "application/json" as const,
    };
    const result = serializeForLLMObservation({
      value: { secret: "s3cr3t" },
      contextSpace: "did:key:test" as never,
      rootLink: rootLink as never,
      labelView,
      observationMaxConfidentiality: ["pointer-label"],
    });
    expect((result.value as { "@link"?: string })["@link"]).toBeDefined();
    expect(result.observedConfidentiality).toEqual(["pointer-label"]);
  });

  it("redacts entirely when the pointer label also exceeds the ceiling", () => {
    // When even the pointer label exceeds the ceiling, the handle would leak
    // which-document — and falling through would serialize the over-ceiling
    // CONTENT into paths with no downstream gate (post-commit context/pinned
    // docs). Redact entirely: no content, no handle, no observation.

    const labelView = view([
      {
        path: [],
        label: { confidentiality: ["secret-content"] },
        observes: "value",
      },
      {
        path: [],
        label: { confidentiality: ["secret-pointer"] },
        observes: "followRef",
      },
    ]);
    const rootLink = {
      id: "of:c4-secret-doc-2",
      space: "did:key:test",
      scope: "space" as const,
      path: [],
      type: "application/json" as const,
    };
    const result = serializeForLLMObservation({
      value: "leaf",
      contextSpace: "did:key:test" as never,
      rootLink: rootLink as never,
      labelView,
      observationMaxConfidentiality: [],
    });
    expect((result.value as { "@link"?: string })?.["@link"]).toBeUndefined();
    expect(result.value).toBe("[redacted: exceeds observation ceiling]");
    expect(result.observedConfidentiality).toEqual([]);
  });

  it("serializing an addressed child sheds the container shape label", () => {
    // The child-shedding applies through the serializer walk: a public child
    // of a shape-labeled container serializes with only its own labels.

    const labelView = view([
      {
        path: ["items"],
        label: { confidentiality: ["members-secret"] },
        observes: "shape",
      },
    ]);
    const result = serializeForLLMObservation({
      value: "public leaf",
      contextSpace: "did:key:test" as never,
      logicalPath: ["items", "0"],
      labelView,
      observationMaxConfidentiality: [],
    });
    expect(result.value).toBe("public leaf");
    expect(result.observedConfidentiality).toEqual([]);
  });
});
