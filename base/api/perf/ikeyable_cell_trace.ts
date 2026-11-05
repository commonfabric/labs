import type { AsCell, Cell, IKeyable } from "../index.ts";

type SampleValue = {
  profile: {
    name: Cell<string>;
    stats: Cell<{
      followers: Cell<number>;
      score: Cell<number>;
    }>;
  };
  posts: Cell<
    Array<
      Cell<{
        title: Cell<string>;
        reactions: Cell<{
          likes: Cell<number>;
          dislikes: Cell<number>;
        }>;
      }>
    >
  >;
  registry: Cell<Record<string, Cell<number>>>;
};

type SampleKeyable = IKeyable<Cell<SampleValue>, AsCell>;

type Access<K extends PropertyKey> = SampleKeyable["key"] extends
  (key: K) => infer R ? R : never;

type ProfileAccess = Access<"profile">;
type PostsAccess = Access<"posts">;
type RegistryAccess = Access<"registry">;
type UnionAccess = Access<"profile" | "posts">;
type FallbackAccess = Access<string>;
