import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { EnvSchema } from "@/env.ts";
import { loadIdentity } from "@/lib/identity.ts";

describe("identity", () => {
  describe("loadIdentity()", () => {
    const testKey = new URL("../test.key", import.meta.url);

    it("returns the identity of the key at IDENTITY, ahead of a passphrase", async () => {
      using _log = stub(console, "log");
      const bytes = await Deno.readFile(testKey);
      const expected = await Identity.fromPkcs8(bytes);
      const read: string[] = [];

      const identity = await loadIdentity(
        { IDENTITY: "/keys/toolshed.key", IDENTITY_PASSPHRASE: "x", ENV: "" },
        (path) => {
          read.push(path);
          return Promise.resolve(bytes);
        },
      );

      expect(read).toEqual(["/keys/toolshed.key"]);
      expect(identity.did()).toBe(expected.did());
    });

    it("throws naming the path when the key at IDENTITY cannot be read", async () => {
      using _log = stub(console, "log");

      await expect(
        loadIdentity(
          { IDENTITY: "/keys/missing.key", IDENTITY_PASSPHRASE: "", ENV: "" },
          () => Promise.reject(new Deno.errors.NotFound("missing")),
        ),
      ).rejects.toThrow("Could not read key at /keys/missing.key.");
    });

    it("throws naming the path when the file at IDENTITY is not a key", async () => {
      using _log = stub(console, "log");

      await expect(
        loadIdentity(
          { IDENTITY: "/keys/garbage", IDENTITY_PASSPHRASE: "", ENV: "" },
          () => Promise.resolve(new Uint8Array([1, 2, 3])),
        ),
      ).rejects.toThrow("Could not read key at /keys/garbage.");
    });

    it("derives the identity from IDENTITY_PASSPHRASE when no key is named", async () => {
      using warn = stub(console, "warn");

      const identity = await loadIdentity({
        IDENTITY: "",
        IDENTITY_PASSPHRASE: "donut shop",
        ENV: "production",
      });

      expect(identity.did()).toBe(
        (await Identity.fromPassphrase("donut shop")).did(),
      );
      expect(warn.calls.map((call) => call.args[0])).toEqual([
        "Using insecure passphrase identity.",
      ]);
    });

    it("derives the fixed development identity in development with nothing configured", async () => {
      const identity = await loadIdentity({
        IDENTITY: "",
        IDENTITY_PASSPHRASE: "",
        ENV: "development",
      });

      expect(identity.did()).toBe(
        (await Identity.fromPassphrase("implicit trust")).did(),
      );
    });

    it("throws outside development with nothing configured", async () => {
      await expect(
        loadIdentity({ IDENTITY: "", IDENTITY_PASSPHRASE: "", ENV: "test" }),
      ).rejects.toThrow("No IDENTITY set.");
    });

    it("throws for a production environment that sets no identity variable", async () => {
      await expect(loadIdentity(EnvSchema.parse({ ENV: "production" })))
        .rejects.toThrow("No IDENTITY set.");
    });

    it("derives the fixed development identity for a development environment that sets no identity variable", async () => {
      const identity = await loadIdentity(EnvSchema.parse({}));

      expect(identity.did()).toBe(
        (await Identity.fromPassphrase("implicit trust")).did(),
      );
    });
  });
});
