import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
  type Outstanding,
  type Transaction,
} from "../executor.ts";
import { isLink } from "../store.ts";

// The effect operations of `scheduler-and-serving-loop.md` (SS) §6 and
// `execution-and-storage.md` (ES) §6.4, and `wish` as
// `builtin-inventory.md` (BI) has it, on the artifacts of the fixtures.
// Nothing leaves the process: a request is held in `Instance.outbox`, and
// the test delivers its completion.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

const bindingOf = (instance: Instance, name: string): number => {
  const found = instance.plan.bindings.findIndex((binding) =>
    binding.name === name
  );
  if (found < 0) throw new Error(`no binding named ${name}`);
  return found;
};

const during = (instance: Instance, run: () => void): Transaction[] => {
  const before = instance.transactions.length;
  run();
  return instance.transactions.slice(before);
};

const causes = (transactions: readonly Transaction[]): string[] =>
  transactions.map(({ cause }) => cause);

const evaluated = (transactions: readonly Transaction[]): string[] =>
  transactions.flatMap((transaction) => transaction.evaluated);

/** The outstanding requests of the operation `fetched` of the fixture. */
const fetchedOf = (instance: Instance): Outstanding[] =>
  instance.outbox.filter(({ request }) =>
    (request as { options?: unknown }).options !== undefined
  );

