import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { loadVersionModule } from "../commands/piece.ts";
import type {
  DeployedSource,
  VersionOutcome,
} from "../lib/pattern-versions.ts";

const DEPLOYED: DeployedSource = {
  entry: "/work/main.tsx",
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
  },
  patternId: () => Promise.resolve("pat-1"),
  piece: { space: "did:key:z6Mkspace", id: "fid1:p" },
};

const RECORDED: VersionOutcome = {
  status: "recorded",
  created: true,
  response: {
    patternId: "pat-1",
    created: true,
    seq: 3,
  },
};

describe("loadVersionModule()", () => {
  it("answers the version module itself when it loads", async () => {
    const versions = await loadVersionModule();

    expect(versions.versionLine(RECORDED)).toBe(
      "Kept as private version 3; cf pattern history lists them.",
    );
    expect(versions.versionJson(RECORDED)).toEqual({
      status: "recorded",
      version: 3,
    });
  });

  describe("when the module fails to load", () => {
    const unloaded = () =>
      loadVersionModule(() => Promise.reject(new Error("module gone")));

    it("records no version, failing with the reason it did not load", async () => {
      const versions = await unloaded();

      expect(await versions.recordVersionInIndex("/unused.key", DEPLOYED))
        .toEqual({ status: "failed", reason: "module gone" });
    });

    it("says a failed version was not kept, and that the deploy succeeded", async () => {
      const versions = await unloaded();
      const failed = await versions.recordVersionInIndex(
        "/unused.key",
        DEPLOYED,
      );

      expect(versions.versionLine(failed)).toBe(
        "Version not kept: module gone. The deploy itself succeeded.",
      );
      expect(versions.versionLine(RECORDED)).toBeUndefined();
    });

    it("reports an outcome's status, and its reason when it has one, as --json does", async () => {
      const versions = await unloaded();

      expect(
        versions.versionJson({ status: "failed", reason: "module gone" }),
      ).toEqual({ status: "failed", reason: "module gone" });
      expect(versions.versionJson({ status: "not-joined", firstTime: true }))
        .toEqual({ status: "not-joined" });
    });
  });
});
