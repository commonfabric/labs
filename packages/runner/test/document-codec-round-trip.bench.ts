/**
 * What a commit costs in codec work, and what that cost is set by.
 *
 * A document crosses the storage boundary as wire text: committing one encodes
 * it, and the other side parses it back and deep-freezes the object graph that
 * comes out. A commit makes about eighteen of those crossings whatever it
 * writes — but each one carries a WHOLE document, so writing a single scalar
 * moves as many bytes as the document holding it, not as many as the write.
 *
 * That is the shape a collection runs into. A board keeps its list in one
 * document and writes on every change, so the bytes each write puts through
 * the codec grow with what the board already holds while the number of
 * crossings stays flat. Seeding a board is a run of such writes, which is why
 * its cost climbs faster than the number of things on it.
 *
 * Two commits, differing only in the size of the document they land in:
 *
 *   - **small document**: a scalar on a document of a few kilobytes. The floor
 *     — what a commit costs before the document under it counts for anything.
 *   - **large document**: the same scalar write, on a document two orders of
 *     magnitude larger. The write is identical; the difference is what the
 *     document costs to move.
 *
 * Each write stores a value the document did not already hold, because a write
 * of the value already there is elided and commits nothing — a benchmark
 * written without that lands on the elision path and reports it as the cost of
 * a commit.
 *
 * The diagnostic reports the wire size of both documents. That is the quantity
 * the difference between the two timings is made of, and unlike them it does
 * not depend on the machine.
 *
 * Environment controls:
 * - CODEC_PADDING_ROWS: lines of prose in the large document, default 400
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("bench document codec");
const space = signer.did();

const PADDING_ROWS = Number(Deno.env.get("CODEC_PADDING_ROWS") ?? "400");

/** Words of prose in a line of padding, matching what a topic body carries. */
const BODY = Array.from({ length: 120 }, (_, index) => `word${index % 24}`)
  .join(" ");

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const SMALL_CAUSE = "codec-small-document";
const LARGE_CAUSE = "codec-large-document";

interface Revisioned {
  revision: number;
  padding: string[];
}

{
  const tx = runtime.edit();
  runtime.getCell<Revisioned>(space, SMALL_CAUSE, undefined, tx)
    .set({ revision: 0, padding: [BODY] });
  runtime.getCell<Revisioned>(space, LARGE_CAUSE, undefined, tx)
    .set({
      revision: 0,
      padding: Array.from(
        { length: PADDING_ROWS },
        (_, index) => `${BODY} ${index}`,
      ),
    });
  await tx.commit().settled;
}

/**
 * A value no document holds yet, so every write below is a real one. A write
 * of the value already stored is elided, and a benchmark that made one would
 * be timing the elision rather than the commit.
 */
let nextRevision = 1;

const commitScalar = async (cause: string): Promise<void> => {
  const tx = runtime.edit();
  runtime.getCell<Revisioned>(space, cause, undefined, tx)
    .key("revision").set(nextRevision++);
  await tx.commit().settled;
};

const DOCUMENTS: [label: string, cause: string, baseline: boolean][] = [
  ["small document", SMALL_CAUSE, true],
  ["large document", LARGE_CAUSE, false],
];

for (const [label, cause, baseline] of DOCUMENTS) {
  Deno.bench({
    name: `commit a scalar - ${label}`,
    group: "document codec",
    baseline,
    async fn(b) {
      // Untimed, so the timed commit below is not the one that first brings
      // this document into the runtime's caches.
      await commitScalar(cause);
      b.start();
      await commitScalar(cause);
      b.end();
    },
  });
}

// The wire size of each document. A document crosses the boundary whole, so
// this is what separates the two timings — reported once, outside every timed
// window, and the same on every machine.
{
  const tx = runtime.edit();
  const wireSize = (cause: string): number =>
    JSON.stringify(
      runtime.getCell<unknown>(space, cause, undefined, tx).getRaw() ?? null,
    ).length;
  benchDiagnostic(
    `[document-codec] wire bytes — small: ${wireSize(SMALL_CAUSE)}; ` +
      `large: ${wireSize(LARGE_CAUSE)}`,
  );
  tx.abort("diagnostic");
}
