/**
 * Resolution of a mutable skills.sh discovery name to the captured default
 * branch head of its GitHub source repository. The valid responses are
 * captured fixtures and refusal cases mutate those captured fields; this file
 * never reaches the network.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";
import type { SkillsShSearchHit } from "../../src/skills-sh/search-client.ts";
import {
  resolveSkillsShHitPin,
  resolveSkillsShSkillIdPin,
  SkillsShPinResolutionError,
} from "../../src/skills-sh/pin.ts";

const HIT: SkillsShSearchHit = {
  id: "vercel-labs/agent-skills/vercel-react-native-skills",
  name: "vercel-react-native-skills",
  source: "vercel-labs/agent-skills",
  installs: 197232,
};

// Captured from the GitHub REST responses for HIT's source on 2026-09-01.
const COMMIT_SHA = "063bee94c3f4df8453406c830b0a7df0f2860278";

const CAPTURED_REPOSITORY_RESPONSE = { default_branch: "main" };
const CAPTURED_BRANCH_RESPONSE = { commit: { sha: COMMIT_SHA } };

const fixtureFetch = (
  responses: Readonly<Record<string, unknown>> = {
    "https://api.github.com/repos/vercel-labs/agent-skills":
      CAPTURED_REPOSITORY_RESPONSE,
    "https://api.github.com/repos/vercel-labs/agent-skills/branches/main":
      CAPTURED_BRANCH_RESPONSE,
  },
): { fetch: HarnessFetch; urls: string[] } => {
  const urls: string[] = [];
  const fetch: HarnessFetch = (input) => {
    const url = String(input);
    urls.push(url);
    const body = responses[url];
    return Promise.resolve(
      body === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(body),
    );
  };
  return { fetch, urls };
};

/** Returns the typed refusal from `call`, and fails if it resolves. */
const refusalOf = async (
  call: Promise<unknown>,
): Promise<SkillsShPinResolutionError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsShPinResolutionError);
    return error as SkillsShPinResolutionError;
  }
  throw new Error("expected pin resolution to refuse, and it resolved");
};

