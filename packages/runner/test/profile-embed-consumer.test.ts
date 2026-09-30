/** Profile embeds read foreign values and dispatch through the owner's streams. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { type Cell, isStream } from "../src/cell.ts";
import type { JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const files = ["profile-home.tsx", "profile-embed.tsx"].map((name) => ({
  name: `/${name}`,
  contents: Deno.readTextFileSync(
    new URL(`../../patterns/system/${name}`, import.meta.url),
  ),
}));
const signer = await Identity.fromPassphrase("profile-embed-consumer");
const homeSpace = signer.did();
const profileSpace =
  (await Identity.fromPassphrase("profile-embed-consumer-profile")).did();

describe("profile embed consumer", () => {
  for (const vintage of [false, true]) {
    it(`reads a ${vintage ? "vintage-shaped" : "current"} foreign profile and preserves its write authority`, async () => {
      const manager = StorageManager.emulate({ as: signer });
      const errors: unknown[] = [];
      const errorObserved = Promise.withResolvers<void>();
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: manager,
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
        cfcWriteFloor: "enforce",
        errorHandlers: [(error) => {
          errors.push(error);
          errorObserved.resolve();
        }],
      });
      try {
        const profilePattern = await runtime.patternManager.compilePattern({
          main: "/profile-home.tsx",
          files,
        });
        const create = runtime.edit();
        const profile = runtime.run(create, profilePattern, {
          initialName: "Ada Lovelace",
        }, runtime.getCell(profileSpace, "profile", undefined, create));
        runtime.prepareTxForCommit(create);
        expect((await create.commit()).error).toBeUndefined();
        expect(await profile.key("name").pull()).toBe("");
        const initializeName = runtime.edit();
        profile.withTx(initializeName).key("setName").send({
          name: "Ada Lovelace",
        });
        runtime.prepareTxForCommit(initializeName);
        expect((await initializeName.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(await profile.key("name").pull()).toBe("Ada Lovelace");

        let selected = profile.withTx();
        if (vintage) {
          const project = runtime.edit();
          selected = runtime.getCell(
            profileSpace,
            "vintage-profile",
            undefined,
            project,
          );
          // The original field and stream capabilities remain authoritative;
          // the older surface has neither bio nor its later mutation stream.
          selected.set({
            name: profile.withTx(project).key("name"),
            avatar: profile.withTx(project).key("avatar"),
            setName: profile.withTx(project).key("setName"),
            setAvatar: profile.withTx(project).key("setAvatar"),
          });
          runtime.prepareTxForCommit(project);
          expect((await project.commit()).error).toBeUndefined();
          selected = selected.withTx();
        }
        const setup = runtime.edit();
        const home = runtime.getCell(homeSpace, "home", undefined, setup);
        home.set({
          profiles: [selected.withTx(setup)],
          defaultProfile: selected.withTx(setup),
          mru: [],
        });
        runtime.getSpaceCell(homeSpace).withTx(setup).key("defaultPattern").set(
          home,
        );
        runtime.prepareTxForCommit(setup);
        expect((await setup.commit()).error).toBeUndefined();

        const embedPattern = await runtime.patternManager.compilePattern({
          main: "/profile-embed.tsx",
          files,
        });
        const wish = embedPattern.nodes.find((node) =>
          node.module.type === "ref" && node.module.implementation === "wish"
        );
        expect(wish).toBeDefined();
        const wishSchema = wish!.module.resultSchema as JSONSchemaObj;
        const resultSchema = (wishSchema.properties?.result as JSONSchemaObj)
          .anyOf?.find((candidate) =>
            typeof candidate === "object" && candidate.type === "object"
          ) as JSONSchemaObj;
        expect(resultSchema).toBeDefined();
        const { asCell: _asCell, ...unboxed } = resultSchema;
        const schema = { ...unboxed, $defs: wishSchema.$defs };
        expect(schema.properties?.name).toEqual({ type: "string" });
        expect(schema.properties?.avatar).toEqual({ type: "string" });
        expect(schema.properties?.bio).toEqual({ type: "string", default: "" });
        expect(schema.required).toContain("setName");
        expect(schema.required).toContain("setAvatar");
        expect(schema.required).not.toContain("setBio");
        for (const stream of ["setName", "setAvatar", "setBio"]) {
          expect(schema.properties?.[stream]).toMatchObject({
            asCell: ["stream"],
          });
        }

        const start = runtime.edit();
        const embed = runtime.run(
          start,
          embedPattern,
          {},
          runtime.getCell(homeSpace, "embed", undefined, start),
        );
        runtime.prepareTxForCommit(start);
        expect((await start.commit()).error).toBeUndefined();
        await Promise.race([
          embed.key("hasProfile").pull(),
          errorObserved.promise,
        ]);
        expect(errors).toEqual([]);
        expect(embed.key("hasProfile").get()).toBe(true);
        expect(await embed.key("$NAME").pull()).toBe("Ada Lovelace");

        const consumer = selected.withTx().asSchema(schema);
        if (vintage) {
          expect(consumer.key("bio").get()).toBe("");
          expect(selected.key("setBio").getRawUntyped()).toBeUndefined();
          const setBio = (consumer.get() as Record<string, unknown>)
            .setBio as Cell<unknown>;
          expect(isStream(setBio)).toBe(true);
          expect(setBio.getAsNormalizedFullLink().id).toBe(
            selected.getAsNormalizedFullLink().id,
          );
          expect(setBio.getAsNormalizedFullLink().path).toEqual(["setBio"]);
        }
        const unauthorized = runtime.edit();
        // Editing the resolved producer cell must still honor its stored policy.
        consumer.withTx(unauthorized).key("name").resolveAsCell().set(
          "Untrusted edit",
        );
        runtime.prepareTxForCommit(unauthorized);
        expect((await unauthorized.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        expect(await profile.key("name").pull()).toBe("Ada Lovelace");

        const amend = runtime.edit();
        consumer.withTx(amend).key("setName").send({ name: "Grace Hopper" });
        runtime.prepareTxForCommit(amend);
        expect((await amend.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(await profile.key("name").pull()).toBe("Grace Hopper");
        expect(await embed.key("$NAME").pull()).toBe("Grace Hopper");
        expect(errors).toEqual([]);
        await runtime.patternManager.flushCompileCacheWrites();
        await manager.synced();
      } finally {
        await runtime.dispose();
        await manager.close();
      }
    });
  }
});
