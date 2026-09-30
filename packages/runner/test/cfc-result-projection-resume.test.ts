import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-result-projection-resume");
const space = signer.did();

const program = (privateName: boolean) => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
      import { Confidential, NAME, pattern } from "commonfabric";
      const PrivatePanel = pattern<{}, {
        [NAME]: ${
      privateName ? 'Confidential<string, readonly ["secret"]>' : "string"
    };
        body: Confidential<string, readonly ["secret"]>;
      }>(() => ({ [NAME]: "Private panel", body: "private content" }));
      const PublicPanel = pattern(() => ({ body: "public content" }));
      export default pattern(() => ({
        privatePanel: PrivatePanel({}),
        publicPanel: PublicPanel({}),
      }));
    `,
  }],
});

describe("cfc-result-projection-resume", () => {
  for (
    const [privateName, absentName] of [[false, false], [true, false], [
      true,
      true,
    ]]
  ) {
    it(
      privateName
        ? absentName
          ? "retains confidentiality when a preserved private name is absent"
          : "retains confidentiality when copying a changed private name during resume"
        : "keeps public sibling references public when resuming a confidential projection",
      async () => {
        const storage = StorageManager.emulate({ as: signer });
        const createRuntime = () =>
          new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager: storage,
            cfcFlowLabels: "persist",
          });
        const first = createRuntime();
        const second = createRuntime();
        try {
          const pattern = await first.patternManager.compilePattern(
            program(privateName),
            {
              space,
            },
          );
          const setup = first.edit();
          const result = first.getCell(space, "panels", undefined, setup);
          first.run(setup, pattern, {}, result);
          expect((await setup.commit()).error).toBeUndefined();
          await result.pull();
          if (privateName) {
            const rename = first.edit();
            result.withTx(rename).key("privatePanel").key("$NAME").set(
              absentName ? undefined : "Renamed private panel",
            );
            expect((await rename.commit()).error).toBeUndefined();
          }
          first.runner.stop(result);

          const resumed = second.getCellFromLink(
            result.getAsNormalizedFullLink(),
          );
          await second.start(resumed);
          await resumed.pull();

          const publicRead = second.edit();
          expect(
            resumed.withTx(publicRead).key("publicPanel").key("body").get(),
          )
            .toBe("public content");
          expect(deriveFlowJoin(publicRead).confidentiality).toEqual(
            privateName ? ["secret"] : [],
          );
          publicRead.abort();

          const privateRead = second.edit();
          expect(
            resumed.withTx(privateRead).key("privatePanel").key("body").get(),
          )
            .toBe("private content");
          expect(deriveFlowJoin(privateRead).confidentiality).toContain(
            "secret",
          );
          if (privateName) {
            expect(
              resumed.withTx(privateRead).key("privatePanel").key("$NAME")
                .get(),
            )
              .toBe(absentName ? "Private panel" : "Renamed private panel");
          }
          privateRead.abort();
        } finally {
          await storage.synced();
          await second.dispose();
          await first.dispose();
          await storage.close();
        }
      },
    );
  }
});
