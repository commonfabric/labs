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

/** A profile granting fabric tools, a pattern index and subagents. */
const CARRY = {
  tools: [
    "run_pattern",
    "assign_slug",
    "resolve_piece",
    "search_patterns",
    "record_feedback",
    "research",
    "delegate_task",
  ],
  maxModelTurns: 24,
  taskRole: "direct-command",
  retry: "never",
  fabric: {
    host: "https://toolshed.example",
    space: "did:key:z6MkgUiiZvP3qYQqr1NWyS2uCpny8dejAvyuBZh2PAVACs97",
    identityKeyPath: "/instance/identity.key",
  },
  patternIndexUrl: "https://us-central1-pattern-index.cloudfunctions.net",
  patternIndexPublish: false,
  subagentProfiles: ["default", "pattern-author"],
};

/** CARRY without the fields named. */
const carryWithout = (...keys: string[]) =>
  Object.fromEntries(
    Object.entries(CARRY).filter(([key]) => !keys.includes(key)),
  );

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

    it("retains host model bounds and refuses widening them", async () => {
      const profile = (await read({
        ask: { ...ASK, maxInputBytes: 65536, maxOutputTokens: 8192 },
      })).get("ask")!;
      expect(profile).toMatchObject({
        maxInputBytes: 65536,
        maxOutputTokens: 8192,
      });
      expect(narrowLocalJobProfile(profile, { maxInputBytes: 65537 }))
        .toHaveProperty("refusal");
      expect(narrowLocalJobProfile(profile, { maxOutputTokens: 8193 }))
        .toHaveProperty("refusal");
      expect(
        narrowLocalJobProfile(profile, {
          maxInputBytes: 4096,
          maxOutputTokens: 1024,
        }),
      ).toMatchObject({
        profile: { maxInputBytes: 4096, maxOutputTokens: 1024 },
      });
      for (const bad of [0, -1, 1.5, "8192", Number.MAX_SAFE_INTEGER + 1]) {
        await expect(read({ ask: { ...ASK, maxOutputTokens: bad } })).rejects
          .toThrow("maxOutputTokens");
        await expect(read({ ask: { ...ASK, maxInputBytes: bad } })).rejects
          .toThrow("maxInputBytes");
      }
    });

    it("reads a browser host grant, and leaves a withheld one out", async () => {
      const profiles = await read({
        ask: { ...ASK, browserHost: true },
        read: { ...ASK, browserHost: false },
      });
      expect(profiles.get("ask")?.browserHost).toBe(true);
      expect(profiles.get("read")).toEqual(ASK);
    });

    it("reads a fabric session, a pattern index and subagent profiles", async () => {
      expect((await read({ carry: CARRY })).get("carry")).toEqual(CARRY);
    });

    it("publishes to the pattern index unless the file says not to", async () => {
      expect(
        (await read({ carry: carryWithout("patternIndexPublish") })).get(
          "carry",
        ),
      ).toEqual({ ...CARRY, patternIndexPublish: true });
    });

    it("reads a fabric session with no pattern index or subagents", async () => {
      const profile = {
        ...carryWithout(
          "patternIndexUrl",
          "patternIndexPublish",
          "subagentProfiles",
        ),
        tools: ["run_pattern", "resolve_piece"],
      };
      expect((await read({ carry: profile })).get("carry")).toEqual(profile);
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
        "a reasoning effort it does not know",
        { ...ASK, reasoningEffort: "extreme" },
        "`reasoningEffort`",
      ],
      [
        "a browser host grant that is not true or false",
        { ...ASK, browserHost: "yes" },
        "`browserHost`",
      ],
      ["a fabric that is not an object", { ...CARRY, fabric: "x" }, "`fabric`"],
      [
        "a fabric host that is not a URL",
        { ...CARRY, fabric: { ...CARRY.fabric, host: "toolshed" } },
        "`fabric.host`",
      ],
      [
        "a fabric host that is not a string",
        { ...CARRY, fabric: { ...CARRY.fabric, host: 7 } },
        "`fabric.host`",
      ],
      [
        "a fabric with no space",
        { ...CARRY, fabric: { ...CARRY.fabric, space: undefined } },
        "`fabric.space`",
      ],
      [
        "a relative identity key",
        { ...CARRY, fabric: { ...CARRY.fabric, identityKeyPath: "id.key" } },
        "`fabric.identityKeyPath`",
      ],
      [
        "a pattern index that is not a URL",
        { ...CARRY, patternIndexUrl: "index" },
        "`patternIndexUrl`",
      ],
      [
        "a publish flag that is not true or false",
        { ...CARRY, patternIndexPublish: "no" },
        "`patternIndexPublish`",
      ],
      [
        "a publish flag with no pattern index",
        {
          ...carryWithout("patternIndexUrl", "subagentProfiles"),
          tools: ["run_pattern"],
        },
        "`patternIndexPublish` needs `patternIndexUrl`",
      ],
      [
        "a pattern index with no fabric",
        { ...carryWithout("fabric", "subagentProfiles"), tools: [] },
        "`patternIndexUrl` needs `fabric`",
      ],
      ...["run_pattern", "assign_slug", "resolve_piece", "acquire_skill"].map(
        (tool) =>
          [
            `\`${tool}\` with no fabric`,
            { ...ASK, tools: [tool] },
            `\`tools\` names \`${tool}\`, which needs \`fabric\``,
          ] as [string, unknown, string],
      ),
      ...["search_patterns", "record_feedback"].map(
        (tool) =>
          [
            `\`${tool}\` with no pattern index`,
            {
              ...carryWithout(
                "patternIndexUrl",
                "patternIndexPublish",
                "subagentProfiles",
              ),
              tools: [tool],
            },
            `\`tools\` names \`${tool}\`, which needs \`patternIndexUrl\``,
          ] as [string, unknown, string],
      ),
      [
        "subagent profiles that are not a list",
        { ...CARRY, subagentProfiles: "default" },
        "`subagentProfiles`",
      ],
      [
        "an unknown subagent profile",
        { ...CARRY, subagentProfiles: ["author"] },
        "`subagentProfiles`",
      ],
      [
        "the browser subagent profile",
        { ...CARRY, subagentProfiles: ["browser"] },
        "`subagentProfiles` may not name `browser`",
      ],
      [
        "subagent profiles with no delegate tool",
        {
          ...CARRY,
          tools: CARRY.tools.filter((tool) => tool !== "delegate_task"),
        },
        "`subagentProfiles` needs `delegate_task`",
      ],
      ...[["fabric"], ["patternIndexUrl", "patternIndexPublish"]].map(
        (missing) =>
          [
            `\`pattern-author\` with no ${missing[0]}`,
            {
              ...carryWithout(...missing),
              tools: ["delegate_task"],
              ...(missing[0] === "fabric"
                ? { patternIndexUrl: undefined, patternIndexPublish: undefined }
                : {}),
            },
            "`subagentProfiles` names `pattern-author`, which needs `fabric` and `patternIndexUrl`",
          ] as [string, unknown, string],
      ),
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

    it("grants no subagent profile to a request narrowed away from the delegate tool", async () => {
      const carry = (await read({ carry: CARRY })).get("carry")!;
      const narrowed = narrowLocalJobProfile(carry, { tools: ["run_pattern"] });
      expect(narrowed).toEqual({
        profile: {
          ...carryWithout("subagentProfiles"),
          tools: ["run_pattern"],
        },
      });
      expect(narrowLocalJobProfile(carry, { tools: ["delegate_task"] }))
        .toEqual({ profile: { ...carry, tools: ["delegate_task"] } });
    });

    describe("with inputs", () => {
      /** A piece in the CARRY profile's own space, addressed relative to it. */
      const PIECE = `/of:fid1:${"A".repeat(43)}`;

      /** The same piece's id in a space the profile does not open. */
      const ELSEWHERE =
        `//did:key:z6MkfffOtherSpaceZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/of:fid1:${
          "A".repeat(43)
        }`;

      it("returns the profile unchanged for inputs naming pieces in its fabric space", async () => {
        const carry = (await read({ carry: CARRY })).get("carry")!;

        expect(
          narrowLocalJobProfile(carry, {
            inputs: {
              focus: PIECE,
              same: `//${CARRY.fabric.space}/of:fid1:${"B".repeat(43)}`,
            },
          }),
        ).toEqual({ profile: carry });
      });

      it("refuses inputs under a profile with no fabric session", () => {
        expect(narrowLocalJobProfile(profile, { inputs: { focus: PIECE } }))
          .toEqual({
            refusal:
              "The profile has no fabric session, so it can hold no inputs.",
          });
      });

      /** The space of {@link ELSEWHERE}, and the host the request names. */
      const OTHER = ELSEWHERE.slice(2, ELSEWHERE.indexOf("/of:"));
      const OTHER_HOST = "https://estuary.example";

      it("admits an input in another space whose host the request names, whichever way the profile names its own", async () => {
        // The host hands a job the piece it should act on, wherever that
        // piece lives, and says where its space is served.
        const named = (await read({
          carry: { ...CARRY, fabric: { ...CARRY.fabric, space: "my-space" } },
        })).get("carry")!;
        const byDid = (await read({ carry: CARRY })).get("carry")!;
        const narrowing = {
          inputs: { focus: ELSEWHERE },
          foreignSpaces: { [OTHER]: OTHER_HOST },
        };

        expect(narrowLocalJobProfile(byDid, narrowing)).toEqual({
          profile: byDid,
        });
        expect(narrowLocalJobProfile(named, narrowing)).toEqual({
          profile: named,
        });
      });

      it("refuses an input in another space whose host the request does not name", async () => {
        // The profile's own host is not assumed to serve another space: a
        // space it does not serve reads as empty, which no refusal reports.
        const carry = (await read({ carry: CARRY })).get("carry")!;

        const narrowed = narrowLocalJobProfile(carry, {
          inputs: { focus: ELSEWHERE },
        });

        const refusal = (narrowed as { refusal: string }).refusal;
        expect(refusal).toContain("`focus`");
        expect(refusal).toContain("foreignSpaces");
      });

      it("refuses a foreign space no input names", async () => {
        const carry = (await read({ carry: CARRY })).get("carry")!;

        const narrowed = narrowLocalJobProfile(carry, {
          inputs: { focus: PIECE },
          foreignSpaces: { [OTHER]: OTHER_HOST },
        });

        expect((narrowed as { refusal: string }).refusal).toContain(
          "no input names",
        );
      });

      it("refuses a foreign space whose host is not an http(s) origin", async () => {
        const carry = (await read({ carry: CARRY })).get("carry")!;

        const narrowed = narrowLocalJobProfile(carry, {
          inputs: { focus: ELSEWHERE },
          foreignSpaces: { [OTHER]: "ftp://estuary.example" },
        });

        expect(narrowed).toEqual({ refusal: expect.any(String) });
      });

      it("refuses a malformed piece address rather than throwing", async () => {
        const carry = (await read({ carry: CARRY })).get("carry")!;

        const narrowed = narrowLocalJobProfile(carry, {
          inputs: { focus: "pattern:other-space/tracker/extra" },
        });

        expect((narrowed as { refusal: string }).refusal).toContain(
          "`focus`",
        );
      });

      it("refuses a piece address naming a space other than the profile's, naming the input", async () => {
        // A slug resolves only in the session's own space, so one qualified
        // by another space cannot be reached.
        const named = (await read({
          carry: { ...CARRY, fabric: { ...CARRY.fabric, space: "my-space" } },
        })).get("carry")!;
        const byDid = (await read({ carry: CARRY })).get("carry")!;

        for (
          const narrowed of [
            narrowLocalJobProfile(named, {
              inputs: { focus: "pattern:other-space/tracker" },
            }),
            narrowLocalJobProfile(byDid, {
              inputs: { focus: "pattern:other-space/tracker" },
            }),
          ]
        ) {
          expect((narrowed as { refusal: string }).refusal).toContain(
            "`focus`",
          );
        }
        expect(
          narrowLocalJobProfile(named, {
            inputs: { focus: "pattern:my-space/tracker", bare: "tracker" },
          }),
        ).toEqual({ profile: named });
      });

      it("admits a piece address naming the profile's space by its DID, and refuses a name where the profile names its space by DID", async () => {
        // A space created with a random key has only its DID, so that is how
        // an address names it.
        const named = (await read({
          carry: { ...CARRY, fabric: { ...CARRY.fabric, space: "my-space" } },
        })).get("carry")!;
        const byDid = (await read({ carry: CARRY })).get("carry")!;
        const own = `pattern:${CARRY.fabric.space}/tracker`;

        expect(narrowLocalJobProfile(byDid, { inputs: { focus: own } }))
          .toEqual({ profile: byDid });
        // In the request's own terms, rather than the command line's.
        expect(
          narrowLocalJobProfile(byDid, {
            inputs: { focus: "pattern:my-space/tracker" },
          }),
        ).toMatchObject({
          refusal: expect.stringContaining(
            "Input `focus` names its space by name",
          ),
        });
        expect(
          narrowLocalJobProfile(byDid, {
            inputs: {
              focus: "pattern:did:key:z6MkforeignSpaceForProfileTest/tracker",
            },
          }),
        ).toMatchObject({ refusal: expect.stringContaining("`focus`") });
        // Only the session knows the DID a legacy name resolves to, so a
        // profile naming its space by name leaves a DID to the session.
        expect(narrowLocalJobProfile(named, { inputs: { focus: own } }))
          .toEqual({ profile: named });
      });

      it("refuses an input whose name the harness does not admit", async () => {
        const carry = (await read({ carry: CARRY })).get("carry")!;

        const narrowed = narrowLocalJobProfile(carry, {
          inputs: { "-focus": PIECE },
        });

        expect((narrowed as { refusal: string }).refusal).toContain(
          "name must match",
        );
      });
    });

    it("lowers the reasoning effort within the profile's, and refuses more than it", async () => {
      const capped = (await read({ ask: { ...ASK, reasoningEffort: "high" } }))
        .get("ask")!;

      expect(capped.reasoningEffort).toBe("high");
      expect(narrowLocalJobProfile(capped, { reasoningEffort: "low" }))
        .toEqual({ profile: { ...capped, reasoningEffort: "low" } });
      expect(narrowLocalJobProfile(capped, { reasoningEffort: "high" }))
        .toEqual({ profile: capped });
      expect(narrowLocalJobProfile(capped, { reasoningEffort: "xhigh" }))
        .toEqual({
          refusal: "The profile allows at most `high` reasoning effort.",
        });
    });

    it("refuses a reasoning effort under a profile that sets none", () => {
      expect(narrowLocalJobProfile(profile, { reasoningEffort: "low" }))
        .toEqual({
          refusal:
            "The profile sets no reasoning effort, so a request may not name one.",
        });
    });

    it("refuses more turns than the profile's cap", () => {
      expect(narrowLocalJobProfile(profile, { maxModelTurns: 25 })).toEqual({
        refusal: "The profile allows at most 24 model turns.",
      });
    });
  });
});
