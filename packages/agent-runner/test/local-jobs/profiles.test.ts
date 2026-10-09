import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type LocalJobProfile,
  narrowLocalJobProfile,
  readLocalJobProfiles,
} from "../../src/local-jobs/profiles.ts";

/** A profile as a host file states it. */
const ASK = {
  tools: ["loom_search", "list_commands", "run_command"],
  maxModelTurns: 24,
  taskRole: "direct-command",
  retry: "never",
  loomRetrievalConfig: "/instance/agent-runner/loom-retrieval.json",
  loomCommandsConfig: "/instance/agent-runner/loom-commands.json",
  model: "gpt-5.4",
};

/** Helper for tests, which reads `value` as the profile file. */
const read = (value: unknown) =>
  readLocalJobProfiles(
    "/instance/agent-runner/profiles.json",
    () => Promise.resolve(JSON.stringify(value)),
  );

describe("local-jobs/profiles", () => {
  describe("readLocalJobProfiles()", () => {
    it("returns each profile the file names", async () => {
      const profiles = await read({
        ask: ASK,
        read: {
          tools: [],
          maxModelTurns: 4,
          taskRole: "context",
          retry: "never",
        },
      });

      expect(profiles.get("ask")).toEqual(ASK);
      expect(profiles.get("read")).toEqual({
        tools: [],
        maxModelTurns: 4,
        taskRole: "context",
        retry: "never",
      });
    });

    it("reads a browser host grant, and leaves a withheld one out", async () => {
      const profiles = await read({
        ask: { ...ASK, browserHost: true },
        read: { ...ASK, browserHost: false },
      });
      expect(profiles.get("ask")?.browserHost).toBe(true);
      expect(profiles.get("read")).toEqual(ASK);
    });

    it("accepts the CLI research alias", async () => {
      expect(
        (await read({ ask: { ...ASK, tools: ["query_docs"] } })).get("ask")!
          .tools,
      ).toEqual(["query_docs"]);
    });

    it("throws for a relative path before reading anything", async () => {
      await expect(
        readLocalJobProfiles("profiles.json", () => {
          throw new Error("read");
        }),
      ).rejects.toThrow("must be absolute");
    });

    it("throws for a file that is not an object", async () => {
      await expect(read([])).rejects.toThrow("must hold a JSON object");
    });

    const broken: [string, unknown, string][] = [
      ["a profile that is not an object", "ask", "it is not an object"],
      ["tools that are not names", { ...ASK, tools: [1] }, "`tools`"],
      ["an unknown tool", { ...ASK, tools: ["loom_serach"] }, "`tools`"],
      [
        "a tool outside the CLI",
        { ...ASK, tools: ["read_piece_source"] },
        "`tools`",
      ],
      ["a missing tool list", { ...ASK, tools: undefined }, "`tools`"],
      ["a turn cap below one", { ...ASK, maxModelTurns: 0 }, "`maxModelTurns`"],
      [
        "a fractional turn cap",
        { ...ASK, maxModelTurns: 1.5 },
        "`maxModelTurns`",
      ],
      ["an unknown role", { ...ASK, taskRole: "operator" }, "`taskRole`"],
      ["a retry other than never", { ...ASK, retry: "once" }, "`retry`"],
      [
        "a relative retrieval file",
        { ...ASK, loomRetrievalConfig: "retrieval.json" },
        "`loomRetrievalConfig`",
      ],
      [
        "a commands file that is not a string",
        { ...ASK, loomCommandsConfig: 7 },
        "`loomCommandsConfig`",
      ],
      ["a model that is not a string", { ...ASK, model: 7 }, "`model`"],
      [
        "a browser host grant that is not true or false",
        { ...ASK, browserHost: "yes" },
        "`browserHost`",
      ],
    ];
    for (const [what, profile, field] of broken) {
      it(`throws naming the profile and field for ${what}`, async () => {
        await expect(read({ ask: profile })).rejects.toThrow(
          `Local job profile \`ask\`: ${field}`,
        );
      });
    }
  });

  describe("narrowLocalJobProfile()", () => {
    const profile = ASK as LocalJobProfile;

    it("returns the profile itself when the request narrows nothing", () => {
      expect(narrowLocalJobProfile(profile, {})).toEqual({ profile });
    });

    it("narrows to fewer tools and fewer turns", () => {
      expect(
        narrowLocalJobProfile(profile, {
          tools: ["loom_search"],
          maxModelTurns: 6,
        }),
      ).toEqual({
        profile: { ...profile, tools: ["loom_search"], maxModelTurns: 6 },
      });
    });

    it("refuses a tool the profile does not allow", () => {
      expect(
        narrowLocalJobProfile(profile, { tools: ["loom_search", "bash"] }),
      ).toEqual({ refusal: "The profile does not allow `bash`." });
    });

    it("admits a browser host only for a request that declared one", () => {
      const browsing = { ...profile, browserHost: true };
      expect(narrowLocalJobProfile(browsing, {})).toEqual({ profile });
      expect(narrowLocalJobProfile(browsing, { browserHost: {} })).toEqual({
        profile: browsing,
      });
    });

    it("refuses a browser host the profile does not admit", () => {
      expect(narrowLocalJobProfile(profile, { browserHost: {} })).toEqual({
        refusal: "The profile does not admit a browser host.",
      });
    });

    it("refuses more turns than the profile's cap", () => {
      expect(narrowLocalJobProfile(profile, { maxModelTurns: 25 })).toEqual({
        refusal: "The profile allows at most 24 model turns.",
      });
    });
  });
});
