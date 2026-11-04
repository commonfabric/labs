import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type FactoryInput,
  isModule,
  isPattern,
  type Reactive,
} from "../src/builder/types.ts";
import { isWriteRedirectLink } from "../src/link-utils.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

describe("value type", () => {
  it("can destructure a value without TS errors", () => {
    const { foo, bar }: {
      foo: FactoryInput<string>;
      bar: FactoryInput<string>;
    } = {
      foo: "foo",
      bar: "bar",
    } as Reactive<{
      foo: string;
      bar: string;
    }>;
    expect(foo).toBe("foo");
    expect(bar).toBe("bar");
  });

  it("works for arrays as well without TS errors", () => {
    const [foo, bar]: [FactoryInput<string>, FactoryInput<number>] = [
      "foo",
      1,
    ] as Reactive<[string, number]>;
    expect(foo).toBe("foo");
    expect(bar).toBe(1);
  });
});

describe("utility functions", () => {
  it("isWriteRedirectLink correctly identifies write redirects", () => {
    // `$alias` records are Pattern bindings, not links in data.
    expect(isWriteRedirectLink({ $alias: { path: ["path", "to", "value"] } }))
      .toBe(false);
    expect(
      isWriteRedirectLink({
        "/": {
          [LINK_V1_TAG]: { id: "path/to/value", overwrite: "redirect" },
        },
      }),
    ).toBe(
      true,
    );
    expect(isWriteRedirectLink({ notAlias: "something" })).toBe(false);
  });

  it("isModule correctly identifies modules", () => {
    expect(isModule({ type: "javascript", implementation: () => {} })).toBe(
      true,
    );
    expect(isModule({ notModule: "something" })).toBe(false);
  });

  it("isPattern correctly identifies patterns", () => {
    expect(
      isPattern({
        argumentSchema: {},
        resultSchema: {},
        nodes: [],
      }),
    ).toBe(true);
    expect(isPattern({ notPattern: "something" })).toBe(false);
  });
});
