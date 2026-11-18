import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import type {
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
} from "../../src/contracts/skill.ts";
import { discoverHarnessSkills } from "../../src/skills/registry.ts";
import {
  readSkillResourceTool,
  type ReadSkillResourceToolInput,
} from "../../src/tools/read-skill-resource.ts";
import { readsDespiteMode } from "../support/reads-despite-mode.ts";
import { createToolsSmallContext } from "../support/tools-small-context.ts";

const SKILL_MD = [
  "---",
  "name: pattern-dev",
  "description: Build Common Fabric patterns",
  "---",
  "",
  "# Pattern Dev",
].join("\n");

describe("read-skill-resource", () => {
  let root: string;
  let skillDir: string;
  let registry: HarnessSkillRegistry;
  let reads: HarnessSkillResourceRead[];

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "cf-harness-skill-resource-" });
    skillDir = join(root, "pattern-dev");
    await Deno.mkdir(join(skillDir, "references"), { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), SKILL_MD);
    await Deno.writeTextFile(
      join(skillDir, "references", "guide.md"),
      "# Guide\n",
    );
    await Deno.writeFile(
      join(skillDir, "references", "latin1.txt"),
      new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    );
    registry = await discoverHarnessSkills({
      skillsRoot: root,
      sandboxSkillsRoot: "/workspace/labs/skills",
    });
    reads = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const read = (
    input: ReadSkillResourceToolInput,
    options: { withoutRegistry?: boolean } = {},
  ) =>
    readSkillResourceTool.invoke(
      createToolsSmallContext({
        skillRegistry: options.withoutRegistry ? undefined : registry,
        skillResourceReads: reads,
      }),
      input,
    );

  it("returns the indexed resource's content as text", async () => {
    const output = await read({
      skill: "pattern-dev",
      path: "./references//guide.md",
    });
    expect(output).toMatchObject({
      status: "read",
      path: "references/guide.md",
      kind: "reference",
      contentKind: "text",
      content: "# Guide\n",
    });
  });

  it("returns a resource that is not valid UTF-8 as binary, without content", async () => {
    const output = await read({
      skill: "pattern-dev",
      path: "references/latin1.txt",
    });
    expect(output).toMatchObject({
      status: "binary",
      contentKind: "binary",
      truncated: false,
    });
    expect(output.content).toBeUndefined();
    expect(reads[0]).toMatchObject({
      status: "binary",
      resourcePath: join(skillDir, "references", "latin1.txt"),
    });
  });

  it("returns resource_path_invalid and records the read for a path that is empty, holds a null byte, is absolute, or leaves the skill directory", async () => {
    const cases: Array<[string, string]> = [
      ["  ", "resource path must be non-empty"],
      ["references/a\0b", "resource path must not contain null bytes"],
      ["/etc/passwd", "resource path must be relative to the skill directory"],
      [
        "\\etc\\passwd",
        "resource path must be relative to the skill directory",
      ],
      [
        "references/../..",
        "resource path must stay within the skill directory",
      ],
      [".", "resource path must stay within the skill directory"],
    ];
    for (const [path, message] of cases) {
      const output = await read({ skill: "pattern-dev", path });
      expect(output).toMatchObject({
        status: "error",
        path,
        error: { code: "resource_path_invalid", message },
      });
    }
    expect(reads.map((entry) => entry.error?.code)).toEqual(
      cases.map(() => "resource_path_invalid"),
    );
  });

  it("throws for a maxBytes outside the accepted range", async () => {
    for (const maxBytes of [-1, 1.5, 256_001]) {
      await expect(
        read({ skill: "pattern-dev", path: "SKILL.md", maxBytes }),
      ).rejects.toThrow(
        "read_skill_resource maxBytes must be an integer from 0 to 256000",
      );
    }
  });

  it("returns content cut at maxBytes, marked truncated", async () => {
    const output = await read({
      skill: "pattern-dev",
      path: "references/guide.md",
      maxBytes: 3,
    });
    expect(output).toMatchObject({
      content: "# G",
      maxBytes: 3,
      truncated: true,
    });
  });

  it("returns skill_registry_missing when the run has no skill registry", async () => {
    const output = await read({ skill: "pattern-dev", path: "SKILL.md" }, {
      withoutRegistry: true,
    });
    expect(output.error?.code).toBe("skill_registry_missing");
    expect(reads).toHaveLength(1);
  });

  it("returns skill_not_found for a skill the registry does not hold", async () => {
    const output = await read({ skill: "nope", path: "SKILL.md" });
    expect(output).toMatchObject({
      skill: "nope",
      error: {
        code: "skill_not_found",
        message: "skill not found in registry: nope",
      },
    });
  });

  it("returns resource_not_found when an indexed resource was deleted after the registry was built", async () => {
    await Deno.remove(join(skillDir, "references", "guide.md"));
    const output = await read({
      skill: "pattern-dev",
      path: "references/guide.md",
    });
    expect(output.error?.code).toBe("resource_not_found");
    expect(reads[0]?.status).toBe("error");
  });

  it(
    "returns permission_denied when the process may not read an indexed resource",
    // Root reads a file whatever its mode says, so there is no denial to see.
    { ignore: readsDespiteMode() },
    async () => {
      const guide = join(skillDir, "references", "guide.md");
      await Deno.chmod(guide, 0o000);
      const denied = await read({
        skill: "pattern-dev",
        path: "references/guide.md",
      });
      expect(denied.status).toBe("error");
      expect(denied.error?.code).toBe("permission_denied");
      expect(denied.content).toBeUndefined();
      expect(reads[0]?.error?.code).toBe("permission_denied");

      // The same resource reads once its mode allows it again.
      await Deno.chmod(guide, 0o644);
      const allowed = await read({
        skill: "pattern-dev",
        path: "references/guide.md",
      });
      expect(allowed.status).toBe("read");
      expect(allowed.content).toBe("# Guide\n");
    },
  );

  it("returns resource_not_file when an indexed resource became a directory", async () => {
    await Deno.remove(join(skillDir, "references", "guide.md"));
    await Deno.mkdir(join(skillDir, "references", "guide.md"));
    const output = await read({
      skill: "pattern-dev",
      path: "references/guide.md",
    });
    expect(output.error).toEqual({
      code: "resource_not_file",
      message: "resource is not a file: references/guide.md",
    });
  });
});
