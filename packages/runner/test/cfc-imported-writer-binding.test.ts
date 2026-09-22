import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("imported-writer-binding");
const space = signer.did();

// The claim is written in the importing module; the writer is declared in
// another, and reached through a re-export under a different name. The
// schema must name the DECLARING module and the declared name, and that
// module must give the handler its binding identity, or the runtime finds no
// identity to verify the claim against and refuses the very write the claim
// authorizes. The policy type is spelled three ways — as the library names
// it, renamed at the import, and renamed through an authored re-export — and
// the claim, the identity and the admitted write must agree under each.
const WRITER = {
  name: "/writer.ts",
  contents: `/// <cts-enable />
import { handler, Writable } from "commonfabric";
export const writer = handler<void, { name: Writable<string> }>(
  (_event, { name }) => { name.set("updated"); },
);`,
};
const BARREL = { name: "/barrel.ts", contents: `export * from "./writer.ts";` };

const program = (
  imports: string,
  policy: string,
  extra: RuntimeProgram["files"] = [],
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: `/// <cts-enable />
${imports}
import { writer as save } from "./barrel.ts";
export default pattern<Record<string, never>, {
  name: ${policy}<string, typeof save>;
  save: Stream<void>;
}>(() => {
  const name = new Writable<string>("").for("name");
  return { name, save: save({ name }) };
});`,
    },
    ...extra,
    BARREL,
    WRITER,
  ],
});

const PROGRAMS: [string, RuntimeProgram][] = [
  [
    "the library's name",
    program(
      `import { pattern, Stream, Writable, WriteAuthorizedBy } from "commonfabric";`,
      "WriteAuthorizedBy",
    ),
  ],
  [
    "a renamed import",
    program(
      `import { pattern, Stream, Writable, WriteAuthorizedBy as Guarded } from "commonfabric";`,
      "Guarded",
    ),
  ],
  [
    "a renamed re-export",
    program(
      `import { pattern, Stream, Writable } from "commonfabric";
import { Guarded } from "./policy.ts";`,
      "Guarded",
      [{
        name: "/policy.ts",
        contents:
          `export { WriteAuthorizedBy as Guarded } from "commonfabric";`,
      }],
    ),
  ],
];

describe("a writer imported from another module", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  for (const [spelling, PROGRAM] of PROGRAMS) {
    it(`carries its binding identity and satisfies a claim spelled with ${spelling}`, async () => {
      const rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const bindingPaths: string[][] = [];
      rt.telemetry.addEventListener("telemetry", (event: Event) => {
        const { marker } = (event as RuntimeTelemetryEvent).detail;
        if (
          marker.type === "harness.implementation.register" &&
          marker.bindingPath !== undefined
        ) bindingPaths.push(marker.bindingPath);
      });
      try {
        const tx = rt.edit();
        const pattern = await rt.patternManager.compilePattern(PROGRAM, {
          space,
          tx,
        });
        const resultCell = rt.getCell<{ name: string }>(
          space,
          `imported-writer-binding ${spelling}`,
          undefined,
          tx,
        );
        const result = rt.run(tx, pattern, {}, resultCell);
        rt.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await result.pull();
        await rt.idle();

        // The declaring module minted the identity, under the declared name.
        expect(bindingPaths).toContainEqual(["writer"]);

        const send = rt.edit();
        result.withTx(send).key("save").send(undefined);
        expect((await send.commit()).error).toBeUndefined();
        await rt.idle();
        await result.pull();
        expect(result.key("name").get()).toBe("updated");
      } finally {
        await rt.dispose();
      }
    });
  }
});
