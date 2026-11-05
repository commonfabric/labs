/**
 * The order a schema lists what TypeScript holds without an order of its own:
 * a union's members, and a mapped type's properties.
 *
 * The checker keeps a union's members sorted by the order it created their
 * types in, and a mapped type over a union of keys enumerates its properties
 * in that order too. For most types that order belongs to the program rather
 * than to the source: a literal, an object type, an instantiation is created
 * the first time anything in the program mentions it, so one module compiled
 * inside two programs lists the same union two ways. A module's pattern
 * identity hashes its source alone, so both listings would run under one
 * identity, and anything keyed on the schema would split between them.
 *
 * The checker's intrinsic types — `string`, `number`, `undefined`, `null`,
 * `true`, `false` and the rest — are the exception. It creates them before it
 * reads any source, always in the same order, so their place in a union is
 * the same in every program, ahead of every other member. They keep it here.
 * Every other member is put in an order read from the source: the order a
 * union is written in where the source writes one, and otherwise the order
 * `compareTypesBySource()` gives.
 */

import ts from "typescript";

import {
  getTypeAliasDeclaration,
  readUnionMemberNodes,
  unwrapTypeParentheses,
} from "./type-node.ts";

/**
 * Whether `node` is written in a source file, so that the order of what it
 * lists is the source's. A node a transform builds, as ts-transformers builds
 * one for an inferred type from the checker's type, lists a union's members
 * in the checker's order, and is not.
 */
export function isWrittenNode(node: ts.Node): boolean {
  return node.pos >= 0 && (node.flags & ts.NodeFlags.Synthesized) === 0;
}

/**
 * The members `node`, a union node, lists, in source order: as written, where
 * a source file writes `node` or the node a transform copied it from
 * (`isWrittenNode()`); otherwise, as for a node a transform built from the
 * checker's type, in an order of their own. A keyword member keeps its
 * place, which a node printed from the checker's type gives it the same way
 * in every program: the checker's intrinsic types are listed before any type
 * a source declares, and printing moves `null` and `undefined` last. The
 * other members fill the remaining places, literals first, by kind and
 * value, then the rest, by `canonicalNodeKey()`.
 */
export function unionNodeMembersInOrder(
  node: ts.UnionTypeNode,
): readonly ts.TypeNode[] {
  if (isWrittenNode(ts.getOriginalNode(node))) return node.types;
  const rest: Array<
    { node: ts.TypeNode; tier: number; key: string | number | bigint }
  > = [];
  for (const member of node.types) {
    const literal = literalNodeKey(member);
    if (literal === "keyword") continue;
    if (literal !== undefined) rest.push({ node: member, ...literal });
    else rest.push({ node: member, tier: 3, key: canonicalNodeKey(member) });
  }
  rest.sort((left, right) =>
    left.tier - right.tier || compareNodeKeys(left.key, right.key)
  );
  let next = 0;
  return node.types.map((member) =>
    literalNodeKey(member) === "keyword" ? member : rest[next++]!.node
  );
}

/** The kinds of keyword type node, as `string` and `undefined` are. */
const KEYWORD_TYPE_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.ObjectKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.IntrinsicKeyword,
]);

/**
 * Compares two keys `unionNodeMembersInOrder()` sorts by, which share a kind
 * within one tier: numbers and bigints by value, strings by code unit.
 */
