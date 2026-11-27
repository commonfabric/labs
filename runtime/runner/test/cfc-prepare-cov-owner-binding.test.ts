/**
 * A field a source update adds with a placeholder `ownerPrincipal` belongs to
 * the piece's recorded creator, unless the stored label already names its
 * owner, and the claims its schema makes about no principal persist beside
 * that binding as written.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const alice = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-owner-binding",
);
const space = alice.did();
const bob = (await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-owner-binding-bob",
)).did();

/** The first release: a count, and nothing about any principal. */
const FIRST_RELEASE = `/// <cts-enable />
import { Default, pattern, Writable } from "commonfabric";
export default pattern<{ count: Writable<Default<number, 0>> }>(
  ({ count }) => ({ count }),
);
`;

/**
 * The second release: the same count, and an argument list the acting
 * principal owns, which also carries an integrity claim about no principal.
 */
const SECOND_RELEASE = `/// <cts-enable />
import {
  Cfc,
  CurrentPrincipal,
  Default,
  handler,
  Integrity,
  pattern,
  RepresentsCurrentUser,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
const edit = handler<{ add: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.set([...items.get(), event.add]);
  },
);
type Items = Integrity<
  RepresentsCurrentUser<
    Cfc<WriteAuthorizedBy<string[], typeof edit>, { ownerPrincipal: CurrentPrincipal }>
  >,
  ["items-verified"]
>;
export default pattern<{
  count: Writable<Default<number, 0>>;
  items: Writable<Default<Items, []>>;
}>(({ count, items }) => ({ count, items, add: edit({ items }) }));
`;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const compile = (runtime: Runtime, source: string): Promise<Pattern> =>
    runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    }, { space });

  /**
   * Creates a piece of the first release, then updates it to the second,
   * which adds `items`. With `storedOwner`, the argument document's stored
   * label already names that owner at `items` before the update. Returns the
   * integrity the stored label at `items` holds after it.
   */
  const updatedItemsIntegrity = async (storedOwner?: string) => {
    storageManager = StorageManager.emulate({ as: alice });
    runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      experimental: { pieceCreatorRecord: true },
    });
    const first = await compile(runtime, FIRST_RELEASE);
    const created = runtime.getCell(space, "piece", first.resultSchema);
    const createTx = runtime.edit();
    runtime.run(createTx, first, {}, created);
    expect((await createTx.commit().settled).error).toBeUndefined();
    const link: NormalizedFullLink = created.getAsNormalizedFullLink();
    const argument = getMetaLink(runtime.getCellFromLink(link), "argument")!;

    if (storedOwner !== undefined) {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { ...argument, path: ["cfc"] }, {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["items"],
            origin: "declared",
            label: {
              integrity: [{
                kind: "represents-principal",
                subject: storedOwner,
              }],
            },
          }],
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
    }

    const second = await compile(runtime, SECOND_RELEASE);
    const updateTx = runtime.edit();
    const result = runtime.getCellFromLink(link, second.resultSchema, updateTx);
    runtime.run(updateTx, second, undefined, result);
    runtime.prepareTxForCommit(updateTx);
    expect((await updateTx.commit().settled).error).toBeUndefined();
    await runtime.idle();

    const read = runtime.edit();
    const integrity = (readStoredCfcMetadata(read, argument)?.labelMap
      .entries ?? [])
      .filter((entry) => entry.path.join("/") === "items")
      .flatMap((entry) => entry.label.integrity ?? []);
    read.abort();
    return integrity;
  };

  it("persists an update-added owner field's other integrity claims beside its creator's binding", async () => {
    const integrity = await updatedItemsIntegrity();

    expect(integrity).toContainEqual("items-verified");
    expect(integrity).toContainEqual({
      kind: "represents-principal",
      subject: alice.did(),
    });
  });

  it("keeps the owner the stored label already names at an update-added field, and binds no creator beside it", async () => {
    const integrity = await updatedItemsIntegrity(bob);

    expect(integrity).toContainEqual("items-verified");
    expect(integrity).toContainEqual({
      kind: "represents-principal",
      subject: bob,
    });
    expect(integrity).not.toContainEqual({
      kind: "represents-principal",
      subject: alice.did(),
    });
  });
});
