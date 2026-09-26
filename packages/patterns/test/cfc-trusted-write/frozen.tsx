// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A record only `freeze` may write. The pattern's other handlers each try to
 * change it another way: a field beneath it, a value of another type over
 * it, a value of another type over a list inside it.
 */
import {
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

type Sealed = { digest: string; tags: string[] };

const freeze = handler<void, { frozen: Writable<Sealed> }>(
  (_, { frozen }) => {
    frozen.set({ digest: "sealed", tags: ["checked"] });
  },
);

export type Frozen = WriteAuthorizedBy<Sealed, typeof freeze>;

const rewriteDigest = handler<void, { frozen: Writable<Sealed> }>(
  (_, { frozen }) => {
    frozen.key("digest").set("mallory");
  },
);

const replaceWithText = handler<void, { frozen: Writable<unknown> }>(
  (_, { frozen }) => {
    frozen.set("mallory");
  },
);

const replaceTags = handler<void, { tags: Writable<unknown> }>(
  (_, { tags }) => {
    tags.set(7);
  },
);

export interface FrozenOutput {
  frozen: Frozen;
  freeze: Stream<void>;
  rewriteDigest: Stream<void>;
  replaceWithText: Stream<void>;
  replaceTags: Stream<void>;
}

export default pattern<Record<string, never>, FrozenOutput>(() => {
  const frozen = new Writable<Frozen>({ digest: "", tags: [] });
  return {
    frozen,
    freeze: freeze({ frozen }),
    rewriteDigest: rewriteDigest({ frozen }),
    replaceWithText: replaceWithText({ frozen }),
    replaceTags: replaceTags({ tags: frozen.key("tags") }),
  };
});