function compareNodeKeys(
  left: string | number | bigint,
  right: string | number | bigint,
): number {
  if (typeof left === "string" || typeof right === "string") {
    return compareStrings(String(left), String(right));
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Where `unionNodeMembersInOrder()` places the member `node`: `"keyword"`
 * for a keyword, `true`, `false` or `null`; a tier and a value for a
 * literal, numbers before bigints before strings; `undefined` otherwise.
 */
function literalNodeKey(
  node: ts.TypeNode,
): "keyword" | { tier: number; key: string | number | bigint } | undefined {
  const member = unwrapTypeParentheses(node);
  if (KEYWORD_TYPE_KINDS.has(member.kind)) return "keyword";
  if (!ts.isLiteralTypeNode(member)) return undefined;
  const { literal } = member;
  switch (literal.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return "keyword";
    case ts.SyntaxKind.NumericLiteral:
      return { tier: 0, key: Number((literal as ts.NumericLiteral).text) };
    case ts.SyntaxKind.BigIntLiteral:
      return {
        tier: 1,
        key: BigInt((literal as ts.BigIntLiteral).text.slice(0, -1)),
      };
    case ts.SyntaxKind.StringLiteral:
      return { tier: 2, key: (literal as ts.StringLiteral).text };
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const unary = literal as ts.PrefixUnaryExpression;
      if (unary.operator !== ts.SyntaxKind.MinusToken) return undefined;
      if (ts.isNumericLiteral(unary.operand)) {
        return { tier: 0, key: -Number(unary.operand.text) };
      }
      if (ts.isBigIntLiteral(unary.operand)) {
        return { tier: 1, key: -BigInt(unary.operand.text.slice(0, -1)) };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A key for `node` that two nodes share exactly when they are written the
 * same way: its kind and operator (`operatorOf()`), its names and literals'
 * text, and its children's keys,
 * those of a union's members in the order of the keys, so that a union the
 * node holds reads the same whatever order it lists its members in.
 */
function canonicalNodeKey(node: ts.Node): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return `#${node.text}`;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.text);
  }
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
    return node.text;
  }
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(canonicalNodeKey(child));
  });
  if (ts.isUnionTypeNode(node)) children.sort(compareStrings);
  return `${ts.SyntaxKind[node.kind]}${operatorOf(node)}(${
    children.join(",")
  })`;
}

/**
 * What `node` writes that is no child of it, which `canonicalNodeKey()` keys
 * besides its children: a type operator's or a prefix operator's token, as
 * `readonly` against `keyof` or `-` against `+`, and whether an import type
 * is `typeof`.
 */
function operatorOf(node: ts.Node): string {
  if (ts.isTypeOperatorNode(node) || ts.isPrefixUnaryExpression(node)) {
    return `:${ts.SyntaxKind[node.operator]}`;
  }
  if (ts.isImportTypeNode(node) && node.isTypeOf) return ":typeof";
  return "";
}

/**
 * `items`, a union's members or what stands for them in the checker's order,
 * in source order: the items whose types are intrinsic first, as they came,
 * then those `rankOf` places, by their rank, and then the rest, in the order
 * `compareTypesBySource()` gives their types. Items of one rank are ordered
 * by their types the same way, as the members a `boolean` written in a union
 * stands for are. Items whose types the comparison cannot tell apart keep the
 * order they came in.
 */
export function inSourceOrder<T>(
  items: readonly T[],
  typeOf: (item: T) => ts.Type,
  rankOf: (item: T) => number | undefined = () => undefined,
): T[] {
  const intrinsic = items.filter((item) => isIntrinsic(typeOf(item)));
  const ranked = items
    .filter((item) => !isIntrinsic(typeOf(item)))
    .map((item) => ({
      item,
      rank: rankOf(item) ?? Number.POSITIVE_INFINITY,
    }));
  ranked.sort((left, right) =>
    left.rank !== right.rank
      ? left.rank - right.rank
      : compareTypesBySource(typeOf(left.item), typeOf(right.item))
  );
  return [...intrinsic, ...ranked.map(({ item }) => item)];
}

/**
 * `properties`, the checker's properties of `type`, in source order, `node`
 * being the node `type` is read at, if any.
 *
 * A mapped type's properties follow the union of keys it maps over, so they
 * are put in the order `node` writes their keys in, where it writes a key
 * union for them (`writtenMappedKeys()`); else in the source order of the
 * type it maps, as `Omit<T, K>` maps `T` (`mappedSourceOrder()`); else in the
 * order of their declarations, a property with neither after those with one,
 * by name.
 *
 * An interface or a class without type parameters lists its own members as
 * the checker lists them, and then each base type's properties, base by base
 * in the order its heritage clauses name them, each base's in its own source
 * order: a base can be a mapped type, as an `Omit<…>` is, whose checker
 * order is its key union's (`inheritedSourceOrder()`). Any other type keeps
 * the checker's order between declarations and orders each run of
 * consecutive properties declared in one place by their declarations, as
 * does a type met again while its own order is being read, as
 * `interface Wrap extends Empty<Wrap>` meets `Wrap`.
 */
export function propertiesInSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  return orderProperties(type, properties, node, checker, new Set());
}

/**
 * `propertiesInSourceOrder()`, `entered` holding the types whose order is
 * being read further up, which are not followed into again.
 */
