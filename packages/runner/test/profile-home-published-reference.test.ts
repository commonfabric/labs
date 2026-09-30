import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const files = ["profile-home.tsx", "profile-create.tsx"].map((name) => ({
  name: `/${name}`,
  contents: Deno.readTextFileSync(
    new URL(`../../patterns/system/${name}`, import.meta.url),
  ),
}));

// This harness uses Home's exported reference contract while supplying a real
// profile from another space, including its populated identity assertions.
const forwardProgram = {
  main: "/forward.tsx",
  files: [...files, {
    name: "/forward.tsx",
    contents: `
      import { Cell, pattern } from "commonfabric";
      import type { ProfileReferenceValue, TrustedDefaultProfile } from "./profile-create.tsx";
      export default pattern<
        { profile: Cell<ProfileReferenceValue> },
        { defaultProfile: TrustedDefaultProfile }
      >(({ profile }) => ({ defaultProfile: profile as any }));
    `,
  }],
};

const expectStrictPosture = (runtime: Runtime) => {
  expect({
    enforcement: runtime.cfcEnforcementMode,
    flow: runtime.cfcFlowLabels,
    floor: runtime.cfcWriteFloor,
    triggerGating: runtime.cfcTriggerReadGating,
    policyEvaluation: runtime.cfcPolicyEvaluation,
  }).toEqual({
    enforcement: "enforce-strict",
    flow: "persist",
    floor: "enforce",
    triggerGating: true,
    policyEvaluation: "enforce",
  });
};

describe("Home published profile references", () => {
  it("forwards and resumes a populated profile through Home's reference contract", async () => {
    const signer = await Identity.fromPassphrase("home-published-profile");
    const space = signer.did();
    const profileSpace =
      (await Identity.fromPassphrase("published-profile-space")).did();
    const server = newSharedServer();
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const errors: unknown[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      cfcFlowLabels: "persist",
      errorHandlers: [(error) => errors.push(error)],
    });
    try {
      expectStrictPosture(runtime);
      const setup = runtime.edit();
      const profilePattern = await runtime.patternManager.compilePattern({
        main: "/profile-home.tsx",
        files,
      }, {
        space: profileSpace,
        tx: setup,
      });
      const profile = runtime.run(
        setup,
        profilePattern,
        { initialName: "Ada" },
        runtime.getCell(profileSpace, "profile", undefined, setup),
      );
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit()).error).toBeUndefined();
      await profile.pull();

      const seed = runtime.edit();
      const assertion = runtime.getCell(
        profileSpace,
        "verified-github-login",
        undefined,
        seed,
      );
      writeSeedEnvelopeDoc(seed, profileSpace);
      seedStoredEnvelope(seed, {
        ...assertion.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: {
          type: "github.login",
          value: "ada",
          verifiedAt: "2026-07-15T20:00:00.000Z",
        },
        cfc: {
          version: 3,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["loom-verified-external-identity"] },
            }],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const publish = runtime.edit();
      profile.withTx(publish).key("setName").send({ name: "Ada" });
      profile.withTx(publish).key("publishVerifiedIdentities").send({
        identities: [assertion.withTx(publish)],
      });
      runtime.prepareTxForCommit(publish);
      expect((await publish.commit()).error).toBeUndefined();
      await runtime.idle();
      const identities = profile.key("verifiedIdentities").asSchema({
        type: "array",
        items: { asCell: ["cell"] },
      });
      await identities.pull();
      expect(identities.get()).toHaveLength(1);
      expect(identities.get()[0].equalLinks(assertion)).toBe(true);
      expect(errors).toEqual([]);

      const forward = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        forwardProgram,
        { space, tx: forward },
      );
      const result = runtime.run(forward, pattern, {
        profile: profile.withTx(forward),
      }, runtime.getCell(space, "home-reference", undefined, forward));
      runtime.prepareTxForCommit(forward);
      expect((await forward.commit()).error).toBeUndefined();
      await result.pull();
      expect(result.key("defaultProfile").key("name").get()).toBe("Ada");
      const incomingLinks: Array<{
        baseline: string;
        version: 1 | 2 | 3;
        link: ReturnType<typeof result.getAsNormalizedFullLink>;
      }> = [];
      for (
        const baseline of [
          "20260729T022742Z-mKLGw1aighDtz0A6",
          "20260818T220011Z-KnU5UM1qdaNt22eV",
        ]
      ) {
        const contract = JSON.parse(Deno.readTextFileSync(
          new URL(
            `../../patterns/baselines/system/home.tsx/${baseline}.json`,
            import.meta.url,
          ),
        ));
        for (const version of [1, 2, 3] as const) {
          const seed = runtime.edit();
          const incoming = runtime.getCell(
            space,
            `incoming-${baseline}-${version}`,
            undefined,
            seed,
          );
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, {
            ...incoming.getAsNormalizedFullLink(),
            path: [],
          }, {
            value: {
              home: result.asSchema(contract.resultSchema).getAsLink(),
            },
            cfc: {
              version,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: version === 3
                  ? [{
                    path: ["home"],
                    origin: "link",
                    observes: "followRef",
                    referenceAcquisition: "complete",
                    label: { confidentiality: [] },
                  }]
                  : [],
              },
            },
          });
          expect((await seed.commit()).error).toBeUndefined();
          incomingLinks.push({
            baseline,
            version,
            link: incoming.getAsNormalizedFullLink(),
          });
        }
      }
      const resultLink = result.getAsNormalizedFullLink();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      await runtime.dispose();

      const coldManager = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: coldManager,
        cfcFlowLabels: "persist",
        cfcWriteFloor: "enforce",
        errorHandlers: [(error) => errors.push(error)],
      });
      try {
        expectStrictPosture(cold);
        const resumed = cold.getCellFromLink(resultLink);
        await resumed.sync();
        expect(await cold.start(resumed)).toBe(true);
        await resumed.pull();
        await cold.idle();
        const selected = resumed.key("defaultProfile").resolveAsCell();
        expect(selected.getAsNormalizedFullLink().space).toBe(profileSpace);
        expect(await selected.key("name").pull()).toBe("Ada");
        let expectedName = "Ada";
        for (const entry of incomingLinks) {
          const incoming = cold.getCellFromLink(entry.link);
          await incoming.sync();
          const oldProfile = incoming.key("home", "defaultProfile");
          if (entry.version !== 3) {
            expect(() => oldProfile.key("name").get()).toThrow(
              "Reference acquisition lacks complete legacy provenance",
            );
            expect(() => oldProfile.key("setName").send({ name: "refused" }))
              .toThrow(
                "Reference acquisition lacks complete legacy provenance",
              );
          } else {
            expect(oldProfile.key("name").get()).toBe(expectedName);
            expectedName = `Ada ${entry.baseline}`;
            oldProfile.key("setName").send({ name: expectedName });
          }
          await cold.idle();
          expect(await selected.key("name").pull()).toBe(expectedName);
        }
        expect(errors).toEqual([]);
      } finally {
        await cold.dispose();
        await coldManager.close();
      }
    } finally {
      await runtime.dispose();
      await manager.close();
      await server.close();
    }
  });
});
