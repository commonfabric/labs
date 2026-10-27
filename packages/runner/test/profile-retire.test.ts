/**
 * Runs the real Home pattern (`packages/patterns/system/home.tsx`) and drives
 * its `retireProfile` and `restoreProfile` streams, and bindings of their
 * handler in other patterns, over profiles its own
 * `createProfile` made, so that the list they write is stored in the shape
 * Home stores it: a document of its own, which Home's result links. The
 * picker runs over Home's own lists where a case drives its controls. The
 * untrusted writes go in under Home's result schema and through the stored
 * document's own address.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  asStoredValue,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  storedList,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { click, elementsLabeled } from "./support/vnode-text.ts";

const signer = await Identity.fromPassphrase("profile retire");
const home = signer.did();

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/** The space `profile` lives in. */
function spaceOf(profile: Cell<unknown>): string {
  return profile.getAsNormalizedFullLink().space;
}

/** The lists and slots the retirement decides by. */
type RetirementRole =
  | "profiles"
  | "mru"
  | "retiredProfiles"
  | "defaultProfile"
  | "legacyDefaultProfileSpace";

// One cache for every runtime this file makes, so that a pattern compiles
// once per file rather than once per case.
const moduleByteCache = createCompileByteCache();

describe("profile-retire", () => {
  let manager: EmulatedStorageManager;
  let rt: Runtime;
  let host: Cell<Record<string, unknown>>;
  let resultSchema: JSONSchema | undefined;
  let ada: Cell<unknown>;
  let alan: Cell<unknown>;
  let grace: Cell<unknown>;

  beforeEach(async () => {
    manager = EmulatedStorageManager.emulate({ as: signer });
    rt = new Runtime({
      moduleByteCache,
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const program = await systemProgram("home.tsx");
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    resultSchema = pattern.resultSchema;
    host = rt.getCell<Record<string, unknown>>(home, "home", undefined, tx);
    const result = rt.run(tx, pattern, {}, host);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await create("Ada");
    await create("Alan");
    await create("Grace");
    [ada, alan, grace] = links("profiles");
  });

  afterEach(async () => {
    rt.runner.stop(host);
    await rt.dispose({ closeStorage: false });
    await manager.close();
  });

  /** The program of the system pattern `name`, resolved from the checkout. */
  function systemProgram(name: string) {
    return resolveLocalProgram(
      (resolver) => rt.harness.resolve(resolver),
      {
        main: new URL(`../../patterns/system/${name}`, import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
  }

  /**
   * Runs the picker over Home's own lists, as Home's Profile tab does, and
   * returns its result and a reading of its view.
   */
  async function pickerOverHome() {
    const program = await systemProgram("profile-picker.tsx");
    const tx = rt.edit();
    const picker = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      home,
      "picker over Home",
      undefined,
      tx,
    );
    const result = rt.run(tx, picker, {
      profiles: host.key("profiles"),
      defaultProfile: host.key("defaultProfile"),
      legacyDefaultProfileSpace: host.key("legacyDefaultProfileSpace"),
      mru: host.key("mru"),
      retiredProfiles: host.key("retiredProfiles"),
    }, cell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    return { result, ui: () => result.key("$UI").get() };
  }

  /** A click on the picker surface's control `action`, as the renderer marks one. */
  function pickerGesture(action: string): unknown {
    const event = {
      type: "click",
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfilePickerSurface",
        action,
      }),
    };
    markRendererTrustedEvent(event);
    return event;
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

  /**
   * A document holding `value`, in a space of its own that anyone can write,
   * which carries no label.
   */
  async function openDocument(value: FabricValue): Promise<Cell<unknown>> {
    const space = await rt.createSpace({ grants: { "*": "WRITE" } });
    const document = rt.getCell(space, "a document that is no one's profile");
    const tx = rt.edit();
    document.withTx(tx).setRawUntyped(value);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
    return document;
  }

  /**
   * A profile-shaped document, in a space of its own, whose stored label is
   * in a form this build cannot interpret.
   */
  async function unreadablyLabeled(): Promise<Cell<unknown>> {
    const space = await rt.createSpace({ grants: { "*": "WRITE" } });
    const document = rt.getCell(space, "a profile whose label cannot be read");
    const tx = rt.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(
      tx,
      { ...document.getAsNormalizedFullLink(), path: [] },
      {
        value: { name: "Unreadable" },
        cfc: {
          version: 3,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [] },
        },
      },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
    return document;
  }

  /**
   * Appends a link to `document` to Home's list `key`, writing the stored
   * list beneath the runtime's write checks, as a list an earlier writer
   * left would hold it.
   */
  async function appendBeneathChecks(
    key: string,
    document: Cell<unknown>,
  ): Promise<void> {
    const list = host.key(key).resolveAsCell();
    await list.sync();
    const stored = { ...list.getAsNormalizedFullLink(), path: [] };
    const tx = rt.edit();
    const fields = storedFields(tx, stored);
    seedStoredEnvelope(tx, stored, {
      ...fields,
      value: [
        ...storedList(fields.value),
        asStoredValue(document.getAsLink()),
      ],
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
    await host.pull();
  }

  /**
   * Runs, in Home's space, so that one handler can write there, a pattern
   * that binds Home's `setProfileRetired`, from its own module, to retire, as
   * another pattern can, and returns its `retire` stream. Each list or slot
   * of `roles` is bound to the Home field it names; with `ownDefault`, the
   * default slot and the earlier default's space are instead cells of the
   * pattern's own, its slot naming `ownDefault`; and a role named in
   * neither is left unbound.
   */
  async function boundTo(
    roles: Partial<Record<RetirementRole, string>>,
    ownDefault?: Cell<unknown>,
  ): Promise<Cell<unknown>> {
    const program = await systemProgram("profile-create.tsx");
    const main = program.main.replace(/profile-create\.tsx$/, "foreign.tsx");
    const bound = [
      ...Object.keys(roles),
      ...(ownDefault === undefined
        ? []
        : ["defaultProfile", "legacyDefaultProfileSpace"]),
    ];
    let tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern({
      ...program,
      main,
      files: [...program.files, {
        name: main,
        contents: `
import { pattern, Writable } from "commonfabric";
import {
  type DefaultProfileSlot,
  type ProfileLink,
  setProfileRetired,
} from "./profile-create.tsx";

export default pattern<{
  profiles: Writable<ProfileLink[]>;
  mru: Writable<ProfileLink[]>;
  retiredProfiles: Writable<ProfileLink[]>;
  defaultProfile?: Writable<DefaultProfileSlot>;
  legacyDefaultProfileSpace?: Writable<string | undefined>;
}>((bound) => {
  const ownDefaultProfile = new Writable<DefaultProfileSlot>({})
    .for("ownDefaultProfile");
  const ownLegacyDefaultProfileSpace = new Writable<string | undefined>(
    undefined,
  ).for("ownLegacyDefaultProfileSpace");
  const { profiles, mru, retiredProfiles } = bound;
  const defaultProfile = ${
          ownDefault === undefined
            ? "bound.defaultProfile"
            : "ownDefaultProfile"
        };
  const legacyDefaultProfileSpace = ${
          ownDefault === undefined
            ? "bound.legacyDefaultProfileSpace"
            : "ownLegacyDefaultProfileSpace"
        };
  return {
    ownDefaultProfile,
    retire: setProfileRetired({
      ${bound.join(", ")},
      retired: true,
    }),
  };
});`,
      }],
    }, { space: home, tx });
    const cell = rt.getCell<{ ownDefaultProfile: { profile?: Cell<unknown> } }>(
      home,
      `a foreign binding of Home's setProfileRetired ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    const args: Record<string, Cell<unknown>> = {};
    for (const [role, field] of Object.entries(roles)) {
      args[role] = host.key(field);
    }
    const result = rt.run(tx, pattern, args, cell);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    if (ownDefault !== undefined) {
      tx = rt.edit();
      cell.withTx(tx).key("ownDefaultProfile").key("profile").set(
        ownDefault.resolveAsCell(),
      );
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
    }
    return result.key("retire");
  }

  /** Sends `{ profile }` on `stream`, and settles. */
  async function retireThrough(
    stream: Cell<unknown>,
    profile: Cell<unknown>,
  ): Promise<void> {
    const tx = rt.edit();
    stream.withTx(tx).send({ profile });
    await tx.commit().settled;
    await rt.idle();
    await host.pull();
  }

  /** Has the picker over Home set Alan as Home's default. */
  async function setAlanDefault(): Promise<void> {
    const { result, ui } = await pickerOverHome();
    try {
      await clickPicker(ui, "Set default", 1, "SetDefaultProfile");
    } finally {
      rt.runner.stop(result);
    }
  }

  /** A click on the picker's control labeled `label`, in row `row`. */
  async function clickPicker(
    ui: () => unknown,
    label: string,
    row: number,
    action: string,
  ): Promise<void> {
    await click(rt, elementsLabeled(ui(), label)[row], pickerGesture(action));
    await host.pull();
  }

  it("retires a profile through Home's retireProfile, and restores it through restoreProfile", async () => {
    await send("retireProfile", { profile: alan });
    expect(retired()).toEqual([spaceOf(alan)]);

    await send("restoreProfile", { profile: alan });
    expect(retired()).toEqual([]);
  });

  it("keeps each profile once, in the order retired, and changes nothing for an event naming no profile", async () => {
    await send("retireProfile", { profile: grace });
    await send("retireProfile", { profile: alan });
    await send("retireProfile", { profile: grace });
    await send("retireProfile", {});
    await send("restoreProfile", {});

    expect(retired()).toEqual([spaceOf(grace), spaceOf(alan)]);
  });

  it("restores nothing for a profile that is not retired", async () => {
    await send("retireProfile", { profile: alan });
    await send("restoreProfile", { profile: grace });

    expect(retired()).toEqual([spaceOf(alan)]);
  });

  describe("a profile Home does not list as the person's own", () => {
    it("is not retired when it is a document carrying no label, in a space anyone can write", async () => {
      await send("retireProfile", {
        profile: await openDocument({ name: "Not a profile" }),
      });

      expect(retired()).toEqual([]);
    });

    it("is not retired when the event holds a value rather than a link", async () => {
      await send("retireProfile", { profile: { name: "Inline" } });

      expect(retired()).toEqual([]);
    });
  });

  describe("a link the retired list came to hold that names none of the person's profiles", () => {
    it("is not listed by the picker, and restoring it removes it", async () => {
      const document = await openDocument({ name: "Not a profile" });
      await appendBeneathChecks("retiredProfiles", document);
      expect(retired()).toEqual([spaceOf(document)]);
      const { result, ui } = await pickerOverHome();
      try {
        expect(elementsLabeled(ui(), "Restore")).toHaveLength(0);
        expect(elementsLabeled(ui(), "Removed profiles")).toHaveLength(0);
      } finally {
        rt.runner.stop(result);
      }

      await send("restoreProfile", { profile: document });

      expect(retired()).toEqual([]);
    });

    it("leaves the picker listing a retired profile of the person's own beside it", async () => {
      await send("retireProfile", { profile: alan });
      await appendBeneathChecks(
        "retiredProfiles",
        await openDocument({ name: "Not a profile" }),
      );
      const { result, ui } = await pickerOverHome();
      try {
        expect(elementsLabeled(ui(), "Restore")).toHaveLength(1);
        expect(elementsLabeled(ui(), "Removed profiles")).toHaveLength(1);
      } finally {
        rt.runner.stop(result);
      }
    });

    it("leaves a retirement working when it links to itself", async () => {
      const errors: string[] = [];
      rt.scheduler.onError((error) => errors.push(error.message));
      const document = await openDocument(undefined);
      const tx = rt.edit();
      document.withTx(tx).setRawUntyped(document.getAsLink());
      expect((await tx.commit().settled).error).toBeUndefined();
      await appendBeneathChecks("retiredProfiles", document);

      await send("retireProfile", { profile: grace });

      expect(retired()).toEqual([spaceOf(document), spaceOf(grace)]);
      expect(errors).toEqual([]);
    });
  });

  describe("a listed profile whose label cannot be read", () => {
    it("fails a retirement rather than retiring anything", async () => {
      const errors: string[] = [];
      rt.scheduler.onError((error) => errors.push(error.message));
      await appendBeneathChecks("profiles", await unreadablyLabeled());

      await send("retireProfile", { profile: grace });

      expect(errors.join("\n")).toContain("not one this build interprets");
      expect(retired()).toEqual([]);
    });

    it("leaves the retirement retiring once it is listed no longer", async () => {
      await send("retireProfile", { profile: grace });

      expect(retired()).toEqual([spaceOf(grace)]);
    });
  });

  it("refuses to retire the first listed profile while no default is set and none was used", async () => {
    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([]);

    await send("retireProfile", { profile: grace });
    expect(retired()).toEqual([spaceOf(grace)]);
  });

  it("refuses to retire the most recently used profile while no default is set, and retires the first listed", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      await clickPicker(ui, "Use", 1, "SetMruProfile");
      expect(links("mru").map(spaceOf)).toEqual([spaceOf(alan)]);

      await send("retireProfile", { profile: alan });
      expect(retired()).toEqual([]);

      await send("retireProfile", { profile: ada });
      expect(retired()).toEqual([spaceOf(ada)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("refuses to retire the profile Home's default names, and retires another", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      await clickPicker(ui, "Set default", 1, "SetDefaultProfile");
      expect(
        spaceOf(host.key("defaultProfile").key("profile").resolveAsCell()),
      ).toBe(spaceOf(alan));

      await send("retireProfile", { profile: alan });
      expect(retired()).toEqual([]);

      await send("retireProfile", { profile: ada });
      expect(retired()).toEqual([spaceOf(ada)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  describe("a binding of the retirement in another pattern", () => {
    const homeRoles: Record<RetirementRole, string> = {
      profiles: "profiles",
      mru: "mru",
      retiredProfiles: "retiredProfiles",
      defaultProfile: "defaultProfile",
      legacyDefaultProfileSpace: "legacyDefaultProfileSpace",
    };

    it("refuses the profile Home's default names, and retires another, when it binds each of Home's lists in its own place", async () => {
      await setAlanDefault();
      const retire = await boundTo(homeRoles);

      await retireThrough(retire, alan);
      expect(retired()).toEqual([]);

      await retireThrough(retire, ada);
      expect(retired()).toEqual([spaceOf(ada)]);
    });

    it("retires nothing when it binds Home's retired list in the place of its profiles", async () => {
      await setAlanDefault();
      const retire = await boundTo({
        ...homeRoles,
        profiles: "retiredProfiles",
      });

      await retireThrough(retire, alan);
      await retireThrough(retire, ada);

      expect(retired()).toEqual([]);
    });

    it("retires nothing when it binds other cells of Home's in the places of its defaults", async () => {
      await setAlanDefault();
      const retire = await boundTo({
        ...homeRoles,
        defaultProfile: "privateInbox",
        legacyDefaultProfileSpace: "mru",
      });

      await retireThrough(retire, alan);
      await retireThrough(retire, ada);

      expect(retired()).toEqual([]);
    });

    it("retires nothing when its defaults are its own", async () => {
      await setAlanDefault();
      const retire = await boundTo({
        profiles: "profiles",
        mru: "mru",
        retiredProfiles: "retiredProfiles",
      }, ada);

      await retireThrough(retire, alan);

      expect(retired()).toEqual([]);
    });

    it("retires nothing when it binds no defaults", async () => {
      await setAlanDefault();
      const retire = await boundTo({
        profiles: "profiles",
        mru: "mru",
        retiredProfiles: "retiredProfiles",
      });

      await retireThrough(retire, alan);

      expect(retired()).toEqual([]);
    });
  });

  it("refuses to retire the last live profile", async () => {
    await send("retireProfile", { profile: alan });
    await send("retireProfile", { profile: grace });
    expect(retired()).toEqual([spaceOf(alan), spaceOf(grace)]);

    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([spaceOf(alan), spaceOf(grace)]);
  });

  it("offers Remove on every row but the one `#profile` returns, and retires a profile through the confirmed Remove", async () => {
    const { result, ui } = await pickerOverHome();
    try {
      expect(elementsLabeled(ui(), "Remove…")).toHaveLength(2);

      await click(rt, elementsLabeled(ui(), "Remove…")[0]);
      await result.pull();
      await click(rt, elementsLabeled(ui(), "Remove profile")[0]);
      await host.pull();

      expect(retired()).toEqual([spaceOf(alan)]);
    } finally {
      rt.runner.stop(result);
    }
  });

  it("refuses an untrusted write to the list, whole or at an element", async () => {
    await send("retireProfile", { profile: grace });
    const viaResult = (tx: IExtendedStorageTransaction) =>
      rt.getCell(home, "home", resultSchema, tx).key("retiredProfiles");

    expect(await untrusted((tx) => viaResult(tx).set([]))).toContain(
      "writeAuthorizedBy",
    );
    expect(
      await untrusted((tx) =>
        host.withTx(tx).key("retiredProfiles").resolveAsCell().set([])
      ),
    ).toContain("writeAuthorizedBy");
    expect(
      await untrusted((tx) => viaResult(tx).key(0).set(alan.resolveAsCell())),
    ).toContain("writeAuthorizedBy");
    expect(
      await untrusted((tx) =>
        viaResult(tx).set([ada, alan].map((each) => each.resolveAsCell()))
      ),
    ).toContain("writeAuthorizedBy");
    expect(retired()).toEqual([spaceOf(grace)]);
  });
});
