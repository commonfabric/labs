import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  ciSubmissionsPrefix,
  localSubmissionsPrefix,
  parsePersonalKeyFile,
  storeBucket,
  storePrefix,
} from "./test-records-config.ts";

const KEY = {
  client_email: "test-records-gh-octocat@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("test-records-config", () => {
  describe("storeBucket()", () => {
    it("returns the environment override when set", () => {
      expect(storeBucket(() => "other-bucket")).toBe("other-bucket");
    });

    it("returns the infra default otherwise", () => {
      expect(storeBucket(() => undefined)).toBe("cf-ci-metadata");
    });
  });

  describe("storePrefix()", () => {
    it("returns the labs dataset prefix by default", () => {
      expect(storePrefix(() => undefined)).toBe("labs/test-records");
    });
  });

  describe("ciSubmissionsPrefix()", () => {
    it("returns the relay-owned submissions folder", () => {
      expect(ciSubmissionsPrefix(() => undefined)).toBe(
        "labs/test-records/submissions/ci",
      );
    });
  });

  describe("localSubmissionsPrefix()", () => {
    it("returns the person's own submissions folder", () => {
      expect(localSubmissionsPrefix("octocat", () => undefined)).toBe(
        "labs/test-records/submissions/local/octocat",
      );
    });
  });

  describe("parsePersonalKeyFile()", () => {
    it("returns the key with the username field it carries", () => {
      const parsed = parsePersonalKeyFile(
        JSON.stringify({ ...KEY, cf_username: "long-name-with-hash" }),
      );
      expect(parsed?.cf_username).toBe("long-name-with-hash");
    });

    it("returns the username parsed from the account email otherwise", () => {
      expect(parsePersonalKeyFile(JSON.stringify(KEY))?.cf_username).toBe(
        "octocat",
      );
    });

    it("returns undefined for a key with no derivable username", () => {
      const parsed = parsePersonalKeyFile(
        JSON.stringify({ ...KEY, client_email: "other@proj.example" }),
      );
      expect(parsed).toBeUndefined();
    });

    it("returns undefined for malformed JSON", () => {
      expect(parsePersonalKeyFile("{nope")).toBeUndefined();
    });

    it("returns undefined for JSON that is not an object", () => {
      expect(parsePersonalKeyFile('"octocat"')).toBeUndefined();
      expect(parsePersonalKeyFile("null")).toBeUndefined();
    });

    it("returns undefined for any token endpoint but Google's", () => {
      expect(parsePersonalKeyFile(JSON.stringify({
        ...KEY,
        token_uri: "http://oauth2.googleapis.com/token",
      }))).toBeUndefined();
      expect(parsePersonalKeyFile(JSON.stringify({
        ...KEY,
        token_uri: "https://oauth2.example/token",
      }))).toBeUndefined();
    });
  });
});