// `fixtures/effects.tsx`. No per-element construct is in it.
describe("an effect of the reactive tier", () => {
  const start = async () =>
    new Instance(await artifactOf("effects"), {
      note: "n",
    });

  it("is requested when something demands its result, behind the derivation that staged the request", async () => {
    const instance = await start();

    expect(causes(instance.transactions)).toEqual([
      "creation",
      "derivation",
      "request",
      "request",
      "derivation",
    ]);
    const [request] = fetchedOf(instance);
    expect(request).toMatchObject({
      builtin: "fetchJson",
      request: {
        url: "https://example.test/a",
        options: { method: "POST", body: { id: 1 } },
      },
    });
    expect(instance.result()).toMatchObject({
      title: "none",
      status: "pending",
    });
  });

  it("hands a function body the record of its result while that holds nothing", async () => {
    const instance = await start();

    // The body names `fetched.result`: the record `fetched` is there,
    // and its member holds nothing.
    expect(instance.failed).toEqual([]);
    expect(instance.result()).toMatchObject({ inBody: "nothing yet" });

    instance.answer(({ request }) =>
      (request as { options?: unknown }).options === undefined
        ? undefined
        : { result: { title: "T" } }
    );
    expect(instance.result()).toMatchObject({ inBody: "got T" });
  });

  it("is not requested where nothing reads its result", async () => {
    const instance = await start();

    // `_unread` has the request `{ url }` alone, as `guarded` has.
    expect(instance.outbox.length).toBe(2);
    expect(instance.transactions.flatMap(({ evaluated }) => evaluated)).not
      .toContain("_unread");
    expect(instance.documents()["operation state"]).toBe(2);
  });

  it("stores the request in the state document of the operation, with a cell that is passed on as a link", async () => {
    const instance = await start();

    const [{ operation }] = fetchedOf(instance);
    const state = instance.store.docs.get(operation);
    expect(state?.kind).toBe("operation state");
    const stored = state?.value as {
      request: { url: unknown; options: { method: unknown; body: unknown } };
      requestHash: unknown;
      outcome: { pending: unknown };
    };
    expect(stored.request.url).toBe("https://example.test/a");
    expect(stored.request.options.method).toBe("POST");
    expect(isLink(stored.request.options.body)).toBe(true);
    // What a reader of the result reads is apart from the request.
    expect(stored.outcome).toEqual({ pending: true });
    expect(stored.requestHash).toBe(fetchedOf(instance)[0].hash);
  });

  it("gets its completion in a transaction of its own, and its readers the derivation transaction that follows", async () => {
    const instance = await start();
    const [request] = fetchedOf(instance);

    let wrote = false;
    const completion = during(instance, () => {
      wrote = instance.complete(request.id, { result: { title: "T" } });
    });

    expect(wrote).toBe(true);
    expect(causes(completion)).toEqual(["completion"]);
    expect(completion[0].evaluated).toEqual([]);
    expect(completion[0].written).toEqual([request.operation]);
    // The stored result of the instance is as it was until a derivation
    // transaction evaluates the readers.
    expect(instance.result()).toMatchObject({ title: "none" });

    const derivation = during(instance, () => instance.settle());

    expect(causes(derivation)).toEqual(["derivation"]);
    expect(instance.result()).toMatchObject({
      title: "T",
      status: "settled",
      checked: "titled T",
    });
    expect(fetchedOf(instance)).toEqual([]);
  });

  it("has its readers evaluated once with the other changes of the cycle that follows its completion", async () => {
    const instance = await start();
    const [request] = fetchedOf(instance);

    const transactions = during(instance, () => {
      instance.complete(request.id, { result: { title: "T" } });
      instance.enqueue(bindingOf(instance, "setSite"), {
        to: "https://example.test/b",
      });
      instance.batch();
    });

    expect(causes(transactions).slice(0, 3)).toEqual([
      "completion",
      "event",
      "derivation",
    ]);
    expect(transactions[2].evaluated.filter((cone) => cone === "title"))
      .toEqual(["title"]);
  });

  it("is not requested again where its cone is evaluated again and computes the request it had", async () => {
    const instance = await start();

    const transactions = during(instance, () => {
      // `address` is the lower case of `site`: the same address.
      instance.send(bindingOf(instance, "setSite"), {
        to: "HTTPS://EXAMPLE.TEST/A",
      });
    });

    expect(evaluated(transactions)).toContain("address");
    expect(causes(transactions)).toEqual(["event", "derivation"]);
    expect(instance.outbox.length).toBe(2);
  });

  it("is requested again when the content behind a reference of its request changes, with no evaluation of its cone", async () => {
    const instance = await start();

    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "setPayload"), { id: 2 });
    });

    expect(causes(transactions)).toEqual([
      "event",
      "derivation",
      "request",
      "derivation",
    ]);
    expect(evaluated(transactions)).not.toContain("fetched");
    expect(fetchedOf(instance).map(({ request }) => request)).toMatchObject([
      { options: { body: { id: 1 } } },
      { options: { body: { id: 2 } } },
    ]);
  });

  it("writes nothing for the completion of a request that another replaced", async () => {
    const instance = await start();
    const [first] = fetchedOf(instance);
    instance.send(bindingOf(instance, "setPayload"), { id: 2 });
    const second = fetchedOf(instance)[1];

    let wrote = true;
    const [completion] = during(instance, () => {
      wrote = instance.complete(first.id, { result: { title: "old" } });
    });

    expect(wrote).toBe(false);
    expect(completion).toMatchObject({ cause: "completion", written: [] });
    instance.settle();
    expect(instance.result()).toMatchObject({ status: "pending" });

    expect(instance.complete(second.id, { result: { title: "new" } })).toBe(
      true,
    );
    instance.settle();
    expect(instance.result()).toMatchObject({ title: "new" });
  });

  it("stores an error with the hash of the request and does not request again", async () => {
    const instance = await start();
    const [request] = fetchedOf(instance);
    instance.complete(request.id, { error: "unreachable" });
    instance.settle();
    expect(instance.result()).toMatchObject({ status: "failed" });

    const transactions = during(instance, () => {
      // A cause that changes nothing of the request.
      instance.send(bindingOf(instance, "setPayload"), { id: 1 });
    });

    expect(causes(transactions)).not.toContain("request");
    expect(fetchedOf(instance)).toEqual([]);

    // The next request is one whose inputs changed.
    instance.send(bindingOf(instance, "setPayload"), { id: 3 });
    expect(fetchedOf(instance).length).toBe(1);
    expect(instance.result()).toMatchObject({ status: "pending" });
  });

  // SS §6.6: "A request is made at most once per distinct request hash
  // and state document". SS §6.2, steps 4 to 6, compares the hash of the
  // request with the one hash that the state document holds.
  it("is requested a second time for a request that came back while the first was outstanding", async () => {
    const instance = await start();
    const setPayload = bindingOf(instance, "setPayload");

    instance.send(setPayload, { id: 2 });
    instance.send(setPayload, { id: 1 });

    const sent = fetchedOf(instance);
    expect(
      sent.map(({ request }) =>
        (request as { options: { body: { id: number } } }).options.body.id
      ),
    ).toEqual([1, 2, 1]);
    expect(sent[0].hash).toBe(sent[2].hash);
    // The completion of the first is that of the request the operation
    // selects, and is written.
    expect(instance.complete(sent[0].id, { result: { title: "first" } }))
      .toBe(true);
  });

  it("keeps its result where a cone that reads it fails", async () => {
    const instance = await start();
    const [request] = fetchedOf(instance);

    instance.complete(request.id, { result: { title: "" } });
    const [derivation] = during(instance, () => instance.settle());

    expect(derivation.failed).toEqual(["checked"]);
    expect(derivation.committed).toBe(true);
    expect(instance.result()).toMatchObject({
      title: "",
      status: "settled",
      checked: { $error: { message: "no title" } },
    });
    expect(
      (instance.store.docs.get(request.operation)?.value as {
        outcome: { result: unknown };
      }).outcome.result,
    ).toEqual({ title: "" });
  });

  it("is not requested where the cone of its request failed, and its result is that error state", async () => {
    const instance = await start();
    const before = instance.outbox.length;

    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "setSite"), { to: "bad:address" });
    });

    // `fetched` is requested for the new address, and `guarded` is not.
    expect(instance.outbox.length).toBe(before + 1);
    expect(transactions.flatMap(({ failed }) => failed)).toContain(
      "guardedStatus",
    );
    expect(instance.result()).toMatchObject({
      guardedStatus: { $error: { message: "a bad address" } },
    });
  });

  it("is answered from a table until nothing is outstanding that the table answers", async () => {
    const instance = await start();

    const answered = instance.answer(({ request }) =>
      (request as { options?: unknown }).options === undefined
        ? undefined
        : { result: { title: "from the table" } }
    );

    expect(answered).toBe(1);
    expect(instance.result()).toMatchObject({
      title: "from the table",
      status: "settled",
      guardedStatus: "pending",
    });
    expect(instance.outbox.length).toBe(1);
  });
});

