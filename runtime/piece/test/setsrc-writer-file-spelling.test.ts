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

const signer = await Identity.fromPassphrase("setsrc writer file spelling");

const PATTERN_SOURCE = [
  "import { handler, NAME, pattern, Writable, WriteAuthorizedBy } from 'commonfabric';",
  "",
  "const returnMembership = handler<void, { value: Writable<string> }>((_, { value }) => {",
  "  value.set('Returned loyalty number to hotel@example.com');",
  "});",
  "",
  "interface DemoOutput {",
  "  [NAME]: string;",
  "  membershipReturn: WriteAuthorizedBy<string, typeof returnMembership>;",
  "}",
  "",
  "export default pattern<Record<string, never>, DemoOutput>(() => {",
  "  const membershipReturn = new Writable('');",
  "  returnMembership({ value: membershipReturn });",
  "  return { [NAME]: 'Loyalty Return Demo', membershipReturn };",
  "});",
  "",
].join("\n");

// The same pattern content addressed by a chosen source-file name. Only the
// filename differs between revisions; the handler and its binding path do not.
function writerAuthorizedProgram(fileName: string): RuntimeProgram {
  return {
    main: fileName,
    files: [{ name: fileName, contents: PATTERN_SOURCE }],
  };
}

describe("setsrc over a writer-authorized field's source-file spelling", () => {
  // End-to-end counterpart to the writer-claim cases in
  // `schema-compatibility.test.ts`, exercised through the real `cf piece
  // setsrc` boundary (`piece.setPattern`) rather than the compatibility helper
  // alone.
  //
  // A field typed `WriteAuthorizedBy` lowers to a writer claim that records the
  // authoring module three ways: its content hash (`moduleIdentity`), its
  // source-file spelling (`file`), and the binding `path` within the module.
  // The runtime authorizes a write on `moduleIdentity` plus the binding `path`
  // and never consults `file`. Relocating the pattern to a new source file,
  // with the handler and its binding path unchanged, re-spells `file` (and,
  // because the hash covers the module's name, re-hashes `moduleIdentity`),
  // while the backward-compatibility gate ignores both of those and holds the
  // `path` and `uiContract` fixed. So the update carries the same authorization
  // and is accepted, and the settled piece points at the relocated pattern.

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

  it("accepts an update that only relocates the writer-authorized pattern's source file", async () => {
    const piece = await pieces.create(
      writerAuthorizedProgram("/loyalty-return.tsx"),
      { input: {} },
    );
    await runtime.idle();
    const before = getPatternIdentityRef(piece.getCell());

    // Byte-identical content under a different source-file name. Before the
    // compat gate stopped comparing the writer claim's `file`, this swap was
    // refused as `result.membershipReturn: ifc changed`, so the await below
    // would reject and fail the test.
    await piece.setPattern(writerAuthorizedProgram("/handlers/membership.tsx"));
    await runtime.idle();

    expect(
      getPatternIdentityRef(piece.getCell())?.identity,
      "the pattern pointer did not move, so the relocation was refused",
    ).not.toBe(before?.identity);
  });
});
