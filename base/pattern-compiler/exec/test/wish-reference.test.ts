import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { isLink, Ref, type Store } from "../store.ts";

// `wish` as provisional decision P15 has it, where the answer of the table
// is a reference to a document that exists before the instance, in
// another space: `fixtures/wish-home.tsx`, which has no per-element
// construct.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

const PROFILE = "profile document";
const OTHER_SPACE = "did:key:other";
const link = (path: string[]) => ({ $link: { doc: PROFILE, path } });

/** The outcome of a resolved `wish`, with each member a link. */
const resolved = (path: string[]) => ({
  outcome: { result: link(path), candidates: [link(path)] },
});

const start = async (reads?: [string, readonly string[]][]) =>
  new Instance(await artifactOf("wish-home"), { note: "n" }, {
    space: "did:key:own",
    documents: [{
      id: PROFILE,
      kind: "profile",
      value: { name: "ada", initialNameApplied: "Ada", bio: "first" },
      space: OTHER_SPACE,
    }],
    wishes: ({ query }) =>
      query === "#profile"
        ? resolved([])
        : query === "#profileName"
        ? resolved(["initialNameApplied"])
        : query === "#profileBio"
        ? resolved(["bio"])
        : undefined,
    ...(reads === undefined ? {} : {
      transactions: {
        begin: () => {},
        read: (doc: string, path: readonly string[]) => {
          reads.push([doc, path]);
        },
        change: () => {},
        end: () => {},
      },
    }),
  });

/** What the state document of the operation named `name` holds. */
const stateOf = (instance: Instance, name: string): unknown => {
  const states = [...instance.store.docs.values()].filter(({ kind }) =>
    kind === "operation state"
  ).map(({ value }) =>
    value as { request?: { query?: string }; outcome?: unknown }
  );
  return states.find(({ request }) => request?.query === name)?.outcome;
};

describe("a `wish` whose answer is a reference", () => {
  it("stores each member of the outcome the table gives, a link as a link to the document it names", async () => {
    const instance = await start();

    expect(stateOf(instance, "#profile")).toEqual({
      result: link([]),
      candidates: [link([])],
    });
    expect(stateOf(instance, "#profileName")).toEqual({
      result: link(["initialNameApplied"]),
      candidates: [link(["initialNameApplied"])],
    });
    // The document was given, and the resolution made no other for the
    // target.
    expect(
      [...instance.store.docs.values()].filter(({ kind }) =>
        kind === "wish target"
      ),
    ).toEqual([]);
  });

  it("reads the document through the reference", async () => {
    const reads: [string, readonly string[]][] = [];
    const instance = await start(reads);

    expect(instance.result()).toMatchObject({
      greeting: "hello ada",
      about: "Ada: first",
      profile: { name: "ada", initialNameApplied: "Ada", bio: "first" },
    });
    const stored = instance.store.docs.get(instance.id)?.value as {
      profile: unknown;
    };
    expect(isLink(stored.profile)).toBe(true);
    expect(reads).toContainEqual([PROFILE, ["name"]]);
    expect(reads).toContainEqual([PROFILE, ["bio"]]);
  });

  it("names the space of a document that was given with one in the address of a reference to it", async () => {
    const instance = await start();
    const store: Store = instance.store;

    expect(store.addressOf(new Ref(PROFILE, ["name"]))).toEqual({
      space: OTHER_SPACE,
      document: PROFILE,
      path: ["name"],
    });
    expect(store.addressOf(new Ref(instance.id, ["greeting"]))).toEqual({
      space: "did:key:own",
      document: instance.id,
      path: ["greeting"],
    });
  });

  it("holds an error and no result for operands the table has no answer for", async () => {
    const instance = await start();

    expect(stateOf(instance, "#mentionable")).toEqual({
      error: "no target for `#mentionable`",
    });
    expect((instance.result() as { count?: unknown }).count).toBe(0);
  });

  // `fixtures/instantiate.tsx`: a handler whose body instantiates a
  // pattern.
  it("leaves a given document as it is when a function body makes an instance", async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/instantiate.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const changed: string[] = [];
    const instance = new Instance(
      patterns.find((pattern) => pattern.name === "default")!,
      { note: "n" },
      {
        artifacts: (id) =>
          patterns.find((pattern) => pattern.plan.patterns?.[0] === id),
        documents: [{ id: PROFILE, kind: "profile", value: { name: "ada" } }],
        transactions: {
          begin: () => {},
          read: () => {},
          change: (doc: string) => {
            changed.push(doc);
          },
          end: () => {},
        },
      },
    );
    instance.store.write(new Ref(PROFILE, ["name"]), "grace");
    changed.length = 0;

    // The binding of the handler that instantiates.
    expect(instance.send(1, { title: "a" }).committed).toBe(true);

    expect(instance.store.docs.get(PROFILE)?.value).toEqual({ name: "grace" });
    expect(changed).not.toContain(PROFILE);
  });

  it("evaluates again what read the document when the document changes", async () => {
    const instance = await start();

    instance.store.write(new Ref(PROFILE, ["name"]), "grace");
    instance.settle();

    expect(instance.result()).toMatchObject({ greeting: "hello grace" });
  });
});