function orderProperties(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): readonly ts.Symbol[] {
  if (properties.length <= 1) return properties;
  const reentered = entered.has(type);
  const inside = new Set(entered).add(type);
  const mapped = (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
  if (mapped) {
    const keys = writtenMappedKeys(node, checker) ??
      (reentered
        ? undefined
        : mappedSourceOrder(type, properties, checker, inside));
    const rankOf = (property: ts.Symbol) =>
      keys?.get(property.getName()) ?? Number.POSITIVE_INFINITY;
    return [...properties].sort((left, right) =>
      rankOf(left) - rankOf(right) || compareByDeclaration(left, right)
    );
  }
  const inherited = reentered
    ? undefined
    : inheritedSourceOrder(type, properties, checker, inside);
  if (inherited !== undefined) return inherited;
  const ordered: ts.Symbol[] = [];
  let run: ts.Symbol[] = [];
  let runParent: ts.Node | undefined;
  const flush = () => {
    for (const property of run.sort(compareByDeclaration)) {
      ordered.push(property);
    }
    run = [];
  };
  for (const property of properties) {
    const parent = property.declarations?.[0]?.parent;
    if (parent === undefined || parent !== runParent) flush();
    run.push(property);
    runParent = parent;
  }
  flush();
  return ordered;
}

/**
 * The properties of `type`, an interface or a class without type
 * parameters, in source order: its own members as the checker lists them,
 * then each base type's properties in turn, in the base's own source order,
 * a property already placed not placed again, each base read past the
 * types in `entered` (`orderProperties()`). Returns `undefined` for any
 * other type. Base types are read only once the checker has resolved them,
 * as it has for a type whose properties it listed, so nothing is created.
 */
function inheritedSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): readonly ts.Symbol[] | undefined {
  if (
    !type.isClassOrInterface() ||
    (type as ts.InterfaceType).typeParameters?.length
  ) {
    return undefined;
  }
  const bases = checker.getBaseTypes(type);
  if (bases.length === 0) return undefined;
  const byName = new Map(properties.map((property) => [
    property.getName(),
    property,
  ]));
  const ordered: ts.Symbol[] = [];
  const place = (name: string) => {
    const property = byName.get(name);
    if (property === undefined) return;
    byName.delete(name);
    ordered.push(property);
  };
  const own = new Set<ts.Node>(type.getSymbol()?.declarations ?? []);
  for (const property of properties) {
    const declaration = property.declarations?.[0];
    if (declaration !== undefined && own.has(memberOwner(declaration))) {
      place(property.getName());
    }
  }
  for (const base of bases) {
    const baseProperties = checker.getPropertiesOfType(base);
    for (
      const property of orderProperties(
        base,
        baseProperties,
        undefined,
        checker,
        entered,
      )
    ) {
      place(property.getName());
    }
  }
  for (const property of properties) place(property.getName());
  return ordered;
}

/**
 * The class or interface declaration that declares the member `declaration`:
 * its parent, or for a constructor's parameter property the class the
 * constructor belongs to.
 */
function memberOwner(declaration: ts.Declaration): ts.Node {
  const parent = declaration.parent;
  return ts.isParameter(declaration) && ts.isConstructorDeclaration(parent)
    ? parent.parent
    : parent;
}

/**
 * The places, by property name, of the properties of the type a mapped type
 * maps, as `Omit<T, K>` and `Pick<T, K>` map `T`, in that type's source
 * order (`orderProperties()`, past the types in `entered`): the first type
 * argument of the alias `type` is read through, where `type` has properties
 * and every one is one of its, declared where its namesake there is
 * declared. The checker links a
 * property to the declaration it maps only for a mapped type that maps
 * another's properties, so a mapped type over keys of its own, as
 * `{ [P in "a" | "b"]: T }` is, does not qualify. Returns `undefined`
 * otherwise.
 */
function mappedSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): Map<string, number> | undefined {
  const source = type.aliasTypeArguments?.[0];
  if (
    properties.length === 0 || source === undefined ||
    (source.flags & ts.TypeFlags.Object) === 0
  ) {
    return undefined;
  }
  const sourceProperties = checker.getPropertiesOfType(source);
  const declarations = new Map(sourceProperties.map((property) => [
    property.getName(),
    property.declarations?.[0],
  ]));
  const mapsSource = properties.every((property) => {
    const declaration = property.declarations?.[0];
    return declaration !== undefined &&
      declarations.get(property.getName()) === declaration;
  });
  if (!mapsSource) return undefined;
  const places = new Map<string, number>();
  for (
    const property of orderProperties(
      source,
      sourceProperties,
      undefined,
      checker,
      entered,
    )
  ) {
    places.set(property.getName(), places.size);
  }
  return places;
}

