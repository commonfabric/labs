import { expect } from "@std/expect";
import { mintGithubOidcToken } from "../src/github-oidc.ts";
import { describe, it } from "@commonfabric/test-support/test";

const ENV: Record<string, string> = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.test/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-bearer",
};

describe("github-oidc", () => {
  describe("mintGithubOidcToken()", () => {
    it("asks for the audience naming the index host and the DID, with the runtime's bearer, keeping the URL's query", async () => {
      const seen: { url: string; auth: string | null }[] = [];
      const token = await mintGithubOidcToken(
        "https://index.test/api",
        "did:key:z6Mkexample",
        (key) => ENV[key],
        (input, init) => {
          seen.push({
            url: String(input),
            auth: new Headers(init?.headers).get("Authorization"),
          });
          return Promise.resolve(Response.json({ value: "jwt" }));
        },
      );
      expect(token).toBe("jwt");
      const url = new URL(seen[0].url);
      expect(url.searchParams.get("api-version")).toBe("2.0");
      expect(url.searchParams.get("audience")).toBe(
        "pattern-index:index.test:did:key:z6Mkexample",
      );
      expect(seen[0].auth).toBe("Bearer runtime-bearer");
    });

    it("throws naming the missing permission when the runtime offers no token", async () => {
      await expect(
        mintGithubOidcToken("https://index.test", "did:key:z", () => undefined),
      ).rejects.toThrow("id-token: write");
    });

    it("throws when GitHub refuses the request", async () => {
      await expect(
        mintGithubOidcToken(
          "https://index.test",
          "did:key:z",
          (key) => ENV[key],
          () => Promise.resolve(new Response("no", { status: 403 })),
        ),
      ).rejects.toThrow("HTTP 403");
    });

    it("throws when the answer carries no token", async () => {
      await expect(
        mintGithubOidcToken(
          "https://index.test",
          "did:key:z",
          (key) => ENV[key],
          () => Promise.resolve(Response.json({ value: "" })),
        ),
      ).rejects.toThrow("no token");
    });
  });
});
