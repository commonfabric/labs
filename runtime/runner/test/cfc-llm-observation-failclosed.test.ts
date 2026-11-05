import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CellImpl } from "../src/cell.ts";
import {
  cfcLabelViewForCell,
  cfcLabelViewForCellFailClosed,
  cfcLabelViewForCellWithStatus,
} from "../src/cfc/label-view.ts";
import {
  atomsOutsideCeiling,
  CFC_LABEL_READ_FAILED_ATOM,
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
} from "../src/cfc/observation.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { interceptTransaction } from "./support/intercept-transaction.ts";

// Audit item 22 — the LLM observation path must fail CLOSED on a metadata READ
// ERROR. `cfcConfidentialityForObservationNode` treats an absent label as
// unconfidential (public), and `cfcObservationFitsCeiling` lets public data
// through any ceiling. So if acquiring a cell's label *errors* and is swallowed
// to `undefined`, confidential data would serialize to the LLM as if public.
// `cfcLabelViewForCellFailClosed` taints the observation with a sentinel atom
// (absent from every real ceiling) so the node is redacted instead.
//
// The renderer's shared `cfcLabelViewForCell` seam is intentionally left
// unchanged (it already treats a missing label as blocked) — only the LLM
// egress path adopts the fail-closed variant.

const signer = await Identity.fromPassphrase("llm observation fail closed");

const REAL_CEILING = ["some-real-confidentiality-atom"];

describe("LLM observation fail-closed on metadata read error (audit 22)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  // A cell bound to a transaction whose every read errors.
  let cellWhoseMetadataReadErrors: unknown;
  // A cell naming a document with no `["cfc"]` metadata: a clean read
  // returning undefined, not an error.
  let cellWithAbsentMetadata: unknown;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const failing = interceptTransaction(
      runtime.edit(),
      (method, _args, proceed) => {
        if (method === "readOrThrow" || method === "readValueOrThrow") {
          throw new Error("storage read error");
        }
        return proceed();
      },
    );
    cellWhoseMetadataReadErrors = new CellImpl(
      runtime,
      failing,
      runtime.getCell(signer.did(), "labeled-cell").getAsNormalizedFullLink(),
    );
    cellWithAbsentMetadata = runtime.getCell(signer.did(), "unlabelled-cell");
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("reports readFailed when a metadata read errors (vs. cleanly absent)", () => {
    expect(
      cfcLabelViewForCellWithStatus(cellWhoseMetadataReadErrors).readFailed,
    )
      .toBe(true);
    expect(cfcLabelViewForCellWithStatus(cellWithAbsentMetadata).readFailed)
      .toBe(false);
  });

  it("demonstrates the fail-OPEN: the plain seam swallows the error to undefined", () => {
    // This is the renderer-safe behavior (undefined = blocked there), but for
    // the LLM observer undefined means "unconfidential" → fits any ceiling.
    const view = cfcLabelViewForCell(cellWhoseMetadataReadErrors);
    expect(view).toBeUndefined();
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    // Fail-open: a read error looks like public data and is admitted.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(true);
  });

  it("fails CLOSED: the fail-closed seam taints the node so it is redacted", () => {
    const view = cfcLabelViewForCellFailClosed(cellWhoseMetadataReadErrors);
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    expect(observed).toContain(CFC_LABEL_READ_FAILED_ATOM);
    // The marker is absent from any real ceiling → node does not fit → redact.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(false);
  });

  it("treats the read-failed marker as UNGRANTABLE (can't be allow-listed)", () => {
    // A caller could otherwise name the marker atom in their own ceiling to
    // re-open the fail-open. The marker must never fit a ceiling, even one that
    // lists it (or lists everything).
    const observed = [CFC_LABEL_READ_FAILED_ATOM];
    expect(cfcObservationFitsCeiling(observed, [CFC_LABEL_READ_FAILED_ATOM]))
      .toBe(false);
    expect(
      cfcObservationFitsCeiling(observed, [
        CFC_LABEL_READ_FAILED_ATOM,
        ...REAL_CEILING,
      ]),
    ).toBe(false);
  });

  it("atomsOutsideCeiling owns the same ungrantable-marker rule", () => {
    // The shared membership helper backs the prepare-time sink-request egress
    // gate, where it is the ONLY enforcement — if it honored a ceiling that
    // names the marker, the gate would disagree with cfcObservationFitsCeiling
    // and a deployment config could allow-list the read-failure taint.
    expect(
      atomsOutsideCeiling(
        [CFC_LABEL_READ_FAILED_ATOM],
        [CFC_LABEL_READ_FAILED_ATOM, ...REAL_CEILING],
      ),
    ).toEqual([CFC_LABEL_READ_FAILED_ATOM]);
    // Real atoms inside the ceiling stay inside; only the marker is forced out.
    expect(
      atomsOutsideCeiling(
        [CFC_LABEL_READ_FAILED_ATOM, ...REAL_CEILING],
        [CFC_LABEL_READ_FAILED_ATOM, ...REAL_CEILING],
      ),
    ).toEqual([CFC_LABEL_READ_FAILED_ATOM]);
    // An undefined ceiling is "no bound declared" — nothing is outside it,
    // marker included, matching cfcObservationFitsCeiling's early return. The
    // sink gate never consults the helper for an undeclared ceiling.
    expect(atomsOutsideCeiling([CFC_LABEL_READ_FAILED_ATOM], undefined))
      .toEqual([]);
  });

  it("does NOT over-redact cleanly-unlabelled data (no error → no sentinel)", () => {
    const view = cfcLabelViewForCellFailClosed(cellWithAbsentMetadata);
    expect(view).toBeUndefined();
    const observed = cfcConfidentialityForObservationNode({
      labelView: view,
      logicalPath: ["0"],
    });
    expect(observed).toEqual([]);
    // Absent metadata stays public (unchanged behavior) — fits any ceiling.
    expect(cfcObservationFitsCeiling(observed, REAL_CEILING)).toBe(true);
  });
});