/**
 * The keys `node` writes for the mapped type it denotes, by the names of the
 * properties they make (`propertyNameOfKey()`), each by its place: the key union of a mapped type written in place, or the key argument
 * a reference passes to an alias of one, as `Record<"b" | "a", V>` passes
 * `"b" | "a"`. Returns `undefined` where `node` writes no key union, as it
 * does for an alias whose mapped type does not map over a parameter of its
 * own, or where a transform built `node`.
 */
function writtenMappedKeys(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): Map<string, number> | undefined {
  if (node === undefined || !isWrittenNode(node)) return undefined;
  const written = unwrapTypeParentheses(node);
  let keyNode: ts.TypeNode | undefined;
  if (ts.isMappedTypeNode(written)) {
    keyNode = written.typeParameter.constraint;
  } else if (ts.isTypeReferenceNode(written) && written.typeArguments) {
    keyNode = aliasKeyArgument(written, checker);
  }
  if (keyNode === undefined) return undefined;
  const keys = new Map<string, number>();
  for (const member of readUnionMemberNodes(keyNode, checker)) {
    const name = propertyNameOfKey(unwrapTypeParentheses(member));
    if (name !== undefined && !keys.has(name)) keys.set(name, keys.size);
  }
  return keys;
}

/**
 * The property name the literal key `key` writes, as the checker names the
 * property a mapped type makes for it: a string as written, a number in its
 * canonical form (`1.0` names `"1"`, `-1` names `"-1"`). Returns `undefined`
 * for any other key.
 */
function propertyNameOfKey(key: ts.TypeNode): string | undefined {
  if (!ts.isLiteralTypeNode(key)) return undefined;
  const { literal } = key;
  if (ts.isStringLiteral(literal)) return literal.text;
  if (ts.isNumericLiteral(literal)) return String(Number(literal.text));
  if (
    ts.isPrefixUnaryExpression(literal) &&
    literal.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(literal.operand)
  ) {
    return String(-Number(literal.operand.text));
  }
  return undefined;
}

/**
 * The type argument `reference` passes for the keys of the mapped type its
 * alias is written as, or `undefined` where the alias is no mapped type, or
 * maps over keys that are not a parameter of its own.
 */
function aliasKeyArgument(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const alias = getTypeAliasDeclaration(reference, checker);
  if (alias === undefined) return undefined;
  const aliased = unwrapTypeParentheses(alias.type);
  if (!ts.isMappedTypeNode(aliased)) return undefined;
  const constraint = aliased.typeParameter.constraint;
  if (
    constraint === undefined || !ts.isTypeReferenceNode(constraint) ||
    !ts.isIdentifier(constraint.typeName)
  ) {
    return undefined;
  }
  const name = constraint.typeName.text;
  const index =
    alias.typeParameters?.findIndex((parameter) =>
      parameter.name.text === name
    ) ?? -1;
  return index < 0 ? undefined : reference.typeArguments?.[index];
}

/**
 * An order on types that reads only what the source states about them, never
 * the order the checker created them in: intrinsic types by name, then
 * literals by kind and value, then declared types (`compareDeclaredTypes()`:
 * by name and declaration, a TS enum's members together, as the enum
 * declares them) — and then every other type. Types the first key leaves
 * equal, as two instantiations of one declaration or two intersections are,
 * are compared by what they are made of (`compareStructure()`).
 *
 * It reads a type's flags, value, symbol, and what the checker gave it when
 * it created it, and nothing the checker would have to resolve or create, as
 * a type's arguments resolved on request or its printed form are: what has
 * been resolved by the time it is asked depends on the rest of the program,
 * so an order read from it would too.
 */
export function compareTypesBySource(left: ts.Type, right: ts.Type): number {
  return compareTypes(left, right, {
    active: new Map(),
    done: new Map(),
    reentries: 0,
  });
}

/**
 * What one `compareTypesBySource()` call has compared of what two types are
 * made of (`compareStructure()`), so that a structure met twice is read
 * once and a recursive one ends.
 */
