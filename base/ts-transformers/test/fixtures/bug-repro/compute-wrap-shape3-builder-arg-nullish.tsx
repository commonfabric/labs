// Builder-arg reactive computation repro (lunch-poll PR #4928 rework):
// nullish-coalescing binary as a builder-call argument property value.
// `profile` is an optional pattern input (Cell), `profileWish` is a wish() in
// the same body, and the `??` selection is written INLINE in the bound-handler
// builder args. This used to crash the compiler ("Internal Common Fabric
// compiler error: binary expression compute-wrap decision disagreed with
// reactive-context classification"); `deno task cf check <this file> --no-run`
// must now report the `reactive:call-argument-computation` hoist diagnostic
// instead. The hoisted remedy is golden-pinned at
// fixtures/ast-transform/builder-arg-hoisted-nullish-selection; the diagnostic
// itself is pinned by test/builder-argument-computation-diagnostic.test.ts.
// This file cannot be a golden pair — see README.md in this directory.
import {
  type Cell,
  Default,
  handler,
  pattern,
  UI,
  Writable,
  wish,
} from "commonfabric";

interface Profile {
  name: string;
}

const join = handler<
  { name: string },
  {
    myName: Writable<string>;
    profile: Cell<Profile> | undefined;
  }
>((event, { myName, profile }) => {
  const resolved = profile?.get();
  myName.set(resolved ? resolved.name : event.name);
});

interface CardState {
  myName: Default<string, "">;
  profile?: Cell<Profile>;
}

export default pattern<CardState>(({ myName, profile }) => {
  const profileWish = wish<Profile>({ query: "#profile" });
  const boundJoin = join({
    myName,
    profile: profile ?? profileWish.result,
  });
  return {
    [UI]: (
      <div>
        <cf-button onClick={() => boundJoin.send({ name: "guest" })}>
          Join
        </cf-button>
      </div>
    ),
  };
});
