/**
 * What `convertCellsToLinks()` puts on a link for the cell's CFC label view.
 * Under `includeCfcLabelView` a minted link carries the view's display form,
 * with each caveat's source redacted, and without the option it carries none.
 * A link the conversion is handed rather than mints is rebuilt as the
 * container it is, so a view riding one is neither attached nor redacted here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { convertCellsToLinks } from "../src/cell.ts";
import type { CfcLabelView } from "../src/cfc/label-view.ts";
import {
  linkCfcLabelView,
  withLinkCfcLabelView,
} from "../src/cfc/link-label-view.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { SigilLink } from "../src/sigil-types.ts";

describe("convert-cells-to-links-label-views", () => {
  /** The options the IPC response and notification paths convert under. */
  const DISPLAY_OPTIONS = {
    includeSchema: true,
    keepAsCell: KeepAsCell.All,
    doNotConvertCellResults: true,
    includeCfcLabelView: true,
  } as const;

  /** A view whose one caveat names a source, which is what the redaction drops. */
  const SOURCED_VIEW = {
    version: 1,
    entries: [{
      path: [],
      label: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: "did:key:alice",
        }],
      },
    }],
  } as CfcLabelView;

  /** The one caveat of a view, as a bag of properties. */
  function caveatOf(view: CfcLabelView | undefined): Record<string, unknown> {
    expect(view).toBeDefined();
    return view!.entries[0].label.confidentiality![0] as Record<
      string,
      unknown
    >;
  }

  /** Runs `body` against a runtime that is disposed afterwards. */
  async function withRuntime(
    body: (runtime: Runtime, space: MemorySpace) => void,
  ): Promise<void> {
    const signer = await Identity.fromPassphrase(
      "convert cells to links label views",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        body(runtime, signer.did());
      } finally {
        await runtime.dispose();
      }
    } finally {
      await storageManager.close();
    }
  }

  it("attaches the display form of a cell's carried view under `includeCfcLabelView`", async () => {
    await withRuntime((runtime, space) => {
      const link = withLinkCfcLabelView(
        runtime.getCell(space, "label-view-carrier").getAsLink(),
        SOURCED_VIEW,
      );
      const cell = runtime.getCellFromLink(link);

      const converted = convertCellsToLinks(
        { source: cell },
        DISPLAY_OPTIONS,
      ) as { source: SigilLink };
      const caveat = caveatOf(linkCfcLabelView(converted.source));

      expect(caveat.type).toBe(CFC_ATOM_TYPE.Caveat);
      expect(caveat.kind).toBe("derived-from");
      expect("source" in caveat).toBe(false);
    });
  });

  it("attaches no view without `includeCfcLabelView`", async () => {
    await withRuntime((runtime, space) => {
      const link = withLinkCfcLabelView(
        runtime.getCell(space, "label-view-carrier").getAsLink(),
        SOURCED_VIEW,
      );
      const cell = runtime.getCellFromLink(link);

      const converted = convertCellsToLinks(
        { source: cell },
        { ...DISPLAY_OPTIONS, includeCfcLabelView: false },
      ) as { source: SigilLink };

      expect(linkCfcLabelView(converted.source)).toBeUndefined();
    });
  });

  it("leaves a view riding a link it was handed as it is", () => {
    const link = withLinkCfcLabelView(
      linkRefFrom({
        id: "of:label-view-handed",
        space: "did:key:test",
        path: [],
      }) as SigilLink,
      SOURCED_VIEW,
    );

    const converted = convertCellsToLinks(
      { source: link },
      DISPLAY_OPTIONS,
    ) as { source: SigilLink };

    expect(caveatOf(linkCfcLabelView(converted.source)).source).toBe(
      "did:key:alice",
    );
  });
});