type Comparison = {
  /** The pairs being compared further up. */
  readonly active: Map<ts.Type, Set<ts.Type>>;
  /** The pairs compared to the end, by the answer. */
  readonly done: Map<ts.Type, Map<ts.Type, number>>;
  /** How many times a pair being compared further up was met again. */
  reentries: number;
};

/** `compareTypesBySource()`, within the comparison `state`. */
function compareTypes(
  left: ts.Type,
  right: ts.Type,
  state: Comparison,
): number {
  if (left === right) return 0;
  const leftTier = tierOf(left);
  const rightTier = tierOf(right);
  if (leftTier !== rightTier) return leftTier - rightTier;
  switch (leftTier) {
    case Tier.Intrinsic:
      return compareStrings(intrinsicName(left), intrinsicName(right));
    case Tier.NumberLiteral:
      return (left as ts.NumberLiteralType).value -
        (right as ts.NumberLiteralType).value;
    case Tier.BigIntLiteral:
      return compareBigInts(
        (left as ts.BigIntLiteralType).value,
        (right as ts.BigIntLiteralType).value,
      );
    case Tier.StringLiteral:
      return compareStrings(
        (left as ts.StringLiteralType).value,
        (right as ts.StringLiteralType).value,
      );
    case Tier.Declared:
      return compareDeclaredTypes(left, right) ||
        compareStructure(left, right, state);
    default:
      return compareStructure(left, right, state);
  }
}

/** The kinds of type `compareStructure()` orders, in its order. */
enum Structure {
  Reference,
  Instantiation,
  Object,
  Intersection,
  Union,
  Other,
}

/** A type mapper as the checker holds it. */
type TypeMapperWithInternals = {
  readonly kind: number;
  readonly target?: ts.Type;
  readonly targets?: readonly ts.Type[];
  readonly mapper1?: TypeMapperWithInternals;
};

/** A type as the checker holds it: what it gave the type on creating it. */
type TypeWithInternals = ts.Type & {
  readonly target?: ts.Type & {
    readonly symbol?: ts.Symbol;
    readonly fixedLength?: number;
    readonly elementFlags?: readonly number[];
  };
  readonly node?: ts.Node;
  readonly mapper?: TypeMapperWithInternals;
  readonly resolvedTypeArguments?: readonly ts.Type[];
  readonly types?: readonly ts.Type[];
};

/** A property's symbol as the checker holds it: the type it was given. */
type SymbolWithInternals = ts.Symbol & {
  readonly links?: { readonly type?: ts.Type };
};

/**
 * Compares two types `compareTypes()` leaves equal by what they are made of,
 * read only where the checker gave it to them on creating them: an alias's
 * instantiations by their alias arguments; a reference by its target, a
 * tuple's arity and element kinds, and its arguments, those of a deferred
 * reference, which are resolved only when something asks for them, by the
 * node writing it and what instantiated it; an instantiation of an object
 * type a source declares, as a generic function's return type is, by what
 * instantiated it (`instantiationArguments()`); an intersection or a union
 * by its members; and an object no source declares, as the checker builds
 * for a spread, by its properties' names and then their types.
 *
 * Each part is compared by `compareTypes()` in `state`, however deep: a pair
 * met again inside its own comparison is equal so far, which ends a
 * recursive structure, and a pair compared to the end without meeting one
 * is answered from `state.done` after, which keeps a structure that shares
 * its parts from being read once per path to them.
 */
function compareStructure(
  left: ts.Type,
  right: ts.Type,
  state: Comparison,
): number {
  if (state.active.get(left)?.has(right)) {
    state.reentries++;
    return 0;
  }
  const known = state.done.get(left)?.get(right);
  if (known !== undefined) return known;
  let active = state.active.get(left);
  if (active === undefined) state.active.set(left, active = new Set());
  active.add(right);
  const reentriesBefore = state.reentries;
  const answer = compareStructureOnce(left, right, state);
  active.delete(right);
  if (state.reentries === reentriesBefore) {
    let done = state.done.get(left);
    if (done === undefined) state.done.set(left, done = new Map());
    done.set(right, answer);
  }
  return answer;
}

