/**
 * A nested piece's argument can live in its host's document, which may be
 * unreadable in this replica. Setup preserves the stored bytes and defers
 * validation of that document to reactive reads. The Piece API preserves the
 * distinction between an unreadable document and a readable wrong value.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

const signer = await Identity.fromPassphrase("setsrc cold argument");

/**
 * Two revisions whose argument schemas are IDENTICAL, each carrying a REQUIRED
 * object field. Identical schemas are what isolates the argument check: the
 * contract proof (`assertPatternSchemasBackwardCompatible`) has nothing to
 * complain about, so the only rule that can refuse this swap is one that reads
 * the stored argument. `required` with no default is what makes the read
 * decisive — validating `undefined` against it cannot pass.
 *
 * `marker` is the only difference, so a successful swap is observable in the
 * piece's own output rather than inferred.
 */
function registryProgram(marker: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "interface Args { registry: { label: string } }",
        "export default pattern<Args, { marker: string }>(",
        "  () => ({",
        "    [NAME]: 'Cold argument',",
        `    marker: ${JSON.stringify(marker)},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

describe("setsrc over a cold argument document", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("applies a candidate whose stored argument cannot be read right now", async () => {
    const piece = await pieces.create(registryProgram("v1"), {
      input: { registry: { label: "hello" } },
    });
    await runtime.idle();
    const before = getPatternIdentityRef(piece.getCell());

    // Repoint the piece's argument at a document nothing has ever written, the
    // same way the runner's CT-1917 case does. The read succeeds and yields
    // NOTHING — which is the state under test — rather than erroring, so the
    // review downstream sees `undefined` where a live host would later supply
    // the real argument.
    const cold = runtime.getCell<Record<string, unknown>>(
      piece.getCell().space,
      "setsrc-cold-argument-doc",
    );
    const { error: retargetError } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw(
        "argument",
        cold.getAsWriteRedirectLink({ base: piece.getCell() }),
        rawMetaWriteAuthorization,
      );
    });
    expect(
      retargetError?.message,
      "the fixture could not repoint the argument, so the case below would " +
        "run against a WARM argument and pass without testing anything",
    ).toBeUndefined();
    await runtime.idle();

    // Guard the fixture itself. If this ever reads a value, the case has gone
    // warm and its verdict means nothing.
    const argument = pieces.getArgument(piece.getCell());
    await argument.sync();
    expect(
      argument.asSchema(undefined).get(),
      "the argument document is readable, so this is no longer the cold case",
    ).toBeUndefined();

    // The contract: the swap is ACCEPTED. A cold slot is deferred, not failed.
    await piece.setPattern(registryProgram("v2"));
    await runtime.idle();

    expect(
      getPatternIdentityRef(piece.getCell())?.identity,
      "the pattern pointer did not move, so the swap was refused over an " +
        "argument the piece merely could not read (CT-1917)",
    ).not.toBe(before?.identity);
    expect(
      (piece.getCell().getAsQueryResult() as { marker?: string }).marker,
    ).toBe("v2");
  });
});
