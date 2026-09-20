import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { buildSpaceInviteCommand } from "../commands/space-invites.ts";

describe("space invite", () => {
  it("validates the shell origin before creating an invitation", async () => {
    const signer = await Identity.fromPassphrase("invite CLI test", {
      implementation: "noble",
    });
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, signer.toPkcs8());
    using fetchStub = stub(
      globalThis,
      "fetch",
      (_request) =>
        Promise.resolve(Response.json({
          inviteId: "AAAAAAAAAAAAAAAAAAAAAA",
          code: "A".repeat(43),
        })),
    );
    try {
      await expect(
        buildSpaceInviteCommand().throwErrors().parse([
          "create",
          "--api-url",
          "https://fabric.example",
          "--space",
          signer.did(),
          "--identity",
          keyPath,
          "--access",
          "READ",
          "--ttl",
          "60",
          "--shell",
          "https://shell.example/join",
        ]),
      ).rejects.toMatchObject({ code: "invalid-host" });
      expect(fetchStub.calls).toHaveLength(0);
    } finally {
      await Deno.remove(keyPath);
    }
  });
});
