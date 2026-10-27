/**
 * Runs the real Home pattern (`packages/patterns/system/home.tsx`) and holds
 * the documents it keeps `profiles`, `mru` and its earlier default in to the
 * write contracts its cells declare: the documents a new Home creates, and the
 * ones an older Home, whose cells declared none, already holds once Home's
 * source updates. The untrusted writes go in under Home's result schema and
 * through each stored document's own address.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../src/cfc/ui-contract.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { asStoredValue } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("home profile lists");
const home = signer.did();

/** What a commit a document's write contract refuses fails with. */
const REFUSED = /writeAuthorizedBy|writePolicyAnyOf/;

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/**
 * Home's cells for `profiles`, `mru` and the earlier default, as they are
 * declared now, and as an older Home declared them, with no contract.
 */
const DECLARATIONS: [string, string][] = [
  [
    `new Writable<TrustedProfileList>([]).for("profiles")`,
    `new Writable<BackwardsCompatibleProfile[]>([]).for("profiles")`,
  ],
  [
    `new Writable<TrustedProfileMru>([]).for("mru")`,
    `new Writable<BackwardsCompatibleProfile[]>([]).for("mru")`,
  ],
  [
    `new Writable<TrustedLegacyDefaultProfile>()\n      .for("defaultProfile")`,
    `new Writable<BackwardsCompatibleProfile>().for("defaultProfile")`,
  ],
  [
    `profiles: Writable<Default<TrustedProfileList, []>>;`,
    `profiles: Writable<BackwardsCompatibleProfile[]>;`,
  ],
  [
    `mru: Writable<Default<TrustedProfileMru, []>>;`,
    `mru: Writable<BackwardsCompatibleProfile[]>;`,
  ],
  // An older Home said no earlier default's space.
  [
    `computed(() =>\n      spaceOf(legacyDefaultProfile)\n    )`,
    `computed((): string | undefined => undefined)`,
  ],
];

describe("home-profile-lists", () => {
  let manager: EmulatedStorageManager;
  let rt: Runtime;
  let program: RuntimeProgram;
  let host: Cell<Record<string, unknown>>;

  beforeEach(async () => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    program = await resolveLocalProgram(
      (resolver) => rt.harness.resolve(resolver),
      {
        main: new URL("../../patterns/system/home.tsx", import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
    host = rt.getCell<Record<string, unknown>>(home, "home");
  });

  afterEach(async () => {
    rt.runner.stop(host);
    await rt.dispose({ closeStorage: false });
    await manager.close();
  });

  /** Home's program as an older Home's source declared its lists. */
  function olderProgram(): RuntimeProgram {
    return {
      ...program,
      files: program.files.map((file) => {
        if (file.name !== program.main) return file;
        let contents = file.contents;
        for (const [now, before] of DECLARATIONS) {
          expect(contents).toContain(now);
          contents = contents.replace(now, before);
        }
        return { ...file, contents };
      }),
    };
  }

  /** Runs `source` as Home on `host`, and returns its compiled pattern. */
  async function runHome(source: RuntimeProgram) {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(source, {
      space: home,
      tx,
    });
    const result = rt.run(tx, pattern, {}, host);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return pattern;
  }

  /** The stored document of Home's that `.for(name)` names. */
  function stored(
    pattern: Awaited<ReturnType<typeof runHome>>,
    name: string,
  ): Cell<unknown> {
    const descriptor = pattern.derivedInternalCells?.find((item) =>
      item.partialCause === name
    );
    if (descriptor === undefined) throw new Error(`Home has no ${name}.`);
    return rt.getCellFromLink(getDerivedInternalCellLink(host, descriptor));
  }

  /**
   * Commits what `write` writes with no handler's authority, and returns the
   * commit's error message.
   */
  async function untrusted(
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string | undefined> {
    const tx = rt.edit();
    write(tx);
    tx.prepareCfc();
    const { error } = await tx.commit().settled;
    await rt.idle();
    return error?.message;
  }

  /** Creates a profile named `name`, as a click on the create form does. */
  async function create(name: string): Promise<void> {
    const event = {
      type: "click",
      name,
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfileCreateSurface",
        action: "CreateProfile",
      }),
    };
    markRendererTrustedEvent(event);
    const tx = rt.edit();
    host.withTx(tx).key("createProfile").send(event);
    await tx.commit().settled;
    await rt.idle();
    await host.pull();
  }

  /** A document in a space of its own, standing in for someone's profile. */
  async function elsewhere(): Promise<Cell<unknown>> {
    const space = await rt.createSpace({ grants: {} });
    return rt.getCell(space, "a profile someone else listed");
  }

  /** The spaces of the profiles Home's list `key` links. */
  function listed(key: string): string[] {
    return (host.key(key).asSchema(linkListSchema).get() ?? []).map((link) =>
      link.getAsNormalizedFullLink().space
    );
  }

  it("refuses a write by anything but Home's handlers to its lists and its earlier default, through Home's result or to the stored documents", async () => {
    const pattern = await runHome(program);
    await create("Ada");
    const theirs = await elsewhere();
    const viaResult = (tx: IExtendedStorageTransaction) =>
      rt.getCell(home, "home", pattern.resultSchema, tx);

    for (const key of ["profiles", "mru"]) {
      expect(await untrusted((tx) => viaResult(tx).key(key).set([])))
        .toMatch(REFUSED);
      expect(
        await untrusted((tx) =>
          stored(pattern, key).withTx(tx).setRaw([
            asStoredValue(theirs.getAsLink()),
          ])
        ),
      ).toMatch(REFUSED);
    }
    expect(
      await untrusted((tx) =>
        stored(pattern, "defaultProfile").withTx(tx).setRaw(theirs.getAsLink())
      ),
    ).toMatch(REFUSED);
    expect(listed("profiles")).toHaveLength(1);
    expect(listed("mru")).toEqual([]);
  });

  it("protects the lists an older Home stored once Home's source updates, keeping what they hold", async () => {
    const older = await runHome(olderProgram());
    const listedBefore = await elsewhere();
    expect(
      await untrusted((tx) =>
        stored(older, "profiles").withTx(tx).setRaw([
          asStoredValue(listedBefore.getAsLink()),
        ])
      ),
    ).toBeUndefined();
    rt.runner.stop(host);

    const current = await runHome(program);
    const theirs = await elsewhere();

    for (const key of ["profiles", "mru"]) {
      expect(
        await untrusted((tx) =>
          stored(current, key).withTx(tx).setRaw([
            asStoredValue(theirs.getAsLink()),
          ])
        ),
      ).toMatch(REFUSED);
    }
    expect(
      await untrusted((tx) =>
        stored(current, "defaultProfile").withTx(tx).setRaw(theirs.getAsLink())
      ),
    ).toMatch(REFUSED);
    expect(listed("profiles")).toEqual([
      listedBefore.getAsNormalizedFullLink().space,
    ]);

    await create("Ada");
    expect(listed("profiles")).toHaveLength(2);
  });
});
