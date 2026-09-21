/** Reader isolation for the actual invitation across independent runtime realms. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const rootPath = fromFileUrl(new URL("../", import.meta.url));

describe("recommend-a-book privacy", () => {
  it("pins the creator inbox before a visitor opens it and isolates private drafts", async () => {
    const identities = await Promise.all(
      ["owner", "visitor", "third"].map((name) =>
        Identity.fromPassphrase(`book privacy ${name}`)
      ),
    );
    const invitation = await Identity.fromPassphrase("book privacy invitation");
    const harness = await MultiRuntimeHarness.create({
      spaceName: invitation.did(),
      programPath: `${rootPath}integration/fixtures/recommend-a-book/main.tsx`,
      rootPath,
      watchPaths: [["$UI"]],
      sessions: identities.map((identity, index) => ({
        label: ["owner", "visitor", "third"][index],
        identity,
        cfc: {
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
          cfcReadMaxConfidentiality: [
            cfcAtom.user(identity.did()),
            cfcAtom.space(invitation.did()),
          ],
          experimental: { agentBuiltin: true, serverExecution: false },
        },
      })),
    });
    try {
      const [owner, visitor, third] = harness.sessions;
      await owner.client().call("selectProfile", {
        path: ["originatorProfile"],
      });
      await Promise.all(
        harness.sessions.map((session) =>
          session.client().call("seedAgentQueue")
        ),
      );
      await harness.settle();
      expect(await owner.client().call("syncOwnerView")).toBe(true);
      expect(await visitor.client().call("syncOwnerView")).toBe(false);
      expect(await third.client().call("syncOwnerView")).toBe(false);
      const inbox = await owner.link(["received"]);
      await expect(visitor.read(["received"])).rejects.toThrow(/read ceiling/);
      await expect(third.read(["received"])).rejects.toThrow(/read ceiling/);
      expect(await owner.read(["received"])).toEqual([]);
      await visitor.send("review", {
        books: [{ title: "Solaris", author: "Stanisław Lem" }],
      });
      expect(await visitor.read(["selected", "books"])).toEqual([{
        title: "Solaris",
        author: "Stanisław Lem",
      }]);
      expect(await owner.read(["selected", "books"])).toEqual([]);
      expect(await third.read(["selected", "books"]) ?? []).toEqual([]);
      expect(await visitor.link(["received"])).toEqual(inbox);
      const privateDraft = await visitor.link(["selected"]);
      expect(
        JSON.stringify(
          await owner.client().call("readAddress", { link: privateDraft }),
        ),
      )
        .not.toContain("Solaris");
      expect(
        JSON.stringify(
          await third.client().call("readAddress", { link: privateDraft }),
        ),
      )
        .not.toContain("Solaris");
      const expectedBindings = {
        source: privateDraft,
        recipient: await visitor.link(["originator"]),
        result: await visitor.link(["sharedSelection", "value"]),
      };
      const snapshot = await visitor.client().call("shareSnapshot");
      expect(snapshot).toMatchObject({
        value: { books: [{ title: "Solaris", author: "Stanisław Lem" }] },
        audience: cfcAtom.user(owner.identity.did()),
        bindings: expectedBindings,
      });
      await harness.settle();
      expect(await owner.read(["received", 0, "title"])).toBe("Solaris");
      expect(await visitor.read(["recommended", 0, "title"])).toBe("Solaris");
      expect(await owner.link(["received", 0])).toEqual(
        await visitor.link(["recommended", 0]),
      );
      await expect(visitor.read(["received"])).rejects.toThrow(/read ceiling/);
      await expect(third.read(["received"])).rejects.toThrow(/read ceiling/);
      await expect(
        third.client().call("readAddress", {
          link: await owner.link(["received", 0]),
        }),
      ).rejects.toThrow(/read ceiling/);
      expect(await third.read(["recommended"]) ?? []).toEqual([]);
      expect(await visitor.read(["selected", "books"])).toEqual([]);
      expect(await visitor.read(["sharedSelection"])).toEqual({});
      const ownerView = await owner.client().call("viewText");
      expect(ownerView).toContain("Solaris");
      expect(ownerView).toContain("Your recommendations");
      const visitorView = await visitor.client().call("viewText");
      expect(visitorView).toContain("Solaris");
      expect(visitorView).toContain("Books you have recommended");
      expect(visitorView).not.toContain("Your recommendations");
      expect(await third.client().call("viewText")).not.toContain("Solaris");
      const publication = await owner.client().call("publishLibrary", {
        value: {
          books: [{
            title: "The Left Hand of Darkness",
            author: "Ursula K. Le Guin",
          }],
          favoriteAuthors: ["Ursula K. Le Guin"],
        },
      });
      expect(publication).toMatchObject({
        audience: cfcAtom.space(invitation.did()),
      });
      await harness.settle();
      const publishedView = await visitor.client().call("viewText");
      expect(publishedView).not.toContain("The Left Hand of Darkness");
      expect(publishedView).toContain("Show all books");
      expect(await visitor.read(["library", "value", "books", 0, "title"]))
        .toBe("The Left Hand of Darkness");
      expect(publishedView).toContain("Ursula K. Le Guin");
      await visitor.client().call("sendRenderedEvent", {
        tag: "cf-button",
        event: "onClick",
      });
      const expandedView = await visitor.client().call("viewText");
      expect(expandedView).toContain("Hide books");
      expect(expandedView).toContain("The Left Hand of Darkness");
      const queue = await visitor.client().call("agentQueue");
      expect(queue).toEqual({
        principal: visitor.identity.did(),
        entries: [{
          state: "queued",
          inputs: {
            books: await visitor.link(["library", "value", "books"]),
            favoriteAuthors: await visitor.link([
              "library",
              "value",
              "favoriteAuthors",
            ]),
          },
        }],
      });
      expect(await owner.client().call("agentQueue")).toEqual({
        principal: owner.identity.did(),
        entries: [],
      });
    } finally {
      await harness.dispose();
    }
  });
});
