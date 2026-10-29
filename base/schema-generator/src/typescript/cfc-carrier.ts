/**
 * Recognizes the carrier a CFC alias intersects its payload with: a member
 * holding the alias's labels under `__ct_cfc__` and nothing else
 * (`Cfc` in `base/api/cfc.ts`). The checker drops an alias's name where it
 * reduces the alias's type, and then the carrier is all that says a value is
 * labelled.
 */

import ts from "typescript";

/**
 * The member a CFC metadata carrier holds. It is a phantom: no value holds it.
 */
export const CFC_CARRIER_PROPERTY = "__ct_cfc__";

/**
 * The `__ct_cfc__` member of `member` when that is all `member` holds: a CFC
 * metadata carrier, which a CFC alias intersects its payload with.
 */
export const cfcCarrierProperty = (
  member: ts.Type,
): ts.Symbol | undefined => {
  const properties = member.getProperties();
  return properties.length === 1 &&
      properties[0]!.name === CFC_CARRIER_PROPERTY
    ? properties[0]
    : undefined;
};

/**
 * Whether `member`, a member of an intersection, is a CFC carrier: the
 * `__ct_cfc__` member alone (`cfcCarrierProperty()`), or, while the payload is
 * a type parameter, the `CfcTag` conditional the checker defers it as. The
 * deferred tag holds the carrier member and the payload's own `null` and
 * `undefined`, which a caller reads apart from it, and no other part of the
 * value. It is recognized by its alias and by both its branches holding
 * exactly that: the carrier member alone, beside
 * `Extract<T, null | undefined>`.
 */
export const isCfcCarrierMember = (member: ts.Type): boolean => {
  if (cfcCarrierProperty(member)) return true;
  if ((member.flags & ts.TypeFlags.Conditional) === 0) return false;
  const declaration = member.aliasSymbol?.declarations?.find(
    ts.isTypeAliasDeclaration,
  );
  return declaration?.name.text === "CfcTag" &&
    ts.isConditionalTypeNode(declaration.type) &&
    isCarrierBranch(declaration.type.trueType) &&
    isCarrierBranch(declaration.type.falseType);
};

/**
 * Whether `node`, a branch of a `CfcTag`, holds the carrier member alone and
 * the payload's nullish members, and nothing else.
 */
const isCarrierBranch = (node: ts.TypeNode): boolean => {
  const arms = unionArms(node);
  return arms.some(isCarrierLiteral) &&
    arms.every((arm) => isCarrierLiteral(arm) || isNullishExtract(arm));
};

/** The arms of the union `node` writes, inside any parentheses. */
const unionArms = (node: ts.TypeNode): readonly ts.TypeNode[] =>
  ts.isParenthesizedTypeNode(node)
    ? unionArms(node.type)
    : ts.isUnionTypeNode(node)
    ? node.types.flatMap(unionArms)
    : [node];

/** Whether `node` is a type literal writing the `__ct_cfc__` member alone. */
const isCarrierLiteral = (node: ts.TypeNode): boolean =>
  ts.isTypeLiteralNode(node) && node.members.length === 1 &&
  ts.isPropertySignature(node.members[0]!) &&
  ts.isIdentifier(node.members[0]!.name) &&
  node.members[0]!.name.text === CFC_CARRIER_PROPERTY;

/** Whether `node` is `Extract<…, null | undefined>`. */
const isNullishExtract = (node: ts.TypeNode): boolean => {
  if (
    !ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) ||
    node.typeName.text !== "Extract" || node.typeArguments?.length !== 2
  ) {
    return false;
  }
  return unionArms(node.typeArguments[1]!).every((arm) =>
    arm.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(arm) &&
      arm.literal.kind === ts.SyntaxKind.NullKeyword)
  );
};

/**
 * The type of the value `member` holds, given `type`, its type: `type` less
 * the `undefined` that an optional member's `?` adds.
 */
export function memberValueType(
  member: ts.Symbol,
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type {
  if ((member.flags & ts.SymbolFlags.Optional) === 0 || !type.isUnion()) {
    return type;
  }
  // `getNonNullableType` also removes a `null`, which `?` does not add.
  return type.types.some((part) => (part.flags & ts.TypeFlags.Null) !== 0)
    ? type
    : checker.getNonNullableType(type);
}

/**
 * One policy a CFC carrier records: its metadata, and the payload it was
 * written around, where the carrier records one (`CfcStamp` in
 * `base/api/cfc.ts`). A carrier that holds its metadata alone records
 * none.
 */
export type CarrierStamp = {
  readonly meta: ts.Type;
  readonly of: ts.Type | undefined;
};

/** The members a `CfcStamp` holds. */
const STAMP_MEMBER_NAMES: ReadonlySet<string> = new Set(["meta", "of"]);

/** Whether `type` is a `CfcStamp`: an object holding `meta`, and `of` at most besides. */
const isCarrierStamp = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const names = type.getProperties().map((property) => property.name);
  return names.includes("meta") &&
    names.every((name) => STAMP_MEMBER_NAMES.has(name));
};

/**
 * The policies `value`, the type a carrier's `__ct_cfc__` holds, records. An
 * intersection or a mapped type folds several carriers into one, whose value
 * is then the intersection of what each held, and two spreads that may each
 * supply it make it their union; each member is a policy of its own.
 */
export const carrierStamps = (
  value: ts.Type,
  checker: ts.TypeChecker,
): CarrierStamp[] => {
  const parts = value.isIntersection() ||
      (value.isUnion() && value.types.every(isCarrierStamp))
    ? value.types
    : [value];
  return parts.map((part) => {
    if (!isCarrierStamp(part)) return { meta: part, of: undefined };
    const member = (name: string) => {
      const symbol = part.getProperty(name);
      return symbol &&
        memberValueType(symbol, checker.getTypeOfSymbol(symbol), checker);
    };
    // The payload is what the policy was written around, as written: only
    // the `undefined` its optional `?` adds is taken off, since the checker's
    // non-nullable form of a parameter `T` is `T & {}`, which no binding
    // names.
    const ofSymbol = part.getProperty("of");
    const of = ofSymbol && checker.getTypeOfSymbol(ofSymbol);
    const definedOf = of?.isUnion()
      ? of.types.filter((type) => (type.flags & ts.TypeFlags.Undefined) === 0)
      : undefined;
    return {
      meta: member("meta")!,
      of: definedOf?.length === 1 ? definedOf[0] : of,
    };
  });
};
