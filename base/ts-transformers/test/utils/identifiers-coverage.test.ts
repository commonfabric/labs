import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  createBindingElementsFromNames,
  createParameterFromBindings,
  createPropertyName,
  createPropertyParamNames,
  extractBindingNames,
  getUniqueIdentifier,
  isSafeIdentifierText,
  maybeReuseIdentifier,
  normalizeBindingName,
  reserveIdentifier,
  sanitizeIdentifierCandidate,
} from "../../src/utils/identifiers.ts";
import { test } from "@commonfabric/test-support/test";

const factory = ts.factory;

function printNode(node: ts.Node): string {
  const sf = ts.createSourceFile("/p.ts", "", ts.ScriptTarget.ESNext, false);
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, sf);
}

test("isSafeIdentifierText rejects empty text", () => {
  assertEquals(isSafeIdentifierText(""), false);
});

test("isSafeIdentifierText accepts a plain identifier", () => {
  assertEquals(isSafeIdentifierText("value"), true);
  assertEquals(isSafeIdentifierText("$ref_1"), true);
});

test("isSafeIdentifierText rejects a reserved word", () => {
  assertEquals(isSafeIdentifierText("class"), false);
  assertEquals(isSafeIdentifierText("return"), false);
});

test(
  "isSafeIdentifierText rejects a word strict-mode or module code reserves or forbids binding",
  () => {
    const words = [
      "implements",
      "interface",
      "let",
      "package",
      "private",
      "protected",
      "public",
      "static",
      "yield",
      "await",
      "eval",
      "arguments",
    ];
    expect(words.filter(isSafeIdentifierText)).toEqual([]);
  },
);

test(
  "reserveIdentifier returns the fallback in place of a word module code reserves",
  () => {
    const used = new Set<string>();
    expect(reserveIdentifier("let", used, factory).text).toBe("ref");
    expect([...used]).toEqual(["ref"]);
  },
);

test(
  "isSafeIdentifierText accepts contextual keywords that are not reserved",
  () => {
    // `async`/`of` scan as identifiers outside their reserved contexts here.
    assertEquals(isSafeIdentifierText("async"), true);
    assertEquals(isSafeIdentifierText("of"), true);
  },
);

test(
  "isSafeIdentifierText rejects an identifier that starts with a digit",
  () => {
    assertEquals(isSafeIdentifierText("1abc"), false);
  },
);

test(
  "isSafeIdentifierText rejects an identifier with an invalid inner char",
  () => {
    assertEquals(isSafeIdentifierText("a-b"), false);
  },
);

test(
  "sanitizeIdentifierCandidate replaces invalid characters with underscores",
  () => {
    assertEquals(sanitizeIdentifierCandidate("a.b-c"), "a_b_c");
  },
);

test(
  "sanitizeIdentifierCandidate prefixes a candidate that starts with a digit",
  () => {
    assertEquals(sanitizeIdentifierCandidate("9lives"), "_9lives");
  },
);

test(
  "sanitizeIdentifierCandidate falls back when the candidate reduces to empty",
  () => {
    assertEquals(sanitizeIdentifierCandidate("", { fallback: "ref" }), "ref");
  },
);

test("sanitizeIdentifierCandidate can trim leading underscores", () => {
  assertEquals(
    sanitizeIdentifierCandidate("__hidden", { trimLeadingUnderscores: true }),
    "hidden",
  );
});

test(
  "sanitizeIdentifierCandidate replaces a reserved-word candidate with the fallback",
  () => {
    // `class` sanitizes char-for-char but is still an unsafe (reserved) token,
    // so it is swapped for the fallback.
    assertEquals(
      sanitizeIdentifierCandidate("class", { fallback: "safe" }),
      "safe",
    );
  },
);

test(
  "sanitizeIdentifierCandidate normalizes a fallback that starts with a digit",
  () => {
    // An empty candidate falls back; the digit-leading fallback is prefixed.
    assertEquals(sanitizeIdentifierCandidate("", { fallback: "1f" }), "_1f");
  },
);

test(
  "sanitizeIdentifierCandidate collapses an all-underscore trimmed fallback to the default",
  () => {
    // Trimming leading underscores empties the fallback, so the default `_` is
    // used for the empty candidate.
    assertEquals(
      sanitizeIdentifierCandidate("", {
        fallback: "___",
        trimLeadingUnderscores: true,
      }),
      "_",
    );
  },
);

test(
  "sanitizeIdentifierCandidate uses the default when the fallback is itself reserved",
  () => {
    // A reserved-word fallback is unsafe, so normalization returns the default
    // `_` for the empty candidate.
    assertEquals(
      sanitizeIdentifierCandidate("", { fallback: "class" }),
      "_",
    );
  },
);

test("getUniqueIdentifier appends a numeric suffix on collision", () => {
  const used = new Set<string>(["value"]);
  assertEquals(getUniqueIdentifier("value", used), "value_1");
  assertEquals(getUniqueIdentifier("value", used), "value_2");
  assert(used.has("value_1"));
  assert(used.has("value_2"));
});

test("getUniqueIdentifier honors a custom suffix separator", () => {
  const used = new Set<string>(["n"]);
  assertEquals(getUniqueIdentifier("n", used, { suffixSeparator: "$" }), "n$1");
});