/** `compareStructure()` for a pair not met before in `state`. */
function compareStructureOnce(
  left: ts.Type,
  right: ts.Type,
  state: Comparison,
): number {
  const byAlias = compareAliases(left, right, state);
  if (byAlias !== 0) return byAlias;
  const leftKind = structureOf(left);
  const rightKind = structureOf(right);
  if (leftKind !== rightKind) return leftKind - rightKind;
  const l = left as TypeWithInternals;
  const r = right as TypeWithInternals;
  switch (leftKind) {
    case Structure.Reference:
      return compareReferences(l, r, state);
    case Structure.Instantiation:
      return compareTypeLists(
        instantiationArguments(l) ?? [],
        instantiationArguments(r) ?? [],
        state,
      );
    case Structure.Intersection:
      return compareTypeLists(l.types ?? [], r.types ?? [], state);
    case Structure.Union:
      return compareTypeLists(
        sortedTypes(l.types ?? [], state),
        sortedTypes(r.types ?? [], state),
        state,
      );
    case Structure.Object:
      return compareUndeclaredObjects(left, right, state);
    default:
      return 0;
  }
}

/**
 * The type arguments the checker instantiated `type` with, as the mapper it
 * gave the instantiation holds them: the arguments for its declaration's
 * outer type parameters, in their order, which the checker builds afresh
 * for each instantiation, so they do not depend on how the instantiation
 * was reached. A mapper that composes another reads the one it starts from,
 * which is that one. Returns `undefined` for a type with no such mapper.
 */
function instantiationArguments(
  type: TypeWithInternals,
): readonly ts.Type[] | undefined {
  let mapper = type.mapper;
  while (mapper?.mapper1 !== undefined) mapper = mapper.mapper1;
  if (mapper === undefined) return undefined;
  if (mapper.target !== undefined) return [mapper.target];
  return mapper.targets;
}

/**
 * Compares two types by the alias each is an instantiation of, where either
 * is one: one that is before one that is not, two of different aliases by
 * the aliases' names and declarations, and two of one alias by its
 * arguments.
 */
function compareAliases(
  left: ts.Type,
  right: ts.Type,
  state: Comparison,
): number {
  const leftAlias = left.aliasSymbol;
  const rightAlias = right.aliasSymbol;
  if (leftAlias === undefined || rightAlias === undefined) {
    return Number(leftAlias === undefined) - Number(rightAlias === undefined);
  }
  if (leftAlias !== rightAlias) {
    const leftAt = declarationPlace(leftAlias.declarations?.[0]);
    const rightAt = declarationPlace(rightAlias.declarations?.[0]);
    return compareStrings(leftAlias.getName(), rightAlias.getName()) ||
      compareStrings(leftAt?.file ?? "", rightAt?.file ?? "") ||
      (leftAt?.pos ?? 0) - (rightAt?.pos ?? 0);
  }
  return compareTypeLists(
    left.aliasTypeArguments ?? [],
    right.aliasTypeArguments ?? [],
    state,
  );
}

/** The kind of type `compareStructure()` takes `type` for. */
function structureOf(type: ts.Type): Structure {
  if (type.flags & ts.TypeFlags.Intersection) return Structure.Intersection;
  if (type.flags & ts.TypeFlags.Union) return Structure.Union;
  if (type.flags & ts.TypeFlags.Object) {
    const objectFlags = (type as ts.ObjectType).objectFlags;
    if (objectFlags & ts.ObjectFlags.Reference) return Structure.Reference;
    const instantiated = (type as TypeWithInternals).mapper !== undefined;
    if (
      instantiated && (objectFlags & ts.ObjectFlags.Mapped) === 0 &&
      instantiationArguments(type as TypeWithInternals) !== undefined
    ) {
      return Structure.Instantiation;
    }
    const declared = (type.getSymbol()?.declarations?.length ?? 0) > 0;
    if (!declared && !instantiated) return Structure.Object;
  }
  return Structure.Other;
}

/**
 * Compares two references by their targets' names and declarations, a
 * tuple's arity and element kinds, and then their arguments: a deferred
 * reference's by the node writing it and what instantiated it
 * (`instantiationArguments()`), any other's as the checker gave them.
 */
