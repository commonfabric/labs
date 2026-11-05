/**
 * Holds `#profile`, a runtime's preferred profile, and the guard Home's
 * `retireProfile` keeps on the profile `#profile` returns to the rule for
 * which listed profiles are the person's (`profileOwnerAt()`): a profile
 * whose name is attested to someone else, one whose name is borrowed from
 * another document, and a document carrying no label at all are none of
 * theirs. The person's Home is the real pattern, its profiles made by its own
 * `createProfile`; a stranger makes a profile of their own, through the
 * profile's own `setName`, on a runtime of their own over the same server.
 * Each is linked from the person's lists by a write to the stored documents
 * beneath the runtime's write checks, since the lists' policies refuse every
 * writer but Home's handlers.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../src/cfc/ui-contract.ts";
import {
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import {
  loadProfileOwnerDocuments,
  profileOwnerAt,
} from "../src/profile-owner.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  asStoredValue,
  seedProfileOwner,
  seedStoredEnvelope,
  storedFields,
  storedList,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("profile ownership owner");
const stranger = await Identity.fromPassphrase("profile ownership stranger");
const home = owner.did();

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/** The space `profile` lives in. */
function spaceOf(profile: Cell<unknown>): MemorySpace {
  return profile.getAsNormalizedFullLink().space;
}

// One cache for every runtime this file makes, so that a pattern compiles
// once per file rather than once per case.
const moduleByteCache = createCompileByteCache();

