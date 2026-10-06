import { assertEquals } from "@std/assert";
import type {
  AsyncResult,
  Cell,
  FabricUnavailable,
  LatestCompleteFunction,
  LatestCompleteValue,
  UnavailableVariant,
} from "@commonfabric/api";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

interface Repo {
  owner: string;
  name: string;
}

function latestCompleteTypecheck(
  latestComplete: LatestCompleteFunction,
  repoRequest: AsyncResult<Repo>,
  ticketRequest: AsyncResult<{ title: string }>,
  variable: Cell<number>,
): void {
  const repo = latestComplete(repoRequest);
  const joined = latestComplete({
    repo: repoRequest,
    ticket: ticketRequest,
    variable,
    nested: [repoRequest, { ticket: ticketRequest }] as const,
    optional: undefined as AsyncResult<string> | undefined,
  });

  const repoIsUsable: Equal<typeof repo, Repo> = true;
  type ExpectedJoin = {
    repo: Repo;
    ticket: { title: string };
    variable: number;
    nested: readonly [Repo, { ticket: { title: string } }];
    optional: string | undefined;
  };
  const joinedToExpected: ExpectedJoin = joined;
  const expectedToJoined: typeof joined = joinedToExpected;
  const recursiveUtilityIsExact: Equal<
    LatestCompleteValue<{
      values: Array<AsyncResult<Repo>>;
      choice: { repo: AsyncResult<Repo> } | { count: number };
      baseUnavailable: FabricUnavailable;
      unavailable: UnavailableVariant;
    }>,
    {
      values: Repo[];
      choice: { repo: Repo } | { count: number };
      baseUnavailable: never;
      unavailable: never;
    }
  > = true;

  void repoIsUsable;
  void expectedToJoined;
  void recursiveUtilityIsExact;
}

Deno.test("latestComplete declarations recursively expose complete values", () => {
  assertEquals(typeof latestCompleteTypecheck, "function");
});
