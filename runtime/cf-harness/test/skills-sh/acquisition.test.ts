/**
 * Pinned GitHub acquisition and the instructions-only payload boundary. The
 * repository listings are captured metadata fixtures; no test reaches the
 * network or carries a fetched skill payload.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import {
  acquireSkillsShPinnedSkill,
  cacheHarnessSkillsShAcquisitionClientFactory,
  createHarnessSkillsShAcquisitionClientFactory,
  SKILLS_SH_MAX_SCRIPTS,
  SKILLS_SH_MAX_SKILL_BYTES,
  SkillsShAcquisitionClient,
  SkillsShAcquisitionError,
  skillsShValueDigest,
} from "../../src/skills-sh/acquisition.ts";
import type { SkillsShPinnedAddress } from "../../src/skills-sh/pin.ts";
import buildgreatTree from "./fixtures/buildgreatproducts-plaid-002ea.tree.json" with {
  type: "json",
};
import membraneTree from "./fixtures/membranedev-application-skills-f484c.tree.json" with {
  type: "json",
};

const MEMBRANE_SHA = "f484c8265e70ec910a57342389cca5c5de7d8167";
const MEMBRANE_PIN: SkillsShPinnedAddress = {
  id: "membranedev/application-skills/plaid",
  owner: "membranedev",
  repo: "application-skills",
  slug: "plaid",
  commitSha: MEMBRANE_SHA,
  resolvedAt: "2026-09-01T02:03:04.000Z",
};
const MEMBRANE_TREE_URL =
  `https://api.github.com/repos/membranedev/application-skills/git/trees/${MEMBRANE_SHA}?recursive=1`;
const MEMBRANE_SKILL_URL =
  `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/plaid/SKILL.md`;

const BUILDGREAT_SHA = "002ea93300572480789719717852dbb7e3107057";
const BUILDGREAT_PIN: SkillsShPinnedAddress = {
  id: "buildgreatproducts/plaid/plaid",
  owner: "buildgreatproducts",
  repo: "plaid",
  slug: "plaid",
  commitSha: BUILDGREAT_SHA,
  resolvedAt: "2026-09-01T02:03:04.000Z",
};
const BUILDGREAT_TREE_URL =
  `https://api.github.com/repos/buildgreatproducts/plaid/git/trees/${BUILDGREAT_SHA}?recursive=1`;

const fixtureFetch = (options: {
  tree?: unknown;
  treeUrl?: string;
  skillUrl?: string;
  skillBody?: BodyInit | null;
  skillStatus?: number;
} = {}): { fetch: HarnessFetch; urls: string[] } => {
  const tree = options.tree ?? membraneTree;
  const treeUrl = options.treeUrl ?? MEMBRANE_TREE_URL;
  const skillUrl = options.skillUrl ?? MEMBRANE_SKILL_URL;
  const skillBody = options.skillBody === undefined
    ? "# Plaid\n"
    : options.skillBody;
  const urls: string[] = [];
  const fetch: HarnessFetch = (input) => {
    const url = String(input);
    urls.push(url);
    if (url === treeUrl) return Promise.resolve(Response.json(tree));
    if (url === skillUrl) {
      return Promise.resolve(
        new Response(skillBody, { status: options.skillStatus ?? 200 }),
      );
    }
    return Promise.resolve(
      Response.json({ message: "Not Found" }, { status: 404 }),
    );
  };
  return { fetch, urls };
};

/** Returns the typed refusal from `call`, and fails if it resolves. */
const refusalOf = async (
  call: Promise<unknown>,
): Promise<SkillsShAcquisitionError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsShAcquisitionError);
    return error as SkillsShAcquisitionError;
  }
  throw new Error("expected skill acquisition to refuse, and it resolved");
};