function compareReferences(
  left: TypeWithInternals,
  right: TypeWithInternals,
  state: Comparison,
): number {
  const leftTarget = left.target;
  const rightTarget = right.target;
  const leftAt = declarationPlace(leftTarget?.symbol?.declarations?.[0]);
  const rightAt = declarationPlace(rightTarget?.symbol?.declarations?.[0]);
  const byTarget = compareStrings(
    leftTarget?.symbol?.getName() ?? "",
    rightTarget?.symbol?.getName() ?? "",
  ) ||
    compareStrings(leftAt?.file ?? "", rightAt?.file ?? "") ||
    (leftAt?.pos ?? 0) - (rightAt?.pos ?? 0) ||
    (leftTarget?.fixedLength ?? -1) - (rightTarget?.fixedLength ?? -1) ||
    compareNumberLists(
      leftTarget?.elementFlags ?? [],
      rightTarget?.elementFlags ?? [],
    );
  if (byTarget !== 0) return byTarget;
  if (left.node !== undefined || right.node !== undefined) {
    const leftNode = declarationPlace(left.node as ts.Declaration | undefined);
    const rightNode = declarationPlace(
      right.node as ts.Declaration | undefined,
    );
    return compareStrings(leftNode?.file ?? "", rightNode?.file ?? "") ||
      (leftNode?.pos ?? -1) - (rightNode?.pos ?? -1) ||
      compareTypeLists(
        instantiationArguments(left) ?? [],
        instantiationArguments(right) ?? [],
        state,
      );
  }
  return compareTypeLists(
    left.resolvedTypeArguments ?? [],
    right.resolvedTypeArguments ?? [],
    state,
  );
}

/**
 * Compares two objects no source declares and the checker did not
 * instantiate, so built whole, by their properties' names in the order they
 * are listed, and then by the types the checker gave those properties, where
 * it gave them one on building them.
 */
function compareUndeclaredObjects(
  left: ts.Type,
  right: ts.Type,
  state: Comparison,
): number {
  const leftProperties = left.getProperties();
  const rightProperties = right.getProperties();
  const byNames = compareStringLists(
    leftProperties.map((property) => property.getName()),
    rightProperties.map((property) => property.getName()),
  );
  if (byNames !== 0) return byNames;
  for (let index = 0; index < leftProperties.length; index++) {
    const leftType = (leftProperties[index] as SymbolWithInternals).links?.type;
    const rightType = (rightProperties[index] as SymbolWithInternals).links
      ?.type;
    if (leftType === undefined || rightType === undefined) continue;
    const byType = compareTypes(leftType, rightType, state);
    if (byType !== 0) return byType;
  }
  return 0;
}

/** `types` in the order `compareTypes()` gives them in `state`. */
function sortedTypes(types: readonly ts.Type[], state: Comparison): ts.Type[] {
  return [...types].sort((left, right) => compareTypes(left, right, state));
}

/** Compares two lists of types member by member, a shorter one first. */
function compareTypeLists(
  left: readonly ts.Type[],
  right: readonly ts.Type[],
  state: Comparison,
): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const byMember = compareTypes(left[index]!, right[index]!, state);
    if (byMember !== 0) return byMember;
  }
  return left.length - right.length;
}

/** Compares two lists of strings member by member, a shorter one first. */
function compareStringLists(
  left: readonly string[],
  right: readonly string[],
): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const byMember = compareStrings(left[index]!, right[index]!);
    if (byMember !== 0) return byMember;
  }
  return left.length - right.length;
}

/** Compares two lists of numbers member by member, a shorter one first. */
function compareNumberLists(
  left: readonly number[],
  right: readonly number[],
): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const byMember = left[index]! - right[index]!;
    if (byMember !== 0) return byMember;
  }
  return left.length - right.length;
}

/** The tiers `compareTypesBySource()` orders types into, in its order. */
enum Tier {
  Intrinsic,
  NumberLiteral,
  BigIntLiteral,
  StringLiteral,
  Declared,
  Other,
}

/** The tier of `compareTypesBySource()` that `type` falls in. */
function tierOf(type: ts.Type): Tier {
  const { flags } = type;
  if (isIntrinsic(type)) return Tier.Intrinsic;
  // A TS enum's member is ordered by where its enum declares it.
  if (flags & ts.TypeFlags.EnumLiteral) return Tier.Declared;
  if (flags & ts.TypeFlags.NumberLiteral) return Tier.NumberLiteral;
  if (flags & ts.TypeFlags.BigIntLiteral) return Tier.BigIntLiteral;
  if (flags & ts.TypeFlags.StringLiteral) return Tier.StringLiteral;
  if ((type.getSymbol()?.declarations?.length ?? 0) > 0) return Tier.Declared;
  return Tier.Other;
}