describe("profile-ownership", () => {
  let server: ReturnType<typeof newSharedServer>;
  let rt: Runtime;
  let host: Cell<Record<string, unknown>>;
  let ada: Cell<unknown>;
  let alan: Cell<unknown>;
  const opened: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    ({ runtime: rt } = open());
    const program = await systemProgram(rt, "home/home.tsx");
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    host = rt.getCell<Record<string, unknown>>(home, "home", undefined, tx);
    const result = rt.run(tx, pattern, {}, host);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await linkHome(host);
    await create("Ada");
    await create("Alan");
    [ada, alan] = links("profiles");
  });

  afterEach(async () => {
    rt.runner.stop(host);
    for (const { runtime, storage } of opened.splice(0)) {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
    await server.close();
  });

  /** A runtime of its own over the shared server, acting as `as`. */
  function open(
    as: Identity = owner,
    preferredProfileSpace?: MemorySpace,
  ): { runtime: Runtime; storage: EmulatedStorageManager } {
    const storage = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      moduleByteCache,
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...(preferredProfileSpace === undefined ? {} : { preferredProfileSpace }),
    });
    opened.push({ runtime, storage });
    return { runtime, storage };
  }

  /** The program of the system pattern `name`, resolved from the checkout. */
  function systemProgram(runtime: Runtime, name: string) {
    return resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL(`../../../patterns/system/${name}`, import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
  }

  /** Links `target` from the home space cell's `field`. */
  async function linkHome(target: Cell<unknown>): Promise<void> {
    const tx = rt.edit();
    rt.getHomeSpaceCell(tx).key("defaultPattern").set(target);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  }

  /** Sends `event` on Home's stream `stream`, and settles. */
  async function send(stream: string, event: unknown): Promise<void> {
    const tx = rt.edit();
    host.withTx(tx).key(stream).send(event);
    await tx.commit().settled;
    await rt.idle();
    await host.pull();
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
    await send("createProfile", event);
  }

  /** The links Home's list under `key` holds. */
  function links(key: string): readonly Cell<unknown>[] {
    return host.key(key).asSchema(linkListSchema).get() ?? [];
  }

  /** The spaces of the profiles Home lists as retired, in order. */
  function retired(): string[] {
    return links("retiredProfiles").map(spaceOf);
  }

  /**
   * Makes a profile named `name` as the stranger, in the stranger's own
   * space, names it through its own `setName`, which labels the name as the
   * stranger's, and returns it as the owner's runtime holds it.
   */
  async function strangersProfile(name: string): Promise<Cell<unknown>> {
    const { runtime } = open(stranger);
    const program = await systemProgram(
      runtime,
      "profile-home/profile-home.tsx",
    );
    let tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: stranger.did(),
      tx,
    });
    const profile = runtime.getCell<Record<string, unknown>>(
      stranger.did(),
      "a stranger's profile",
      undefined,
      tx,
    );
    runtime.run(tx, pattern, { initialName: name }, profile);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await profile.pull();
    tx = runtime.edit();
    profile.withTx(tx).key("setName").send({ name });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
    runtime.runner.stop(profile);
    return rt.getCellFromLink(profile.getAsNormalizedFullLink());
  }

  /**
   * Appends `profile` to Home's `profiles` and puts it at the head of its
   * `mru`, writing the stored documents beneath the runtime's write checks,
   * so that `#profile` would answer with it if it were the person's.
   */
  async function listFirst(profile: Cell<unknown>): Promise<void> {
    for (const key of ["profiles", "mru"]) {
      const list = host.key(key).resolveAsCell();
      await list.sync();
      const document = { ...list.getAsNormalizedFullLink(), path: [] };
      const tx = rt.edit();
      const stored = storedFields(tx, document);
      const held = storedList(stored.value);
      const added = asStoredValue(profile.getAsLink());
      seedStoredEnvelope(tx, document, {
        ...stored,
        value: key === "mru" ? [added, ...held] : [...held, added],
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
    }
    await host.pull();
  }

  /**
   * Rewrites the `name` the document of `profile` holds to `name`, beneath
   * the runtime's write checks and keeping its stored labels, so that its
   * label goes on naming the person while its name links into documents that
   * are not its own.
   */
  async function renameBeneathChecks(
    profile: Cell<unknown>,
    name: FabricValue,
  ): Promise<void> {
    const document = {
      ...profile.resolveAsCell().getAsNormalizedFullLink(),
      path: [],
    };
    const tx = rt.edit();
    const stored = storedFields(tx, document);
    const { value } = stored;
    if (value === undefined || !isFabricPlainObject(value)) {
      throw new Error("The profile's document holds no record.");
    }
    seedStoredEnvelope(tx, document, { ...stored, value: { ...value, name } });
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  }

  /**
   * A document in a space of its own, which anyone may write, holding what
   * `value` makes of it and carrying no label, as a profile would be if a
   * write no handler made stored it.
   */
  async function rawDocument(
    value: (document: Cell<FabricValue>) => FabricValue,
  ): Promise<Cell<unknown>> {
    const space = await rt.createSpace({ grants: { "*": "WRITE" } });
    const document = rt.getCell<FabricValue>(
      space,
      "a document that is no one's profile",
    );
    const tx = rt.edit();
    document.withTx(tx).setRaw(value(document));
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
    return document;
  }

  /**
   * The address of the profile `#profile` answers with on `runtime`, as
   * {@link addressOf} gives it, or the message of the error the wish reports.
   */
  async function profileAnswer(runtime: Runtime): Promise<unknown> {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      pattern(() => ({ profile: wish({ query: "#profile", headless: true }) })),
      {},
      runtime.getCell<Record<string, unknown>>(
        home,
        `profile ownership wish ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    await tx.commit().settled;
    await result.pull();
    const found = result.key("profile");
    return found.key("result").getRaw() === undefined
      ? String(found.key("error").get())
      : addressOf(found.key("result").resolveAsCell());
  }

  /** The space and document `profile` is, which tell any two apart. */
  function addressOf(profile: Cell<unknown>): string {
    const { space, id } = profile.resolveAsCell().getAsNormalizedFullLink();
    return `${space}/${id}`;
  }

  /** The person whose own profile `profile` is (`profileOwnerAt()`). */
  async function ownerOf(profile: Cell<unknown>): Promise<string | undefined> {
    await loadProfileOwnerDocuments(rt, profile);
    const tx = rt.edit();
    try {
      return profileOwnerAt(rt, tx, profile);
    } finally {
      tx.abort();
    }
  }

  /**
   * A document in `space` holding `value` and nothing else, written beneath
   * the runtime's write checks, so that it carries no label and names no
   * owner, as a document a setup stored as a cell's default does.
   */
  async function bareDocument(
    space: MemorySpace,
    value: FabricValue,
  ): Promise<Cell<unknown>> {
    const document = rt.getCell<unknown>(space, crypto.randomUUID());
    const tx = rt.edit();
    seedStoredEnvelope(
      tx,
      { ...document.getAsNormalizedFullLink(), path: [] },
      {
        value,
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
    return document;
  }

  /**
   * Rewrites the value the `name` cell of `profile` holds to `value`, beneath
   * the runtime's write checks and keeping the cell's other stored fields, so
   * that the cell stays the profile's own while what it holds changes.
   */
  async function rewriteNameCell(
    profile: Cell<unknown>,
    value: FabricValue,
  ): Promise<void> {
    const cell = {
      ...profile.resolveAsCell().key("name").resolveAsCell()
        .getAsNormalizedFullLink(),
      path: [],
    };
    const tx = rt.edit();
    seedStoredEnvelope(tx, cell, { ...storedFields(tx, cell), value });
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  }

  // Each case makes a profile that is not the person's, as `#profile` and
  // the retire guard are to take it, and says whether it is in a space of its
  // own, which a runtime can prefer apart from the person's own profiles.
  const notTheirs: [string, () => Promise<Cell<unknown>>, boolean][] = [
    ["whose name is a stranger's", () => strangersProfile("Mallory"), true],
    [
      "that is a document carrying no label",
      () => rawDocument(() => ({ name: "Mallory" })),
      true,
    ],
    [
      "whose name links to itself",
      () =>
        rawDocument((document) => ({
          name: document.key("name").getAsLink(),
        })),
      true,
    ],
    [
      "whose name and another of its fields link to each other",
      () =>
        rawDocument((document) => ({
          name: document.key("alias").getAsLink(),
          alias: document.key("name").getAsLink(),
        })),
      true,
    ],
    [
      "whose document links to itself",
      () => rawDocument((document) => document.getAsLink()),
      true,
    ],
  ];

  for (const [which, make, ownSpace] of notTheirs) {
    describe(`a listed profile ${which}`, () => {
      it("is not the answer to `#profile`, though it is listed ahead of the person's own", async () => {
        await listFirst(await make());

        expect(await profileAnswer(rt)).toBe(addressOf(ada));
      });

      if (ownSpace) {
        it("is refused as a runtime's preferred profile", async () => {
          const theirs = await make();
          await listFirst(theirs);
          const { runtime } = open(owner, spaceOf(theirs));

          expect(await profileAnswer(runtime)).toContain(
            "not one of the user's profiles",
          );
        });
      }

      it("does not move the retire guard off the profile `#profile` returns when it is most recently used", async () => {
        await listFirst(await make());

        await send("retireProfile", { profile: ada });
        expect(retired()).toEqual([]);

        await send("retireProfile", { profile: alan });
        expect(retired()).toEqual([spaceOf(alan)]);
      });
    });
  }

  it("fails none of Home's computations for a listed document that links to itself", async () => {
    const errors: string[] = [];
    rt.scheduler.onError((error) => errors.push(error.message));

    await listFirst(await rawDocument((document) => document.getAsLink()));

    expect(await profileAnswer(rt)).toBe(addressOf(ada));
    expect(errors).toEqual([]);
  });

  it("answers, in a computation on a runtime that has loaded none of a profile's documents, whose own the profile is once they arrive", async () => {
    const { runtime } = open(stranger);
    const program = await systemProgram(
      runtime,
      "profile-home/profile-home.tsx",
    );
    const main = program.main.replace(/profile-home\.tsx$/, "viewer.tsx");
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      main,
      files: [...program.files, {
        name: main,
        contents: `
import { type Cell, computed, pattern, profileOwnerOf } from "commonfabric";

export default pattern<{ friend: Cell<{ name: string }> }>(({ friend }) => ({
  owner: computed(() => profileOwnerOf(friend) ?? ""),
}));`,
      }],
    }, { space: stranger.did(), tx });
    const viewer = runtime.getCell<{ owner: string }>(
      stranger.did(),
      "a viewer of a profile",
      undefined,
      tx,
    );
    const result = runtime.run(tx, pattern, {
      friend: runtime.getCellFromLink(
        ada.resolveAsCell().getAsNormalizedFullLink(),
      ),
    }, viewer);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    await runtime.storageManager.synced();
    await runtime.idle();

    expect(await result.key("owner").pull()).toBe(owner.did());
    runtime.runner.stop(result);
  });

  describe("a profile of the person's whose name is rewritten beneath the runtime's write checks", () => {
    it("is not the answer to `#profile` once its name links into another space", async () => {
      const elsewhere = await rawDocument(() => ({ name: "Ada" }));
      await renameBeneathChecks(ada, elsewhere.key("name").getAsLink());

      expect(await profileAnswer(rt)).toBe(addressOf(alan));
    });

    it("is refused as a runtime's preferred profile once its name links into another space", async () => {
      const elsewhere = await rawDocument(() => ({ name: "Ada" }));
      await renameBeneathChecks(ada, elsewhere.key("name").getAsLink());
      const { runtime } = open(owner, spaceOf(ada));

      expect(await profileAnswer(runtime)).toContain(
        "not one of the user's profiles",
      );
    });

    it("is not the answer to `#profile` once its name links to a document beside it that is not its own", async () => {
      const beside = rt.getCell(spaceOf(ada), "a name beside");
      const tx = rt.edit();
      beside.withTx(tx).setRaw("Ada");
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
      await renameBeneathChecks(ada, beside.getAsLink());

      expect(await profileAnswer(rt)).toBe(addressOf(alan));
    });
  });

  describe("a profile whose own `name` cell links to a bare document beside it", () => {
    // The shape `isLegacyName()` in `profile-owner.ts` accepts, which every
    // profile created by `profile-home.tsx` before #7701 (d5c274f052) stores.
    // TODO(@hixie): remove this case with the exception in `isLegacyName()`,
    // once profiles created before #7701 (d5c274f052) keep working without
    // it.

    it("is its owner's, and the answer to `#profile`", async () => {
      await rewriteNameCell(
        ada,
        asStoredValue((await bareDocument(spaceOf(ada), "Ada")).getAsLink()),
      );

      expect(await ownerOf(ada)).toBe(home);
      expect(await profileAnswer(rt)).toBe(addressOf(ada));
    });
  });

  // Each case puts something in a profile's own `name` cell that is not the
  // shape `isLegacyName()` accepts, returning what the cell is to hold.
  const notLegacy: [string, () => Promise<FabricValue>][] = [
    [
      "links to a bare document in another space",
      async () =>
        asStoredValue(
          (await bareDocument(
            await rt.createSpace({ grants: { "*": "WRITE" } }),
            "Ada",
          )).getAsLink(),
        ),
    ],
    [
      "links to a document beside it that names another document as its owner",
      async () => {
        const other = await bareDocument(spaceOf(ada), "another document");
        const held = rt.getCell<unknown>(spaceOf(ada), crypto.randomUUID());
        const tx = rt.edit();
        seedStoredEnvelope(
          tx,
          { ...held.getAsNormalizedFullLink(), path: [] },
          {
            value: "Ada",
            result: asStoredValue(other.getAsLink()),
          },
        );
        expect((await tx.commit().settled).error).toBeUndefined();
        await rt.idle();
        return asStoredValue(held.getAsLink());
      },
    ],
    [
      "links to a document beside it that carries a label",
      async () => {
        const held = await bareDocument(spaceOf(ada), "Ada");
        const tx = rt.edit();
        seedProfileOwner(tx, held.getAsNormalizedFullLink(), home);
        expect((await tx.commit().settled).error).toBeUndefined();
        await rt.idle();
        return asStoredValue(held.getAsLink());
      },
    ],
    [
      "links to a bare document beside it that holds a record",
      async () =>
        asStoredValue(
          (await bareDocument(spaceOf(ada), { name: "Ada" })).getAsLink(),
        ),
    ],
    [
      "links to a bare document beside it that holds a number",
      async () =>
        asStoredValue((await bareDocument(spaceOf(ada), 7)).getAsLink()),
    ],
    [
      "links into a field of a bare document beside it",
      async () =>
        asStoredValue(
          (await bareDocument(spaceOf(ada), { name: "Ada" })).key("name")
            .getAsLink(),
        ),
    ],
    [
      "links to a bare document beside it that links to another holding the name",
      async () => {
        const name = await bareDocument(spaceOf(ada), "Ada");
        return asStoredValue(
          (await bareDocument(spaceOf(ada), asStoredValue(name.getAsLink())))
            .getAsLink(),
        );
      },
    ],
  ];

  for (const [which, held] of notLegacy) {
    describe(`a profile whose own \`name\` cell ${which}`, () => {
      it("is no one's, and not the answer to `#profile`", async () => {
        await rewriteNameCell(ada, await held());

        expect(await ownerOf(ada)).toBeUndefined();
        expect(await profileAnswer(rt)).toBe(addressOf(alan));
      });
    });
  }

  describe("a profile whose `name` links to a bare document beside it that links to another holding the name", () => {
    it("is no one's, and not the answer to `#profile`", async () => {
      const name = await bareDocument(spaceOf(ada), "Ada");
      const first = await bareDocument(
        spaceOf(ada),
        asStoredValue(name.getAsLink()),
      );
      await renameBeneathChecks(ada, asStoredValue(first.getAsLink()));

      expect(await ownerOf(ada)).toBeUndefined();
      expect(await profileAnswer(rt)).toBe(addressOf(alan));
    });
  });

  it("refuses to retire the profile `#profile` returns when a listed profile whose document is absent is most recently used", async () => {
    const elsewhere = await rt.createSpace({ grants: { "*": "WRITE" } });
    await listFirst(rt.getCell(elsewhere, "no profile is here"));

    expect(await profileAnswer(rt)).toBe(addressOf(ada));
    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([]);

    await send("retireProfile", { profile: alan });
    expect(retired()).toEqual([spaceOf(alan)]);
  });
});