test("maybeReuseIdentifier reuses a free, safe identifier", () => {
  const used = new Set<string>();
  const id = factory.createIdentifier("keep");
  assertEquals(maybeReuseIdentifier(id, used), id);
  assert(used.has("keep"));
});

test(
  "maybeReuseIdentifier creates a fresh identifier when the name is taken",
  () => {
    const used = new Set<string>(["taken"]);
    const id = factory.createIdentifier("taken");
    const result = maybeReuseIdentifier(id, used);
    assert(result !== id);
    assertEquals(result.text, "taken_1");
  },
);

test(
  "createPropertyName emits an identifier for safe names and a string literal otherwise",
  () => {
    assert(ts.isIdentifier(createPropertyName("ok", factory)));
    const literal = createPropertyName("not-ok", factory);
    assert(ts.isStringLiteral(literal));
    assertEquals(literal.text, "not-ok");
  },
);

test("reserveIdentifier reuses a free candidate", () => {
  const used = new Set<string>();
  const id = reserveIdentifier("fresh", used, factory);
  assertEquals(id.text, "fresh");
  assert(used.has("fresh"));
});

test(
  "reserveIdentifier allocates a unique name when the candidate is taken",
  () => {
    const used = new Set<string>(["dup"]);
    const id = reserveIdentifier("dup", used, factory);
    assertEquals(id.text, "dup_1");
  },
);

test("reserveIdentifier uses the empty fallback for a blank candidate", () => {
  const used = new Set<string>();
  const id = reserveIdentifier("", used, factory, { emptyFallback: "anon" });
  assertEquals(id.text, "anon");
});

test(
  "createBindingElementsFromNames adds property names only for unsafe keys",
  () => {
    const elements = createBindingElementsFromNames(
      ["safe", "not-safe"],
      factory,
      (name) => factory.createIdentifier(name.replace(/[^A-Za-z0-9_$]/g, "_")),
    );
    assertEquals(elements.length, 2);
    // Safe key: no explicit property name (shorthand binding).
    assertEquals(elements[0]!.propertyName, undefined);
    // Unsafe key: explicit string-literal property name.
    assert(elements[1]!.propertyName);
    assert(ts.isStringLiteral(elements[1]!.propertyName!));
  },
);

test(
  "createParameterFromBindings wraps binding elements in an object pattern",
  () => {
    const elements = createBindingElementsFromNames(
      ["a"],
      factory,
      (name) => factory.createIdentifier(name),
    );
    const param = createParameterFromBindings(elements, factory, {
      type: factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    });
    assert(ts.isObjectBindingPattern(param.name));
    assert(param.type);
  },
);

test(
  "createPropertyParamNames derives property and param names with fallbacks",
  () => {
    const props = new Set<string>();
    const params = new Set<string>();
    const identifierResult = createPropertyParamNames(
      "user",
      true,
      0,
      props,
      params,
    );
    assertEquals(identifierResult.propertyName, "user");
    assertEquals(identifierResult.paramName, "user");

    // Non-identifier expression: property name from dotted text, param uses _vN.
    const memberResult = createPropertyParamNames(
      "user.name",
      false,
      1,
      props,
      params,
    );
    assertEquals(memberResult.propertyName, "user_name");
    assertEquals(memberResult.paramName, "_v2");
  },
);

test("normalizeBindingName reuses a safe identifier binding", () => {
  const used = new Set<string>();
  const name = factory.createIdentifier("item");
  const result = normalizeBindingName(name, factory, used);
  assert(ts.isIdentifier(result));
  assertEquals(result.text, "item");
});

test("normalizeBindingName recurses through an object binding pattern", () => {
  const used = new Set<string>(["a"]);
  const pattern = factory.createObjectBindingPattern([
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier("a"),
    ),
  ]);
  const result = normalizeBindingName(pattern, factory, used);
  assert(ts.isObjectBindingPattern(result));
  // The colliding shorthand binding `a` is renamed to `a_1`.
  assertEquals(printNode(result), "{ a_1 }");
});

test(
  "normalizeBindingName preserves omitted elements in an array pattern",
  () => {
    const used = new Set<string>();
    const pattern = factory.createArrayBindingPattern([
      factory.createOmittedExpression(),
      factory.createBindingElement(
        undefined,
        undefined,
        factory.createIdentifier("second"),
      ),
    ]);
    const result = normalizeBindingName(pattern, factory, used);
    assert(ts.isArrayBindingPattern(result));
    assertEquals(printNode(result), "[, second]");
  },
);

test(
  "extractBindingNames returns the name of a simple identifier binding",
  () => {
    assertEquals(extractBindingNames(factory.createIdentifier("solo")), [
      "solo",
    ]);
  },
);

test("extractBindingNames flattens nested object and array patterns", () => {
  const pattern = factory.createObjectBindingPattern([
    factory.createBindingElement(
      undefined,
      undefined,
      factory.createIdentifier("a"),
    ),
    factory.createBindingElement(
      undefined,
      "nested",
      factory.createArrayBindingPattern([
        factory.createOmittedExpression(),
        factory.createBindingElement(
          undefined,
          undefined,
          factory.createIdentifier("b"),
        ),
      ]),
    ),
  ]);
  assertEquals(extractBindingNames(pattern), ["a", "b"]);
});
