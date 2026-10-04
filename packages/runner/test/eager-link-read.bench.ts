/**
 * What it costs to read a list of links through a schema, eagerly.
 *
 * A read on a transaction that does not materialize lazily walks the whole
 * value its schema selects before it returns, and follows every link it
 * crosses on the way. That is the read `Cell.get()` makes outside a
 * derivation. Each link crossed also costs a read of the labels stored in the
 * document holding it, since a handle reached through a labeled slot carries
 * that slot's label.
 *
 * The fixture is a list of links to row documents, each row holding a title
 * and a link to one shared subject document, which the schema reads as a
 * handle. Reading a row therefore crosses two links: the list's link to the
 * row, and the row's link to the subject. Nothing in the fixture is labeled,
 * so this is the cost a read pays for label tracking where there are no
 * labels.
 *
 * Two sizes, 200 and 2000 rows, in one group, so that a change in how the
 * cost grows with the list shows as the two lines moving apart. One runtime
 * and one seeded pair of lists serve the whole file, and every iteration
 * aborts its transaction, so no iteration pays for a runtime, a store, or a
 * document write, and none leaves state behind for the next.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("bench eager link read");
const space = signer.did();

/** The list sizes measured, each seeded as a list of its own. */
const SIZES = [200, 2000] as const;

/** What a reader of the list declares: each row's subject as a handle. */
const ROW_LIST_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      subject: { asCell: ["cell"] },
    },
  },
} as const satisfies JSONSchema;

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

/** The cause naming the list of `size` rows. */
const listCause = (size: number) => `eager-link-read-list-${size}`;

{
  const tx = runtime.edit();
  const subject = runtime.getCell<{ name: string }>(
    space,
    "eager-link-read-subject",
    undefined,
    tx,
  );
  subject.set({ name: "subject" });
  for (const size of SIZES) {
    // `setRaw` with explicit links, so each row holds a reference to the
    // subject and the list holds references to the rows, rather than copies.
    const rows = Array.from({ length: size }, (_, index) => {
      const row = runtime.getCell<unknown>(
        space,
        `eager-link-read-row-${size}-${index}`,
        undefined,
        tx,
      );
      row.setRaw({ title: `Row ${index}`, subject: subject.getAsLink() });
      return row.getAsLink();
    });
    runtime.getCell<unknown>(space, listCause(size), undefined, tx)
      .setRaw(rows);
  }
  await tx.commit();
}

for (const size of SIZES) {
  Deno.bench({
    name: `${size} rows`,
    group: "eager link read",
    baseline: size === SIZES[0],
    fn(b) {
      const tx = runtime.edit();
      const list = runtime.getCell(space, listCause(size), ROW_LIST_SCHEMA, tx);
      b.start();
      const rows = list.get();
      b.end();
      // Untimed: a fixture that stopped resolving fails loudly rather than
      // reporting a fast empty read.
      if (rows.length !== size || !rows.every((row) => isCell(row.subject))) {
        throw new Error(`read ${rows.length} of ${size} rows as handles`);
      }
      tx.abort("bench");
    },
  });
}
