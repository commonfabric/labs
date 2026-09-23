import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { CellScope, Pattern } from "../src/builder/types.ts";
import { getDerivedInternalCellLink, parseLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("internal-cell-manifest");
const space = signer.did();

describe("internal-cell-manifest", () => {
  for (const route of ["setup", "start repair"] as const) {
    it(`initializes a named cell's new scope during ${route}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const scopedPattern = (scope: CellScope): Pattern => {
        const pattern = trustPattern(runtime, {
          argumentSchema: {},
          resultSchema: {},
          result: { value: { $alias: { partialCause: "named", path: [] } } },
          derivedInternalCells: [{
            partialCause: "named",
            scope,
            schema: { type: "number", default: 7 },
          }],
          nodes: [],
        });
        runtime.patternManager.associatePatternIdentity(pattern, {
          identity: `manifest-${scope}`,
          symbol: "default",
        });
        return pattern;
      };
      try {
        const shared = scopedPattern("space");
        const personal = scopedPattern("user");
        const result = runtime.getCell(space, `scope change ${route}`);
        await runtime.setup(undefined, shared, {}, result);
        const sharedLink = getDerivedInternalCellLink(
          result,
          shared.derivedInternalCells![0],
        );
        const personalLink = getDerivedInternalCellLink(
          result,
          personal.derivedInternalCells![0],
        );
        expect(sharedLink.id).toBe(personalLink.id);
        const write = runtime.edit();
        runtime.getCellFromLink(sharedLink, undefined, write).set(42);
        expect((await write.commit()).error).toBeUndefined();

        if (route === "setup") {
          await runtime.setup(undefined, personal, {}, result);
        } else {
          const move = runtime.edit();
          result.withTx(move).setMetaRaw("patternIdentity", {
            identity: "manifest-user",
            symbol: "default",
          }, rawMetaWriteAuthorization);
          expect((await move.commit()).error).toBeUndefined();
          expect(await runtime.start(result)).toBe(true);
          await result.pull();
          await runtime.idle();
        }

        expect(runtime.getCellFromLink(personalLink).getRaw()).toBe(7);
        expect(runtime.getCellFromLink(sharedLink).getRaw()).toBe(42);
        const manifest = result.getMetaRaw("internal") as { link: unknown }[];
        expect(manifest).toHaveLength(1);
        expect(parseLink(manifest[0].link, result)).toMatchObject({
          id: personalLink.id,
          scope: "user",
          space,
          path: [],
        });
      } finally {
        await runtime.idle();
        await storageManager.synced();
        await runtime.dispose();
        await storageManager.close();
      }
    });
  }
});
