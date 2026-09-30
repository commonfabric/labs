import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import { isCell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { vnodeSchema } from "../src/schemas.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

// The shipped creator materializes profiles in their own spaces. A separate
// session resumes each profile and exercises its authorized mutation stream.
// The precise arm also forwards a nonempty home roster into a shared-space
// picker without asserting the contents of every profile identity.
const signer = await Identity.fromPassphrase("profile-create-real-card-add");
const spaceA = signer.did();

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// The baseline host owns its roster and embeds the shipped creator. Its child
// profile carries the owner-protected fields exercised by the editing session.
const WRAPPER_SRC = [
  "import ProfileCreate from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const created = ProfileCreate({ profiles });",
  "  return { profiles, createProfile: created.createProfile };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const CROSS_SPACE_PROGRAM: RuntimeProgram = {
  ...PROGRAM,
  main: "/profile-create.tsx",
};

const sharedSpace = (await Identity.fromPassphrase(
  "profile-create-real-card-add-shared",
)).did();
const RESULT_CAUSE = "profile-create real card add";

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

const elementsListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

interface TestVNode {
  name: string;
  props: Record<string, unknown>;
  children?: unknown;
}

const collectVNodes = (value: unknown): TestVNode[] => {
  if (Array.isArray(value)) return value.flatMap(collectVNodes);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Partial<TestVNode>;
  return [
    ...(typeof node.name === "string" && node.props ? [node as TestVNode] : []),
    ...collectVNodes(node.children),
  ];
};

const propValue = (value: unknown): unknown =>
  isCell(value) ? value.get() : value;

describe("profile-create real card-add (REAL patterns, cross-space)", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  for (const cfcFlowLabels of ["off", "persist"] as const) {
    it(`creates and edits a cross-space profile with ${cfcFlowLabels} flow labels`, async () => {
      const runtimeErrors: unknown[] = [];
      const rt1 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: managerA,
        cfcFlowLabels,
        errorHandlers: [(error) => runtimeErrors.push(error)],
      });
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: managerB,
        cfcFlowLabels,
        errorHandlers: [(error) => runtimeErrors.push(error)],
      });
      try {
        // Session A: run profile-create's host and create a profile.
        const seedTx = rt1.edit();
        const consumerSpace = cfcFlowLabels === "persist"
          ? sharedSpace
          : spaceA;
        const homeProfiles = rt1.getCell<unknown[]>(
          spaceA,
          "home-profile-roster",
          undefined,
          seedTx,
        );
        homeProfiles.set([]);
        rt1.prepareTxForCommit(seedTx);
        expect((await seedTx.commit()).error).toBeUndefined();
        const tx1 = rt1.edit();
        const parent = await rt1.patternManager.compilePattern(
          cfcFlowLabels === "persist" ? CROSS_SPACE_PROGRAM : PROGRAM,
          {
            space: consumerSpace,
            tx: tx1,
          },
        );
        const resultCell1 = rt1.getCell<Record<string, unknown>>(
          consumerSpace,
          RESULT_CAUSE,
          undefined,
          tx1,
        );
        // deno-lint-ignore no-explicit-any
        const r1 = rt1.run(
          tx1,
          parent as any,
          cfcFlowLabels === "persist"
            ? { profiles: homeProfiles.withTx(tx1) }
            : {},
          resultCell1,
        );
        rt1.prepareTxForCommit(tx1);
        const commit1 = await tx1.commit();
        expect(commit1.error).toBeUndefined();
        await r1.pull();

        const roster = (cfcFlowLabels === "persist"
          ? homeProfiles.withTx(undefined)
          : r1.key("profiles")).asSchema(profileLinkListSchema);
        const names = cfcFlowLabels === "persist"
          ? ["AdaTest", "GraceTest"]
          : ["AdaTest"];
        for (const [index, name] of names.entries()) {
          const tx2 = rt1.edit();
          r1.withTx(tx2).key("createProfile").send({ name });
          rt1.prepareTxForCommit(tx2);
          expect((await tx2.commit()).error).toBeUndefined();
          await waitForCellValue<unknown[]>(
            rt1,
            roster,
            (value) =>
              value?.length === index + 1,
          );
        }
        // deno-lint-ignore no-explicit-any
        const profiles = roster.get() as any[];
        expect(profiles.length).toBe(names.length);
        const profileLink = profiles[0].getAsNormalizedFullLink();
        // Each profile has its own space, separate from the roster and creator.
        expect(profileLink.space).not.toBe(spaceA);
        expect(profileLink.space).not.toBe(consumerSpace);
        if (cfcFlowLabels === "persist") {
          expect(homeProfiles.withTx(undefined).get().length).toBe(2);
        }

        if (cfcFlowLabels === "persist") {
          const preferenceTx = rt1.edit();
          const defaultProfile = rt1.getCell<unknown>(
            spaceA,
            "default-profile",
            undefined,
            preferenceTx,
          );
          defaultProfile.set(profiles[0]);
          const mru = rt1.getCell<unknown[]>(
            spaceA,
            "profile-mru",
            undefined,
            preferenceTx,
          );
          mru.set([profiles[1]]);
          rt1.prepareTxForCommit(preferenceTx);
          expect((await preferenceTx.commit()).error).toBeUndefined();

          const pickerProgram = await resolveLocalProgram(
            (resolver) => rt1.harness.resolve(resolver),
            {
              main: sysDir + "profile-picker.tsx",
              root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
            },
          );
          const pickerTx = rt1.edit();
          const picker = await rt1.patternManager.compilePattern(
            pickerProgram,
            {
              space: consumerSpace,
              tx: pickerTx,
            },
          );
          const pickerResult = rt1.run(
            pickerTx,
            picker,
            {
              profiles: roster.withTx(pickerTx),
              defaultProfile: defaultProfile.withTx(pickerTx),
              mru: mru.withTx(pickerTx),
            },
            rt1.getCell(
              consumerSpace,
              "cross-space-picker",
              undefined,
              pickerTx,
            ),
          );
          rt1.prepareTxForCommit(pickerTx);
          expect((await pickerTx.commit()).error).toBeUndefined();
          await pickerResult.pull();
          const ui = pickerResult.key("$UI").asSchema(vnodeSchema);
          const nodes = collectVNodes(await ui.pull());
          expect(nodes.filter((node) => node.name === "cf-cell-link").length)
            .toBe(2);
          const choices = nodes.filter((node) =>
            node.name === "cf-button" &&
            propValue(node.props["data-ui-action"]) === "SetMruProfile"
          );
          expect(choices.length).toBe(2);
        }

        await rt1.patternManager.flushCompileCacheWrites();
        await rt1.storageManager.synced();
        await rt1.idle();
        await rt1.storageManager.synced();

        // The editing session has separate replicas and loads ProfileHome directly.
        const profileCell = rt2.getCellFromLink(profileLink);
        await profileCell.sync();
        const started = await rt2.start(profileCell);
        expect(started).toBe(true);
        await rt2.idle();

        // Add a catalog card through the profile's authorized mutation stream.
        const writeTx = rt2.edit();
        profileCell.withTx(writeTx).key("addElement").send({
          title: "My Card",
        });
        // A manual test tx prepares the way the runtime's own commit paths do:
        // an enforcing rung refuses a relevant transaction that arrives
        // unprepared.
        rt2.prepareTxForCommit(writeTx);
        const writeCommit = await writeTx.commit();
        expect(writeCommit.error).toBeUndefined();
        await profileCell.pull();
        await rt2.idle();
        await profileCell.pull();

        const elementsCell = profileCell.key("elements").asSchema(
          elementsListSchema,
        );
        await elementsCell.sync();
        await elementsCell.pull();
        // deno-lint-ignore no-explicit-any
        const elements = elementsCell.get() as any[];
        expect(elements.length).toBe(1);

        const name = profileCell.key("name").asSchema({ type: "string" });
        await name.pull();
        expect(name.get()).toBe("AdaTest");
        const nameTx = rt2.edit();
        profileCell.withTx(nameTx).key("setName").send({ name: "Ada edited" });
        rt2.prepareTxForCommit(nameTx);
        expect((await nameTx.commit()).error).toBeUndefined();
        await waitForCellValue<string>(
          rt2,
          name,
          (value) => value === "Ada edited",
        );

        expect(runtimeErrors).toEqual([]);

        // Both replacing a reference and modifying its resolved content require
        // the producer's authorized mutation stream.
        for (const field of ["avatar", "name"]) {
          for (const subject of ["reference", "content"]) {
            const untrusted = rt2.edit();
            const receiver = profileCell.withTx(untrusted).key(field).asSchema({
              type: "string",
            });
            const target = subject === "content"
              ? receiver.resolveAsCell()
              : receiver;
            target.set("Unauthorized replacement");
            rt2.prepareTxForCommit(untrusted);
            const refused = await untrusted.commit();
            expect(refused.error?.message).toContain("writeAuthorizedBy");
          }
        }
        await name.pull();
        expect(name.get()).toBe("Ada edited");
        const editedTarget = name.resolveAsCell().getAsNormalizedFullLink();

        // A fresh runtime reruns initialization against durable state. It keeps
        // the edited target and its value instead of recreating the default.
        await rt2.patternManager.flushCompileCacheWrites();
        await rt2.storageManager.synced();
        await rt2.dispose();
        await rt1.dispose();
        const coldManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const cold = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: coldManager,
          cfcFlowLabels,
          errorHandlers: [(error) => runtimeErrors.push(error)],
        });
        try {
          const resumed = cold.getCellFromLink(profileLink);
          await resumed.sync();
          expect(await cold.start(resumed)).toBe(true);
          await resumed.pull();
          await cold.idle();
          const resumedName = resumed.key("name").asSchema({ type: "string" });
          await resumedName.pull();
          expect(resumedName.get()).toBe("Ada edited");
          const resumedTarget = resumedName.resolveAsCell()
            .getAsNormalizedFullLink();
          expect({
            space: resumedTarget.space,
            id: resumedTarget.id,
            path: resumedTarget.path,
            scope: resumedTarget.scope,
          }).toEqual({
            space: editedTarget.space,
            id: editedTarget.id,
            path: editedTarget.path,
            scope: editedTarget.scope,
          });
          expect(runtimeErrors).toEqual([]);
        } finally {
          await cold.dispose();
          await coldManager.close();
        }
      } finally {
        await rt2.dispose();
        await rt1.dispose();
      }
    });
  }
});
