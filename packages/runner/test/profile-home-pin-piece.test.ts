import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { clauseAlternatives } from "../src/cfc/clause.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

// CT-1755: a profile card can pin an EXISTING deployed piece. `mutateElements`'s
// `addPiece` mode stores a real cross-space link to the target piece as the
// element's `cell` (the canonical `link@1` sigil), so the card renders as a
// followable `<cf-cell-link>` to the live piece rather than a local title-only
// placeholder. This guards that the stored element resolves to the pinned
// piece's space + id.
const signer = await Identity.fromPassphrase("profile-home-pin-piece");
const space = signer.did();

const TARGET_SPACE = "did:key:z6MkkKEmheMPDZUr4YEkZrW6niR7Bn5FWAuQic5fUUzcGkfq";
const TARGET_PIECE = "fid1:cMVC_ZTgWedhTzHW8jWbz70xANFfmLmpL-dNU1842Ps";

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const PROGRAM: RuntimeProgram = {
  main: "/profile-home.tsx",
  files: [
    {
      name: "/profile-home.tsx",
      contents: Deno.readTextFileSync(sysDir + "profile-home.tsx"),
    },
  ],
};

const RESULT_CAUSE = "profile-home pin piece";

const elementsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      tag: { type: "string" },
      source: { type: "string" },
      cell: { type: "unknown", asCell: ["cell"] },
    },
  },
  // deno-lint-ignore no-explicit-any
} as any;

describe("profile-home addPiece (followable piece card)", () => {
  let manager: EmulatedStorageManager;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await manager?.close();
  });

  for (const confidential of [false, true]) {
    it(
      confidential
        ? "refuses a confidentially selected address in a public profile"
        : "pins an existing piece as a cross-space link element",
      async () => {
        const rt = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
        });
        const report = spy(console, "error");
        try {
          const seed = rt.edit();
          const target = rt.getCellFromLink(
            {
              id: `of:${TARGET_PIECE}`,
              space: TARGET_SPACE,
              path: [],
            },
            { type: "object", ifc: { confidentiality: ["target-only"] } },
            seed,
          );
          target.set({ title: "Existing piece" } as never);
          rt.prepareTxForCommit(seed);
          expect((await seed.commit()).error).toBeUndefined();
          const sourceTx = rt.edit();
          const selection = rt.getCell(space, "pin-selection", {
            type: "string",
            ifc: { confidentiality: ["pin-selection"] },
          }, sourceTx);
          selection.set("selected");
          rt.prepareTxForCommit(sourceTx);
          expect((await sourceTx.commit()).error).toBeUndefined();
          const tx = rt.edit();
          const pattern = await rt.patternManager.compilePattern(PROGRAM, {
            space,
            tx,
          });
          const resultCell = rt.getCell<Record<string, unknown>>(
            space,
            RESULT_CAUSE,
            undefined,
            tx,
          );
          // deno-lint-ignore no-explicit-any
          const result = rt.run(
            tx,
            pattern as any,
            { initialName: "Ada" },
            resultCell,
          );
          rt.prepareTxForCommit(tx);
          const commit = await tx.commit();
          expect(commit.error).toBeUndefined();
          await result.pull();

          // Fire the exported `addPiece` stream with the target directly (the
          // "pin from the piece" event path; the edit-form path binds the same
          // handler to form cells).
          const tx2 = rt.edit();
          if (confidential) selection.withTx(tx2).get();
          result.withTx(tx2).key("addPiece").send({
            pieceSpace: TARGET_SPACE,
            pieceId: TARGET_PIECE,
            title: "Demo Counter",
          });
          // A manual test tx prepares the way the runtime's own commit paths do:
          // an enforcing rung refuses a relevant transaction that arrives
          // unprepared.
          rt.prepareTxForCommit(tx2);
          const commit2 = await tx2.commit();
          expect(commit2.error).toBeUndefined();
          await result.pull();
          await rt.idle();
          await result.pull();

          const elementsCell = result.key("elements").asSchema(elementsSchema);
          await elementsCell.sync();
          await elementsCell.pull();
          // deno-lint-ignore no-explicit-any
          const elements = elementsCell.get() as any[];
          if (confidential) {
            expect(elements).toEqual([]);
            const errors = JSON.stringify(
              report.calls.map((call) => call.args),
            );
            expect(errors).toContain("writer-fit confidentiality misfit");
            expect(errors).toContain("pin-selection");
            return;
          }
          expect(elements.length).toBe(1);
          expect(elements[0].source).toBe("piece");
          expect(elements[0].title).toBe("Demo Counter");

          // The element's `cell` is a real link to the pinned piece's space + id.
          await elements[0].cell.pull();
          const resolved = elements[0].cell.resolveAsCell();
          const link = resolved.getAsNormalizedFullLink();
          expect(link.space).toBe(TARGET_SPACE);
          expect(link.id).toBe(`of:${TARGET_PIECE}`);
          const clauses =
            getCfcReferenceProvenance(resolved.getAsLink())?.confidentiality ??
              [];
          const atoms = clauses.flatMap(clauseAlternatives);
          expect(atoms).not.toContain("pin-selection");
          expect(atoms).not.toContain("target-only");

          const again = rt.edit();
          result.withTx(again).key("addPiece").send({
            pieceSpace: TARGET_SPACE,
            pieceId: TARGET_PIECE,
            title: "Demo Counter",
          });
          rt.prepareTxForCommit(again);
          expect((await again.commit()).error).toBeUndefined();
          await result.pull();
          await rt.idle();
          expect((await elementsCell.pull()).length).toBe(1);
        } finally {
          report.restore();
          await rt.dispose();
        }
      },
    );
  }
});