// `fixtures/wishes.tsx`. No per-element construct is in it.
describe("a `wish` of the reactive tier", () => {
  const start = async (
    wishes?: (
      operands: Record<string, unknown>,
    ) => { result?: unknown; error?: unknown } | undefined,
  ) =>
    new Instance(await artifactOf("wishes"), { note: "n" }, {
      now: 1_000,
      ...(wishes === undefined ? {} : { wishes }),
    });

  it("resolves to a reference to what the table gives for its operands", async () => {
    const instance = await start(({ query }) =>
      query === "#profile" ? { result: { name: "ada" } } : undefined
    );

    expect(instance.result()).toMatchObject({
      greeting: "hello ada",
      profile: { name: "ada" },
    });
    // The result document holds a link at `profile`, and no request left.
    const stored = instance.store.docs.get(instance.id)?.value as {
      profile: unknown;
    };
    expect(isLink(stored.profile)).toBe(true);
    expect(instance.outbox).toEqual([]);
    expect(causes(instance.transactions)).toEqual(["creation", "derivation"]);
  });

  it("holds nothing as its result, and an error, where the table has no target", async () => {
    const instance = await start();

    expect(instance.result()).toMatchObject({ greeting: "hello nobody" });
    expect((instance.result() as { profile?: unknown }).profile).toBe(
      undefined,
    );
    expect((instance.result() as { problem?: unknown }).problem).toBe(
      "no target for `#profile`",
    );
  });

  it("reads the clock once for `#now`, and follows it for `#now/1`", async () => {
    const instance = await start();
    expect(instance.result()).toMatchObject({ started: 1_000, time: 1_000 });

    const transactions = during(instance, () => instance.tick(2_000));

    // A tick is a change from storage: one derivation transaction.
    expect(causes(transactions)).toEqual(["derivation"]);
    expect(instance.result()).toMatchObject({ started: 1_000, time: 2_000 });
  });
});