/**
 * Compares two types the source declares, by one key for every pair, so the
 * order is transitive: the group a type belongs to, by the group's name and
 * then where it is declared, and then where in its group the type is
 * declared. A TS enum's member belongs to its enum, so one enum's members
 * stay together in the order the enum declares them; any other declared
 * type is a group of its own, its symbol's.
 */
function compareDeclaredTypes(left: ts.Type, right: ts.Type): number {
  const leftKey = declaredKey(left);
  const rightKey = declaredKey(right);
  return compareStrings(leftKey.name, rightKey.name) ||
    compareStrings(leftKey.file, rightKey.file) ||
    leftKey.pos - rightKey.pos ||
    leftKey.memberPos - rightKey.memberPos;
}

/**
 * The key `compareDeclaredTypes()` orders a declared type by: its group's
 * name, file and position, and the type's position in the group (`0` for a
 * type that is its own group).
 */
function declaredKey(
  type: ts.Type,
): { name: string; file: string; pos: number; memberPos: number } {
  const symbol = type.getSymbol()!;
  const declaration = symbol.declarations?.[0];
  if (
    (type.flags & ts.TypeFlags.EnumLiteral) !== 0 &&
    declaration !== undefined && ts.isEnumMember(declaration)
  ) {
    const owner = declaration.parent;
    const at = declarationPlace(owner);
    return {
      name: owner.name.text,
      file: at?.file ?? "",
      pos: at?.pos ?? 0,
      memberPos: declaration.pos,
    };
  }
  const at = declarationPlace(declaration);
  return {
    name: symbol.getName(),
    file: at?.file ?? "",
    pos: at?.pos ?? 0,
    memberPos: 0,
  };
}

/**
 * Compares two properties by where they are first declared, in the order the
 * checker lists one declaration's members in: by file, then the members it
 * binds first before those it binds late (`isLateBound()`), each by
 * position; then by name. A property with no declaration comes after one
 * with any.
 */
function compareByDeclaration(left: ts.Symbol, right: ts.Symbol): number {
  const leftDeclaration = left.declarations?.[0];
  const rightDeclaration = right.declarations?.[0];
  const leftAt = declarationPlace(leftDeclaration);
  const rightAt = declarationPlace(rightDeclaration);
  if (leftAt === undefined || rightAt === undefined) {
    if (leftAt !== rightAt) return leftAt === undefined ? 1 : -1;
    return compareStrings(left.getName(), right.getName());
  }
  return compareStrings(leftAt.file, rightAt.file) ||
    Number(isLateBound(leftDeclaration!)) -
      Number(isLateBound(rightDeclaration!)) ||
    leftAt.pos - rightAt.pos ||
    compareStrings(left.getName(), right.getName());
}

/**
 * Whether the checker binds `declaration`'s member after the declaration's
 * other members: a member of an interface, a class, or a type literal named
 * by a computed expression. An object literal's members are bound in the
 * order they are written, computed ones included.
 */
function isLateBound(declaration: ts.Declaration): boolean {
  const name = ts.getNameOfDeclaration(declaration);
  return name !== undefined && ts.isComputedPropertyName(name) &&
    !ts.isObjectLiteralExpression(declaration.parent);
}

/** Where `declaration` sits: its file's name and its position in it. */
function declarationPlace(
  declaration: ts.Declaration | undefined,
): { file: string; pos: number } | undefined {
  if (declaration === undefined) return undefined;
  return { file: declaration.getSourceFile().fileName, pos: declaration.pos };
}

/**
 * Whether `type` is one of the checker's intrinsic types, which it creates
 * before reading any source, in the same order in every program.
 */
function isIntrinsic(type: ts.Type): boolean {
  return intrinsicName(type) !== "";
}

/** The checker's name for an intrinsic type, or `""` for any other type. */
function intrinsicName(type: ts.Type): string {
  return (type as { intrinsicName?: string }).intrinsicName ?? "";
}

/** Compares two strings by their UTF-16 code units, as `<` does. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares two bigint literal values. */
function compareBigInts(
  left: ts.PseudoBigInt,
  right: ts.PseudoBigInt,
): number {
  const leftValue = BigInt(`${left.negative ? "-" : ""}${left.base10Value}`);
  const rightValue = BigInt(`${right.negative ? "-" : ""}${right.base10Value}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
