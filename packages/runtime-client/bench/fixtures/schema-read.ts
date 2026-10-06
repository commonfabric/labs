/**
 * A list of records as a schema-bearing read hands it back, which is what the
 * worker converts on its way to the client: every container carries the
 * back-to-cell annotation and is deeply frozen, and each record's `source` is
 * a `Cell` where the synthetic lists beside this fixture hold a link already.
 * The conversion takes a different branch on each, so a benchmark over the
 * synthetic list alone measures the branch no read result takes. Beside the
 * read sits a minter of cells carrying a CFC label view, for a subject shaped
 * as a labeled read would be.
 */

import { Identity } from "@commonfabric/identity";
import { type Cell, type JSONSchema, Runtime } from "@commonfabric/runner";
import {
  type CfcLabelView,
  withLinkCfcLabelView,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

/** The list's schema, whose `source` reads back as a `Cell`. */
const LIST_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      count: { type: "number" },
      done: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      source: { asCell: ["cell"] },
    },
  },
} as const satisfies JSONSchema;

const signer = await Identity.fromPassphrase("bench schema read");
const space = signer.did();

/**
 * The runtime the reads come from. It lives as long as the benchmarks do: a
 * value it hands back reaches into it through the annotation, and a `Cell`
 * in that value is one of its cells.
 */
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: StorageManager.emulate({ as: signer }),
});

/**
 * Reads a list of `items` records through the schema above, each record
 * holding a few scalars, a nested array, and a `source` referring to a
 * document of its own. What comes back is the read's own result, annotated
 * and frozen as a read leaves it.
 */
export async function readRecordList(items: number): Promise<unknown> {
  const cause = `schema-read-${items}`;

  {
    const tx = runtime.edit();
    const subjects = Array.from({ length: items }, (_, index) => {
      const subject = runtime.getCell<{ name: string }>(
        space,
        `${cause}-subject-${index}`,
        undefined,
        tx,
      );

      subject.set({ name: `Subject ${index}` });

      return subject;
    });

    runtime.getCell<unknown>(space, cause, undefined, tx).setRaw(
      subjects.map((subject, index) => ({
        title: `item number ${index}`,
        count: index,
        done: (index % 3) === 0,
        tags: [`tag-${index % 7}`, `tag-${index % 11}`],
        source: subject.getAsLink(),
      })),
    );

    await tx.commit().settled;
  }

  const tx = runtime.edit();
  const value = runtime.getCell(space, cause, LIST_SCHEMA, tx).get();

  // The read is what the transaction was for, so it is settled here rather
  // than left open behind the value, which converts the same either way.
  await tx.commit().settled;

  return value;
}

/**
 * A cell of this fixture's runtime carrying `view` as its CFC label view,
 * which is what a labeled read hands the conversion: the conversion attaches
 * the view's display form to the link it mints for the cell.
 */
export function cellCarryingLabelView(
  id: string,
  view: CfcLabelView,
): Cell<unknown> {
  const link = withLinkCfcLabelView(
    runtime.getCell(space, id).getAsLink(),
    view,
  );
  return runtime.getCellFromLink(link);
}
