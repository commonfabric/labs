/**
 * Exercises the hand-run skills.sh probe against captured and refused answers.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { main } from "../scripts/probe-skills-sh.ts";
import { SkillsShSearchClient } from "../src/skills-sh/search-client.ts";

const clientAnswering = (
  response: Response,
): { client: SkillsShSearchClient; urls: string[] } => {
  const urls: string[] = [];
  return {
    client: new SkillsShSearchClient({
      origin: "https://registry.example",
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(response);
      },
    }),
    urls,
  };
};

describe("probe-skills-sh", () => {
  describe("main()", () => {
    it("prints accepted hits, install caveats, and the rejected count", async () => {
      const { client, urls } = clientAnswering(Response.json({
        skills: [
          {
            id: "owner/repo/with-installs",
            name: "with installs",
            source: "owner/repo",
            installs: 7,
          },
          {
            id: "owner/repo/without-installs",
            name: "without installs",
            source: "owner/repo",
          },
          null,
        ],
      }));
      const logs: string[] = [];
      const errors: string[] = [];

      const code = await main(
        ["--owner", "owner", "react", "native"],
        client,
        (line) => logs.push(line),
        (line) => errors.push(line),
      );

      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(urls).toEqual([
        "https://registry.example/api/search?q=react+native&limit=20&owner=owner",
      ]);
      expect(logs).toContain("2 hit(s), 1 refused");
      expect(logs).toContain("    signal:  7 reported installs (unverifiable)");
      expect(logs).toContain("    signal:  installs unknown");
      expect(logs.at(-1)).toContain("1 entry(s) did not match");
    });

    it("returns 2 and prints the usage when owner has no value", async () => {
      const logs: string[] = [];
      const errors: string[] = [];

      const code = await main(
        ["--owner"],
        undefined,
        (line) => logs.push(line),
        (line) => errors.push(line),
      );

      expect(code).toBe(2);
      expect(logs).toEqual([]);
      expect(errors).toEqual([
        "--owner needs a value",
        'usage: deno task probe-skills-sh [--owner <owner>] "<query>"',
      ]);
    });

    it("returns 2 and prints the usage when the query is too short", async () => {
      const errors: string[] = [];

      const code = await main(
        ["x"],
        undefined,
        () => {},
        (line) => errors.push(line),
      );

      expect(code).toBe(2);
      expect(errors).toEqual([
        'usage: deno task probe-skills-sh [--owner <owner>] "<query>"',
      ]);
    });

    it("returns 1 and names a registry refusal", async () => {
      const { client } = clientAnswering(
        Response.json({ error: "busy" }, { status: 503 }),
      );
      const errors: string[] = [];

      const code = await main(
        ["react"],
        client,
        () => {},
        (line) => errors.push(line),
      );

      expect(code).toBe(1);
      expect(errors).toEqual([
        "refused (http_error): skills.sh search answered 503",
      ]);
    });

    it("propagates an unexpected client failure", async () => {
      const client = {
        search: () => Promise.reject(new Error("unexpected failure")),
      };

      await expect(main(["react"], client)).rejects.toThrow(
        "unexpected failure",
      );
    });
  });
});
