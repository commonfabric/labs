import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("private array append");
const OWNER = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: "owner",
};
const VISITOR = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: "visitor",
};
const OTHER = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: "other",
};

describe("cfc-private-array-append", () => {
  it("appends without disclosing the owner's existing entries or length", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtimes = [OWNER, VISITOR, OTHER].map((reader) =>
      new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcReadMaxConfidentiality: [reader],
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      })
    );
    const [owner, visitor, other] = runtimes;
    try {
      const create = owner.edit();
      const inbox = owner.getCell<string[]>(signer.did(), "inbox", {
        type: "array",
        items: { type: "string" },
        ifc: { confidentiality: [OWNER] },
      }, create);
      inbox.set(["owner's existing recommendation"]);
      expect((await create.commit()).error).toBeUndefined();
      await inbox.sync();
      const link = inbox.getAsNormalizedFullLink();
      const visitorInbox = visitor.getCellFromLink<string[]>(link);
      const otherInbox = other.getCellFromLink<string[]>(link);
      await visitorInbox.sync();
      await otherInbox.sync();
      for (const cell of [visitorInbox, otherInbox]) {
        expect(() => cell.get()).toThrow(/read ceiling/);
        expect(() => cell.key("length").get()).toThrow(/read ceiling/);
        expect(() => cell.key(0).get()).toThrow(/read ceiling/);
      }
      const submit = visitor.edit();
      expect(visitorInbox.withTx(submit).push("visitor's recommendation"))
        .toBeUndefined();
      expect((await submit.commit()).error).toBeUndefined();
      await owner.storageManager.synced();
      expect(owner.getCellFromLink<string[]>(link).get()).toEqual([
        "owner's existing recommendation",
        "visitor's recommendation",
      ]);
      for (const cell of [visitorInbox, otherInbox]) {
        expect(() => cell.get()).toThrow(/read ceiling/);
        expect(() => cell.key(1).get()).toThrow(/read ceiling/);
      }
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await storageManager.close();
    }
  });
  it("keeps a visitor's private input in the append's flow join", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcReadMaxConfidentiality: [VISITOR],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      type Book = { title: string; author: string };
      const bookSchema = {
        type: "object",
        properties: {
          title: { type: "string" },
          author: { type: "string" },
        },
        required: ["title", "author"],
      } as const;
      const create = runtime.edit();
      const inbox = runtime.getCell<Book[]>(
        signer.did(),
        "private-input-inbox",
        {
          type: "array",
          items: bookSchema,
          ifc: { confidentiality: [OWNER] },
        },
        create,
      );
      const history = runtime.getCell<Book[]>(signer.did(), "private-history", {
        type: "array",
        items: bookSchema,
        ifc: { confidentiality: [VISITOR] },
      }, create);
      const draft = runtime.getCell<Book>(signer.did(), "draft", {
        ...bookSchema,
        ifc: { confidentiality: [VISITOR] },
      }, create);
      inbox.set([]);
      history.set([]);
      draft.set({ title: "Solaris", author: "Stanisław Lem" });
      expect((await create.commit()).error).toBeUndefined();
      await inbox.sync();
      await history.sync();
      await draft.sync();
      await runtime.storageManager.synced();
      const submit = runtime.edit();
      const selected = draft.withTx(submit).get();
      history.withTx(submit).push(selected);
      inbox.withTx(submit).push(selected);
      const result = await submit.commit();
      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toMatch(
        /confidentiality|writer.fit/i,
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps value-dependent array operations behind the read ceiling", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcReadMaxConfidentiality: [VISITOR],
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const create = runtime.edit();
      const inbox = runtime.getCell<string[]>(
        signer.did(),
        "deduplicated-inbox",
        {
          type: "array",
          items: { type: "string" },
          ifc: { confidentiality: [OWNER] },
        },
        create,
      );
      inbox.set(["private recommendation"]);
      expect((await create.commit()).error).toBeUndefined();
      await inbox.sync();
      await runtime.storageManager.synced();
      const submit = runtime.edit();
      try {
        expect(() => inbox.withTx(submit).addUnique("private recommendation"))
          .toThrow(/read ceiling/);
        expect(() => inbox.withTx(submit).get()).toThrow(/read ceiling/);
      } finally {
        submit.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("appends a book reference while keeping the owner's membership private", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtimes = [OWNER, VISITOR, OTHER].map((reader) =>
      new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        cfcReadMaxConfidentiality: [reader],
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      })
    );
    const [owner, visitor, other] = runtimes;
    try {
      const create = owner.edit();
      const inbox = owner.getCell<{ title: string; author: string }[]>(
        signer.did(),
        "book-inbox",
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              author: { type: "string" },
            },
            required: ["title", "author"],
          },
          ifc: { confidentiality: [OWNER] },
        },
        create,
      );
      inbox.set([]);
      expect((await create.commit()).error).toBeUndefined();
      await inbox.sync();
      const inboxLink = inbox.getAsNormalizedFullLink();
      const submit = visitor.edit();
      const book = visitor.getCell<{ title: string; author: string }>(
        signer.did(),
        "submitted-book",
        {
          type: "object",
          properties: {
            title: { type: "string" },
            author: { type: "string" },
          },
          required: ["title", "author"],
          ifc: { confidentiality: [{ anyOf: [OWNER, VISITOR] }] },
        },
        submit,
      );
      book.set({ title: "Solaris", author: "Stanisław Lem" });
      visitor.getCellFromLink<{ title: string; author: string }[]>(inboxLink)
        .withTx(submit).push(book);
      expect((await submit.commit()).error).toBeUndefined();
      await book.sync();
      const bookLink = book.getAsNormalizedFullLink();
      expect(owner.getCellFromLink(inboxLink).get()).toEqual([
        { title: "Solaris", author: "Stanisław Lem" },
      ]);
      expect(visitor.getCellFromLink(bookLink).get()).toEqual({
        title: "Solaris",
        author: "Stanisław Lem",
      });
      expect(() => other.getCellFromLink(bookLink).get()).toThrow(
        /read ceiling/,
      );
      expect(() => visitor.getCellFromLink(inboxLink).get()).toThrow(
        /read ceiling/,
      );
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await storageManager.close();
    }
  });
});