describe("skills.sh pinned acquisition", () => {
  it("loads the single-file membrane skill from its candidate subtree", async () => {
    const { fetch, urls } = fixtureFetch();

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(urls).toEqual([MEMBRANE_TREE_URL, MEMBRANE_SKILL_URL]);
    expect(acquired).toEqual({
      pin: MEMBRANE_PIN,
      skillRoot: "skills/plaid",
      sourceUrl: MEMBRANE_SKILL_URL,
      text: "# Plaid\n",
      valueDigest: "sha256:4Br5o34ECSRnIW_OAU598G_sKD7zw23POdRQ6mexrTk",
      scripts: [],
      loadedPaths: ["SKILL.md"],
    });
    expect(membraneTree._capture.reportedEntryCount).toBe(6_154);
    expect(
      membraneTree.tree.some(({ path }) =>
        path.startsWith("skills/") && !path.startsWith("skills/plaid/")
      ),
    ).toBe(true);
  });

  it("refuses every path of the buildgreat candidate root outside its scripts", async () => {
    const { fetch, urls } = fixtureFetch({
      tree: buildgreatTree,
      treeUrl: BUILDGREAT_TREE_URL,
      skillUrl:
        `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/SKILL.md`,
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(urls).toEqual([BUILDGREAT_TREE_URL]);
    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingPaths).toEqual(
      buildgreatTree.tree
        .map(({ path }) => path)
        .filter((path) =>
          path !== "SKILL.md" && path !== "scripts" &&
          !path.startsWith("scripts/")
        ),
    );
    expect(refusal.offendingCount).toBe(20);
    expect(refusal.message).toContain("refused 20 paths");
    expect(refusal.offendingPaths).toContain("assets/vision-template.json");
    expect(refusal.offendingPaths).toContain("references/plan.md");
    // The script is the payload the widened whitelist admits; the refusal is
    // about everything beside it, and naming it here would put the old rule
    // back under a new name.
    expect(refusal.offendingPaths).not.toContain("scripts/validate-vision.js");
  });

  //
  // The scripts a skill ships
  //
  // A skill is a directory, and the scripts its prose tells a model to run are
  // part of it. They are acquired at the one pinned commit under the same size
  // cap as the instructions, and every path beside them still refuses.
  //

  /**
   * A tree holding `SKILL.md` at the repository root plus `entries`, and a
   * fetch answering every raw URL with the path it names.
   */
  const scriptFixture = (
    entries: readonly { path: string; mode?: string; type?: string }[],
  ): { fetch: HarnessFetch; urls: string[] } => {
    const tree = {
      sha: BUILDGREAT_SHA,
      truncated: false,
      tree: [
        { path: "SKILL.md", mode: "100644", type: "blob" },
        ...entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode ?? "100644",
          type: entry.type ?? "blob",
        })),
      ],
    };
    const urls: string[] = [];
    const fetch: HarnessFetch = (input) => {
      const url = String(input);
      urls.push(url);
      if (url === BUILDGREAT_TREE_URL) {
        return Promise.resolve(Response.json(tree));
      }
      const raw =
        `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/`;
      if (url.startsWith(raw)) {
        return Promise.resolve(new Response(`# ${url.slice(raw.length)}\n`));
      }
      return Promise.resolve(
        Response.json({ message: "Not Found" }, { status: 404 }),
      );
    };
    return { fetch, urls };
  };

  it("acquires the skill's scripts beside its instructions, in path order", async () => {
    const { fetch, urls } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/second.sh", mode: "100755" },
      { path: "scripts/first.py" },
    ]);

    const acquired = await acquireSkillsShPinnedSkill(BUILDGREAT_PIN, {
      fetch,
    });

    expect(acquired.loadedPaths).toEqual([
      "SKILL.md",
      "scripts/first.py",
      "scripts/second.sh",
    ]);
    expect(acquired.scripts.map((script) => script.path)).toEqual([
      "scripts/first.py",
      "scripts/second.sh",
    ]);
    expect(acquired.scripts[0].bytes).toEqual(
      new TextEncoder().encode("# scripts/first.py\n"),
    );
    // Every fetch names the one pinned commit, the instructions first.
    expect(urls).toEqual([
      BUILDGREAT_TREE_URL,
      `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/SKILL.md`,
      `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/scripts/first.py`,
      `https://raw.githubusercontent.com/buildgreatproducts/plaid/${BUILDGREAT_SHA}/scripts/second.sh`,
    ]);
    expect(acquired.scripts[0].valueDigest).toMatch(/^sha256:/);
  });

  it("carries a script's bytes as served, byte-order mark included", async () => {
    // Where the original defect lived, and the only layer that can catch its
    // return: the digest is taken over the bytes GitHub served, so anything
    // that decodes them and re-encodes carries a different file forward under
    // a digest of the one it did not carry. A UTF-8 byte-order mark is what
    // makes that visible — not a character, so a non-fatal decode drops it —
    // and the write and the re-check downstream are both faithful to whatever
    // arrives here.
    const served = new Uint8Array([
      0xEF,
      0xBB,
      0xBF,
      ...new TextEncoder().encode("#!/usr/bin/env bash\necho budgets\n"),
    ]);
    const tree = {
      sha: BUILDGREAT_SHA,
      truncated: false,
      tree: [
        { path: "SKILL.md", mode: "100644", type: "blob" },
        { path: "scripts", mode: "040000", type: "tree" },
        { path: "scripts/report.sh", mode: "100755", type: "blob" },
      ],
    };
    const fetch: HarnessFetch = (input) => {
      const url = String(input);
      if (url === BUILDGREAT_TREE_URL) {
        return Promise.resolve(Response.json(tree));
      }
      if (url.endsWith("/scripts/report.sh")) {
        return Promise.resolve(new Response(served));
      }
      return Promise.resolve(new Response("# SKILL.md\n"));
    };

    const acquired = await acquireSkillsShPinnedSkill(BUILDGREAT_PIN, {
      fetch,
    });

    expect(acquired.scripts[0].bytes).toEqual(served);
    expect(acquired.scripts[0].valueDigest).toBe(skillsShValueDigest(served));
  });

  it("refuses a script nested below the scripts directory", async () => {
    // The admitted shape is one segment under `scripts/`. A deeper path is a
    // directory the whitelist never judged.
    const { fetch } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/inner", mode: "040000", type: "tree" },
      { path: "scripts/inner/deep.sh" },
    ]);

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingPaths).toEqual([
      "scripts/inner",
      "scripts/inner/deep.sh",
    ]);
  });

  it("refuses a script whose filename carries a control codepoint", async () => {
    // An admitted path is reported — it reaches `loadedPaths`, the tool output
    // and the run record, none of which sanitize on the way out — so a name
    // the publisher chose is refused here rather than carried and cleaned
    // later.
    const { fetch, urls } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/re\u001b[2Kport.sh" },
    ]);

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingCount).toBe(1);
    expect(urls).toEqual([BUILDGREAT_TREE_URL]);
  });

  it("refuses a script whose filename opens with a dot", async () => {
    const { fetch } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/.hidden.sh" },
    ]);

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingPaths).toEqual(["scripts/.hidden.sh"]);
  });

  it("refuses a symlink under the scripts directory instead of fetching its target", async () => {
    const { fetch, urls } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/link.sh", mode: "120000" },
    ]);

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(refusal.code).toBe("instructions_only");
    expect(refusal.offendingPaths).toEqual(["scripts/link.sh"]);
    expect(urls).toEqual([BUILDGREAT_TREE_URL]);
  });

  it("refuses a skill shipping more scripts than one acquisition admits", async () => {
    const { fetch, urls } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      ...Array.from(
        { length: SKILLS_SH_MAX_SCRIPTS + 1 },
        (_unused, index) => ({
          path: `scripts/step-${index}.sh`,
        }),
      ),
    ]);

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch }),
    );

    expect(refusal.code).toBe("too_many_scripts");
    expect(refusal.message).toContain(`${SKILLS_SH_MAX_SCRIPTS + 1} scripts`);
    // Refused off the inventory, so no script was fetched.
    expect(urls).toEqual([BUILDGREAT_TREE_URL]);
  });

  it("refuses script bytes that are not UTF-8", async () => {
    const { fetch } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/binary.sh" },
    ]);
    const withBinaryScript: HarnessFetch = (input, init) => {
      const url = String(input);
      return url.endsWith("/scripts/binary.sh")
        ? Promise.resolve(new Response(new Uint8Array([0xff, 0xfe, 0xfd])))
        : fetch(input, init);
    };

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch: withBinaryScript }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("scripts/binary.sh");
  });

  it("refuses a script that exceeds the byte cap while streaming", async () => {
    const { fetch } = scriptFixture([
      { path: "scripts", mode: "040000", type: "tree" },
      { path: "scripts/big.sh" },
    ]);
    const capped: HarnessFetch = (input, init) => {
      const url = String(input);
      return url.endsWith("/scripts/big.sh")
        ? Promise.resolve(
          new Response("x".repeat(SKILLS_SH_MAX_SKILL_BYTES + 1)),
        )
        : fetch(input, init);
    };

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(BUILDGREAT_PIN, { fetch: capped }),
    );

    expect(refusal.code).toBe("skill_too_large");
    expect(refusal.message).toContain("scripts/big.sh");
  });

  it("refuses a truncated recursive tree as an unread listing", async () => {
    const syntheticTruncatedTree = {
      _capture: {
        synthetic: true,
        reason: "GitHub signals recursive-tree truncation with this flag",
      },
      sha: MEMBRANE_SHA,
      truncated: true,
      tree: [{ path: "skills/plaid/SKILL.md", mode: "100644", type: "blob" }],
    };
    const { fetch, urls } = fixtureFetch({ tree: syntheticTruncatedTree });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(urls).toEqual([MEMBRANE_TREE_URL]);
    expect(refusal.code).toBe("tree_truncated");
    expect(refusal.message).toContain("truncated");
  });

  it("refuses a tree response without an explicit truncation status", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        tree: [{ path: "skills/plaid/SKILL.md", mode: "100644", type: "blob" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("truncation status");
  });

  it("refuses a tree response without a complete inventory array", async () => {
    const { fetch } = fixtureFetch({
      tree: { sha: MEMBRANE_SHA, truncated: false },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("tree array");
  });

  it("refuses when the exact slug names no candidate root", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "skills/Plaid/SKILL.md", mode: "100644", type: "blob" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_not_found");
  });

  it("refuses multiple exact candidates even when their parents differ only by case", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/PLAID/plaid/SKILL.md",
          mode: "100644",
          type: "blob",
        }, {
          path: "skills/plaid/plaid/SKILL.md",
          mode: "100644",
          type: "blob",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_ambiguous");
    expect(refusal.candidatePaths).toEqual([
      "skills/PLAID/plaid/SKILL.md",
      "skills/plaid/plaid/SKILL.md",
    ]);
  });

  it("matches path segments by exact bytes without case folding", async () => {
    const exactUrl =
      `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/plaid/SKILL.md`;
    const { fetch } = fixtureFetch({
      skillUrl: exactUrl,
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/plaid/SKILL.md",
          mode: "100644",
          type: "blob",
        }, {
          path: "skills/Plaid/SKILL.md",
          mode: "100644",
          type: "blob",
        }],
      },
    });

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(acquired.skillRoot).toBe("skills/plaid");
    expect(acquired.sourceUrl).toBe(exactUrl);
  });

  it("sanitizes the hostile candidate root before returning metadata", async () => {
    const hostileRoot =
      "skills/\u001b]8;;attacker\u0007click\u001b]8;;\u0007/plaid";
    const skillPath = `${hostileRoot}/SKILL.md`;
    const skillUrl =
      `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/%1B%5D8%3B%3Battacker%07click%1B%5D8%3B%3B%07/plaid/SKILL.md`;
    const { fetch } = fixtureFetch({
      skillUrl,
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: skillPath, mode: "100644", type: "blob" }],
      },
    });

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(acquired.skillRoot).toBe("skills/click/plaid");
    expect(acquired.sourceUrl).toBe(skillUrl);
  });

  it("refuses a malformed entry instead of skipping unknown listing data", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/plaid/SKILL.md",
          mode: "100644",
          type: "blob",
        }, {
          path: 42,
          mode: "100644",
          type: "blob",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("malformed tree entry");
  });

  it("refuses unusable tree paths instead of treating them as absent", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{ path: "", mode: "100644", type: "blob" }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("malformed tree entry");
  });

  it("refuses a candidate whose root SKILL.md is not a regular file", async () => {
    const { fetch } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/plaid/SKILL.md",
          mode: "040000",
          type: "tree",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("SKILL.md is not a regular file");
  });

  it("refuses a symlink candidate instead of fetching its target", async () => {
    const { fetch, urls } = fixtureFetch({
      tree: {
        sha: MEMBRANE_SHA,
        truncated: false,
        tree: [{
          path: "skills/plaid/SKILL.md",
          mode: "120000",
          type: "blob",
        }],
      },
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("regular file");
    expect(urls).toEqual([MEMBRANE_TREE_URL]);
  });

  it("refuses fetched bytes that are not UTF-8", async () => {
    const { fetch } = fixtureFetch({
      skillBody: new Uint8Array([0xff, 0xfe, 0xfd]),
    });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("UTF-8");
  });

  it("refuses an empty fetched SKILL.md", async () => {
    const { fetch } = fixtureFetch({ skillBody: " \n\t" });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("empty");
  });

  it("refuses a response with no SKILL.md body as empty", async () => {
    const { fetch } = fixtureFetch({ skillBody: null });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("invalid_skill_text");
    expect(refusal.message).toContain("empty");
  });

  it("ignores empty stream chunks without changing the fetched bytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode("# Plaid\n"));
        controller.close();
      },
    });
    const { fetch } = fixtureFetch({ skillBody: body });

    const acquired = await acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch });

    expect(acquired.text).toBe("# Plaid\n");
  });

  it("refuses a SKILL.md that exceeds the byte cap while streaming", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SKILLS_SH_MAX_SKILL_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const { fetch } = fixtureFetch({ skillBody: body });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_too_large");
    expect(refusal.message).toContain(String(SKILLS_SH_MAX_SKILL_BYTES));
  });

  it("keeps the size refusal when stream cancellation itself fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SKILLS_SH_MAX_SKILL_BYTES + 1));
      },
      cancel() {
        throw new Error("cleanup failed");
      },
    });
    const { fetch } = fixtureFetch({ skillBody: body });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("skill_too_large");
    expect(refusal.message).not.toContain("cleanup failed");
  });

  it("refuses a raw-content HTTP error", async () => {
    const { fetch } = fixtureFetch({ skillBody: "missing", skillStatus: 404 });

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("http_error");
    expect(refusal.message).toContain("404");
  });

  it("sanitizes a hostile GitHub transport failure", async () => {
    const fetch: HarnessFetch = () =>
      Promise.reject(
        new Error("offline\u001b]8;;attacker\u0007click\u001b]8;;\u0007"),
      );

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("request_failed");
    expect(refusal.message).toBe(
      "GitHub tree could not be reached: offlineclick",
    );
  });

  it("refuses a tree response that is not JSON", async () => {
    const fetch: HarnessFetch = () =>
      Promise.resolve(new Response("{not-json"));

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(MEMBRANE_PIN, { fetch }),
    );

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("not JSON");
  });

  it("refuses a pin without a full lowercase commit SHA before fetching", async () => {
    const { fetch, urls } = fixtureFetch();
    const invalidPin = { ...MEMBRANE_PIN, commitSha: "0123456" };

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill(invalidPin, { fetch }),
    );

    expect(refusal.code).toBe("invalid_pin");
    expect(urls).toEqual([]);
  });

  it("refuses a pin whose discovery id cannot be parsed before fetching", async () => {
    const { fetch, urls } = fixtureFetch();

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill({ ...MEMBRANE_PIN, id: "not-an-id" }, {
        fetch,
      }),
    );

    expect(refusal.code).toBe("invalid_pin");
    expect(urls).toEqual([]);
  });

  it("refuses pin fields that disagree with the validated discovery id", async () => {
    const { fetch, urls } = fixtureFetch();

    const refusal = await refusalOf(
      acquireSkillsShPinnedSkill({ ...MEMBRANE_PIN, owner: "attacker" }, {
        fetch,
      }),
    );

    expect(refusal.code).toBe("invalid_pin");
    expect(urls).toEqual([]);
  });

  it("builds acquisition clients with either injected or default fetch", async () => {
    const injectedFactory = createHarnessSkillsShAcquisitionClientFactory(
      fixtureFetch().fetch,
    );
    const defaultFactory = createHarnessSkillsShAcquisitionClientFactory();

    expect(await injectedFactory()).toBeInstanceOf(SkillsShAcquisitionClient);
    expect(await defaultFactory()).toBeInstanceOf(SkillsShAcquisitionClient);
  });

  it("forgets a rejected client construction so a later call can recover", async () => {
    const client = new SkillsShAcquisitionClient({
      fetch: fixtureFetch().fetch,
    });
    let attempts = 0;
    const factory = cacheHarnessSkillsShAcquisitionClientFactory(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("first construction failed"))
        : Promise.resolve(client);
    });

    await expect(factory()).rejects.toThrow("first construction failed");
    expect(await factory()).toBe(client);
    expect(await factory()).toBe(client);
    expect(attempts).toBe(2);
  });
});