describe("skills.sh pin resolution", () => {
  it("resolves a validated discovery id without consulting registry metadata", async () => {
    const { fetch, urls } = fixtureFetch();

    const pin = await resolveSkillsShSkillIdPin(HIT.id, {
      fetch,
      now: () => "2026-09-01T02:03:04.000Z",
    });

    expect(urls).toEqual([
      "https://api.github.com/repos/vercel-labs/agent-skills",
      "https://api.github.com/repos/vercel-labs/agent-skills/branches/main",
    ]);
    expect(pin).toEqual({
      id: HIT.id,
      owner: "vercel-labs",
      repo: "agent-skills",
      slug: "vercel-react-native-skills",
      commitSha: COMMIT_SHA,
      resolvedAt: "2026-09-01T02:03:04.000Z",
    });
  });

  it("refuses malformed discovery ids before any request", async () => {
    const { fetch, urls } = fixtureFetch();

    for (
      const id of [
        "vercel-labs/agent-skills",
        `${HIT.id}/extra`,
        "owner space/agent-skills/slug",
        "vercel-labs/repo space/slug",
        "vercel-labs/../slug",
        "vercel-labs/agent-skills/slug space",
        "vercel-labs/agent-skills/..",
      ]
    ) {
      const refusal = await refusalOf(
        resolveSkillsShSkillIdPin(id, { fetch }),
      );
      expect(refusal.code).toBe("invalid_hit");
    }
    expect(urls).toEqual([]);
  });

  it("resolves the source repository's default branch head", async () => {
    const { fetch, urls } = fixtureFetch();
    const pin = await resolveSkillsShHitPin(HIT, {
      fetch,
      now: () => "2026-09-01T02:03:04.000Z",
    });

    expect(urls).toEqual([
      "https://api.github.com/repos/vercel-labs/agent-skills",
      "https://api.github.com/repos/vercel-labs/agent-skills/branches/main",
    ]);
    expect(pin).toEqual({
      id: HIT.id,
      owner: "vercel-labs",
      repo: "agent-skills",
      slug: "vercel-react-native-skills",
      commitSha: COMMIT_SHA,
      resolvedAt: "2026-09-01T02:03:04.000Z",
    });
    expect(Object.keys(pin).sort()).toEqual([
      "commitSha",
      "id",
      "owner",
      "repo",
      "resolvedAt",
      "slug",
    ]);
  });

  it("encodes a default branch name before placing it in the API path", async () => {
    const { fetch, urls } = fixtureFetch({
      "https://api.github.com/repos/vercel-labs/agent-skills": {
        default_branch: "release/next",
      },
      "https://api.github.com/repos/vercel-labs/agent-skills/branches/release%2Fnext":
        {
          commit: { sha: COMMIT_SHA },
        },
    });

    await resolveSkillsShHitPin(HIT, { fetch });

    expect(urls[1]).toBe(
      "https://api.github.com/repos/vercel-labs/agent-skills/branches/release%2Fnext",
    );
  });

  it("refuses malformed ids and source disagreements before any request", async () => {
    const { fetch, urls } = fixtureFetch();
    const invalidHits: SkillsShSearchHit[] = [
      { ...HIT, id: "vercel-labs/agent-skills" },
      { ...HIT, id: `${HIT.id}/extra` },
      { ...HIT, id: "owner space/agent-skills/slug" },
      { ...HIT, id: "vercel-labs/repo space/slug" },
      { ...HIT, id: "vercel-labs/../slug", source: "vercel-labs/.." },
      { ...HIT, id: "vercel-labs/agent-skills/slug space" },
      { ...HIT, id: "vercel-labs/agent-skills/.." },
      { ...HIT, id: "attacker/repo/vercel-react-native-skills" },
    ];

    for (const hit of invalidHits) {
      const refusal = await refusalOf(resolveSkillsShHitPin(hit, { fetch }));
      expect(refusal.code).toBe("invalid_hit");
    }
    expect(urls).toEqual([]);
  });

  it("refuses an unusable default branch in repository metadata", async () => {
    for (const defaultBranch of [null, 42, "", "a".repeat(256)]) {
      const { fetch } = fixtureFetch({
        "https://api.github.com/repos/vercel-labs/agent-skills": {
          ...CAPTURED_REPOSITORY_RESPONSE,
          default_branch: defaultBranch,
        },
      });
      const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));
      expect(refusal.code).toBe("unparseable_response");
      expect(refusal.message).toContain("no usable default branch");
    }
  });

  it("refuses branch metadata without a full lowercase commit SHA", async () => {
    for (
      const commit of [
        null,
        { sha: 42 },
        { sha: "0123456" },
        { sha: COMMIT_SHA.toUpperCase() },
      ]
    ) {
      const { fetch } = fixtureFetch({
        "https://api.github.com/repos/vercel-labs/agent-skills":
          CAPTURED_REPOSITORY_RESPONSE,
        "https://api.github.com/repos/vercel-labs/agent-skills/branches/main": {
          ...CAPTURED_BRANCH_RESPONSE,
          commit,
        },
      });
      const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));
      expect(refusal.code).toBe("unparseable_response");
      expect(refusal.message).toContain("no full commit SHA");
    }
  });

  it("refuses a transport failure as request_failed", async () => {
    const fetch: HarnessFetch = () =>
      Promise.reject(new TypeError("connection refused"));
    const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));

    expect(refusal.code).toBe("request_failed");
    expect(refusal.message).toContain("connection refused");
  });

  it("refuses a non-JSON success body", async () => {
    const fetch: HarnessFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(CAPTURED_REPOSITORY_RESPONSE).slice(0, -1)),
      );
    const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("not JSON");
  });

  it("refuses a JSON success body that is not an object", async () => {
    const fetch: HarnessFetch = () =>
      Promise.resolve(Response.json([CAPTURED_REPOSITORY_RESPONSE]));
    const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));

    expect(refusal.code).toBe("unparseable_response");
    expect(refusal.message).toContain("without an object");
  });

  it("refuses a GitHub API error without reading it as a pin", async () => {
    const { fetch } = fixtureFetch({});
    const refusal = await refusalOf(resolveSkillsShHitPin(HIT, { fetch }));

    expect(refusal.code).toBe("http_error");
    expect(refusal.message).toContain("404");
  });
});