// `fixtures/handler-effect.tsx`. `loaded` is an array that a handler
// pushes links onto, and no per-element construct is over it.
describe("an effect that a handler requests", () => {
  const start = async () =>
    new Instance(await artifactOf("handler-effect"), {
      target: { name: "there" },
    });
  const fetches = (instance: Instance) =>
    instance.outbox.filter(({ builtin }) => builtin === "fetchJson");

  it("leaves when the event's transaction commits, with nothing demanding its result", async () => {
    const instance = await start();

    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "load"), { url: "https://a.test" });
    });

    // The event's transaction stages the request, its hash and the
    // pending mark, and no request transaction follows.
    expect(causes(transactions)).toEqual(["event", "derivation"]);
    const [request] = fetches(instance);
    expect(request).toMatchObject({
      request: { url: "https://a.test", options: { body: { id: 1 } } },
    });
    expect(transactions[0].written).toContain(request.operation);
    expect(instance.store.docs.get(request.operation)).toMatchObject({
      kind: "operation state",
      value: { outcome: { pending: true }, requestHash: request.hash },
    });
    expect(instance.result()).toMatchObject({
      loaded: [{ pending: true }],
    });
  });

  it("is made once: a change behind a reference of its request does not request it again", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "load"), { url: "https://a.test" });

    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "setBody"), { id: 2 });
    });

    expect(causes(transactions)).not.toContain("request");
    expect(fetches(instance).length).toBe(1);
  });

  it("is a request of its own for each event", async () => {
    const instance = await start();
    const load = bindingOf(instance, "load");

    instance.send(load, { url: "https://a.test" });
    instance.send(load, { url: "https://a.test" });

    const [first, second] = fetches(instance);
    expect(first.hash).toBe(second.hash);
    expect(first.operation).not.toBe(second.operation);
  });

  it("does not leave where the body throws", async () => {
    const instance = await start();
    const documents = instance.documents()["operation state"];

    const outcome = instance.send(bindingOf(instance, "loadAndFail"), {
      url: "https://a.test",
    });

    expect(outcome.committed).toBe(false);
    expect(fetches(instance)).toEqual([]);
    expect(instance.documents()["operation state"]).toBe(documents);
  });

  it("gets its completion as an effect of the reactive tier does", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "load"), { url: "https://a.test" });
    const [request] = fetches(instance);

    expect(instance.complete(request.id, { result: { title: "T" } })).toBe(
      true,
    );
    instance.settle();

    expect(instance.result()).toMatchObject({
      loaded: [{ pending: false, result: { title: "T" } }],
    });
  });
});

describe("a `navigateTo` of the reactive tier", () => {
  it("is requested with its instance, with nothing reading its result", async () => {
    const instance = new Instance(await artifactOf("handler-effect"), {
      target: { name: "there" },
    });

    expect(instance.outbox).toMatchObject([
      { builtin: "navigateTo", request: { name: "there" } },
    ]);
  });
});

// `fixtures/failed-request.tsx`: the request of `fetched` holds a value
// whose cone fails for one address, so the request is not made and the
// operation's result is that error state (SS §6.2, step 1). The outcome
// of the state document holds the error state: a reader through the
// reference to the outcome takes it, and a reader that passes the
// reference on reads nothing. No per-element construct is here.
describe("an effect whose request was not made", () => {
  /** The instance, and the transactions of an address that fails. */
  const failing = async () => {
    const instance = new Instance(await artifactOf("failed-request"), {
      note: "n",
    });
    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "setSite"), { to: "bad:address" });
    });
    return { instance, transactions };
  };

  it("gives a cone that reads a member of its result the error state", async () => {
    const { instance, transactions } = await failing();

    expect(transactions.flatMap(({ failed }) => failed)).toContain("status");
    expect(instance.result()).toMatchObject({
      status: { $error: { message: "a bad address" } },
    });
  });

  it("evaluates no cone that passes its result on by reference again, and that cone holds the reference", async () => {
    const { instance, transactions } = await failing();

    expect(evaluated(transactions)).not.toContain("held");
    const stored = instance.store.docs.get(instance.id)?.value as {
      passed: unknown;
    };
    expect(isLink(stored.passed)).toBe(true);
  });

  it("gives a handler that reads its result through a handle the error state", async () => {
    const { instance } = await failing();

    instance.send(bindingOf(instance, "look"), undefined);

    expect(instance.result()).toMatchObject({
      seen: { $error: { message: "a bad address" } },
    });
  });

  it("gives a client that reads the stored link the error state, and a record again once a request is made", async () => {
    const { instance } = await failing();

    expect(instance.result()).toMatchObject({
      passed: { $error: { message: "a bad address" } },
      held: { request: { $error: { message: "a bad address" } } },
    });
    instance.send(bindingOf(instance, "setSite"), {
      to: "https://example.test/b",
    });
    expect(instance.result()).toMatchObject({
      passed: { pending: true },
      held: { request: { pending: true } },
      status: "pending",
    });
  });
});
