import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  DEFAULT_GITHUB_COLLECTION_INTERVAL_MS,
  GITHUB_HOST_CONFIG_SCHEMA,
  loadGithubHostConfig,
  parseGithubHostConfig,
} from "../src/config.ts";

describe("config", () => {
  describe("parseGithubHostConfig()", () => {
    it("returns defaults for an otherwise complete configuration", () => {
      expect(parseGithubHostConfig({
        schema: GITHUB_HOST_CONFIG_SCHEMA,
        account: "Hixie",
      }))
        .toEqual({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          collectionIntervalMs: DEFAULT_GITHUB_COLLECTION_INTERVAL_MS,
          graphqlEndpoint: "https://api.github.com/graphql",
        });
    });

    it("rejects an unknown field", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          surprise: true,
        })
      ).toThrow("unknown field: surprise");
    });

    it("rejects a non-HTTPS GraphQL endpoint", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: "http://api.github.test/graphql",
        })
      ).toThrow("must use HTTPS");
    });

    it("rejects line breaks in identity fields", () => {
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie\nother",
        })
      ).toThrow("account must not contain line breaks");
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: "https://api.github.com/\rgraphql",
        })
      ).toThrow("graphqlEndpoint must not contain line breaks");
    });

    it("rejects malformed configuration boundaries", () => {
      for (const value of [null, [], "config"]) {
        expect(() => parseGithubHostConfig(value)).toThrow(
          "configuration must be an object",
        );
      }
      expect(() =>
        parseGithubHostConfig({
          schema: "wrong",
          account: "Hixie",
        })
      ).toThrow("configuration.schema must be");
      for (const account of [undefined, "", "   ", 1]) {
        expect(() =>
          parseGithubHostConfig({
            schema: GITHUB_HOST_CONFIG_SCHEMA,
            account,
          })
        ).toThrow("account must be a non-empty string");
      }
      for (const collectionIntervalMs of [-1, 1.5, 2_147_483_648]) {
        expect(() =>
          parseGithubHostConfig({
            schema: GITHUB_HOST_CONFIG_SCHEMA,
            account: "Hixie",
            collectionIntervalMs,
          })
        ).toThrow("collectionIntervalMs must be an integer");
      }
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: 1,
        })
      ).toThrow("graphqlEndpoint must be a URL");
      expect(() =>
        parseGithubHostConfig({
          schema: GITHUB_HOST_CONFIG_SCHEMA,
          account: "Hixie",
          graphqlEndpoint: "not a URL",
        })
      ).toThrow("graphqlEndpoint must be a URL");
    });

    it("normalizes explicit values", () => {
      expect(parseGithubHostConfig({
        schema: GITHUB_HOST_CONFIG_SCHEMA,
        account: " Hixie ",
        collectionIntervalMs: 0,
        graphqlEndpoint: "https://github.example.test/graphql",
      })).toEqual({
        schema: GITHUB_HOST_CONFIG_SCHEMA,
        account: "Hixie",
        collectionIntervalMs: 0,
        graphqlEndpoint: "https://github.example.test/graphql",
      });
    });
  });

  describe("loadGithubHostConfig()", () => {
    it("loads JSONC and distinguishes read and parse failures", async () => {
      const directory = await Deno.makeTempDir();
      const path = `${directory}/github.jsonc`;
      try {
        await Deno.writeTextFile(
          path,
          `{
            // Account observed by this host.
            "schema": "${GITHUB_HOST_CONFIG_SCHEMA}",
            "account": "Hixie"
          }`,
        );
        expect((await loadGithubHostConfig(path)).account).toBe("Hixie");
        await Deno.writeTextFile(path, "not JSONC");
        await expect(loadGithubHostConfig(path)).rejects.toThrow(
          "configuration file is not valid JSONC",
        );
        await expect(loadGithubHostConfig(`${directory}/missing.jsonc`))
          .rejects.toThrow("could not read configuration file");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  });
});
