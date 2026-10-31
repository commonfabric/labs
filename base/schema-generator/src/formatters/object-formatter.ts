import {
  type MutableJSONSchema,
  type MutableJSONSchemaObj,
} from "@commonfabric/api";
import { getLogger } from "@commonfabric/logger";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import ts from "typescript";

import {
  extractDocFromSymbolAndDecls,
  getDeclDocs,
  symbolHasDeprecatedTag,
} from "../doc-utils.ts";
import type {
  BoundTypeArgument,
  BoundTypeParameters,
  GenerationContext,
  TypeFormatter,
} from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  getPropertyNameText,
  instantiatedPropertyType,
  instantiatedValueType,
  isFunctionLike,
  safeGetPropertyType,
} from "../type-utils.ts";
import { getCellWrapperInfo } from "../typescript/cell-brand.ts";
import {
  readWriterPolicy,
  writerPolicyHeldWithin,
} from "../typescript/writer-policy.ts";
import { reportUnreadWriterBinding } from "../writer-binding-diagnostics.ts";
import { isInternalMemberName } from "../typescript/property-name.ts";
import {
  isDefaultNodeWithUndefined,
  isOptionalSymbol,
} from "../typescript/property-optionality.ts";
import { propertiesInSourceOrder } from "../typescript/source-order.ts";
import {
  holdsTypeParameter,
  typeParameterOfType,
  unwrapTypeParentheses,
} from "../typescript/type-node.ts";
import {
  namesOnlyPolicyBindings,
  readBindingAnnotation,
  readDeclaringSymbol,
} from "../typescript/value-annotation.ts";
import { usesParameterUnreachably } from "../type-parameter-bindings.ts";
import { CFC_CARRIER_PROPERTY } from "../typescript/cfc-carrier.ts";
import { writesWrapperErasedByAny } from "./common-fabric-formatter.ts";
import { withIndexKeys, withValueRecordsOf } from "../schema-origins.ts";
import { attachUiContract, getUiContractHint } from "../ui-contract.ts";

const logger = getLogger("schema-generator.object", {
  enabled: true,
  level: "warn",
});

/**
 * A callable property's emission: its wrapper schema, or omission for a
 * callable that returns no supported wrapper.
 */
type CallableProperty =
  | { readonly kind: "wrapper"; readonly schema: MutableJSONSchemaObj }
  | { readonly kind: "omit" };

/**
 * Returns how a callable property is emitted, or `undefined` for a data
 * property. A declared type parameter reads its bound argument when no
 * instantiated property type is available. Calls returning `Stream`, `Cell`
 * or `SqliteDb` carry their wrapper marker; other callables are omitted.
 */
export function classifyCallableProperty(
  type: ts.Type,
  checker: ts.TypeChecker,
  bound?: BoundTypeParameters,
): CallableProperty | undefined {
  const seen = new Set<BoundTypeArgument>();
  while (bound) {
    const parameter = typeParameterOfType(type);
    const argument = parameter && bound.arguments.get(parameter);
    if (!argument || seen.has(argument)) break;
    seen.add(argument);
    type = argument.type;
    bound = argument.bound;
  }
  if (!isFunctionLike(type)) return undefined;
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) return { kind: "omit" };

  const callReturnType = callSignatures[0]!.getReturnType();
  const wrapperInfo = getCellWrapperInfo(callReturnType, checker);
  if (wrapperInfo?.kind === "Stream") {
    return { kind: "wrapper", schema: { asCell: ["stream"] } };
  }
  if (wrapperInfo?.kind === "Cell") {
    return { kind: "wrapper", schema: { asCell: ["cell"] } };
  }
  if (wrapperInfo?.kind === "SqliteDb") {
    return { kind: "wrapper", schema: { asCell: ["sqlite"] } };
  }

  return { kind: "omit" };
}

/**
 * Attach a property's JSDoc description to the schema about to be emitted
 * for it. Both emission paths go through this — the
 * ordinary delegated path and the callable-wrapper early return — so a doc
 * written on a factory-typed verb property survives exactly like one on a
 * data property.
 */
function attachPropertyDoc(
  schema: Record<string, unknown>,
  prop: ts.Symbol,
  propName: string,
  checker: ts.TypeChecker,
): void {
  const { text, all } = extractDocFromSymbolAndDecls(prop, checker);
  if (!text) return;
  const conflicts = all.filter((s) => s && s !== text);
  schema.description = text;
  if (conflicts.length > 0) {
    const comment = typeof schema.$comment === "string"
      ? (schema.$comment as string)
      : undefined;
    schema.$comment = comment
      ? comment
      : "Conflicting docs across declarations; using first";
    // Warning only
    logger.warn(
      "schema-gen",
      () => `JSDoc conflict for property '${propName}'; using first doc`,
    );
  }
}

function typeNodeExplicitlyDeclaresProperty(
  typeNode: ts.TypeNode | undefined,
  propName: string,
  checker?: ts.TypeChecker,
): boolean {
  if (!typeNode) return false;
  const node = unwrapTypeParentheses(typeNode);

  if (ts.isUnionTypeNode(node)) {
    return node.types.some((member) =>
      typeNodeExplicitlyDeclaresProperty(member, propName, checker)
    );
  }

  if (!ts.isTypeLiteralNode(node)) {
    return false;
  }

  return node.members.some((member) =>
    (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
    !!member.name &&
    getPropertyNameText(member.name, checker) === propName
  );
}

function getExplicitPropertyTypeNode(
  typeNode: ts.TypeNode | undefined,
  propName: string,
  checker?: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!typeNode) return undefined;
  const node = unwrapTypeParentheses(typeNode);

  if (ts.isUnionTypeNode(node)) {
    for (const member of node.types) {
      const nested = getExplicitPropertyTypeNode(member, propName, checker);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  if (!ts.isTypeLiteralNode(node)) {
    return undefined;
  }

  for (const member of node.members) {
    if (
      (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
      !!member.name &&
      getPropertyNameText(member.name, checker) === propName
    ) {
      return member.type;
    }
  }

  return undefined;
}

function isExplicitPropertyShapeTypeNode(
  typeNode: ts.TypeNode | undefined,
): boolean {
  if (!typeNode) return false;
  const node = unwrapTypeParentheses(typeNode);

  if (ts.isUnionTypeNode(node)) {
    return node.types.some((member) => isExplicitPropertyShapeTypeNode(member));
  }

  return ts.isTypeLiteralNode(node);
}

function shouldSkipInternalProperty(
  propName: string,
  propDecl: ts.Declaration | undefined,
  context: GenerationContext,
): boolean {
  if (isInternalMemberName(propName)) {
    return true;
  }

  if (!propName.startsWith("__")) {
    return false;
  }

  if (propDecl) {
    return false;
  }

  return !typeNodeExplicitlyDeclaresProperty(
    context.typeNode,
    propName,
    context.typeChecker,
  );
}

/**
 * A mapped type as the checker holds it once it resolves its members:
 * `modifiersType` is `T` in `{ [K in keyof T]: T[K] }`, the type it maps over,
 * and `declaration` is the node that writes it.
 */
type MappedTypeWithInternals = ts.ObjectType & {
  readonly modifiersType?: ts.Type;
  readonly declaration?: ts.MappedTypeNode;
};

/**
 * The annotation `declaration` writes, where it declares a property of a type
 * literal, an interface, or a class.
 */
const annotationOf = (
  declaration: ts.Declaration,
): ts.TypeNode | undefined =>
  ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
    ? declaration.type
    : undefined;

/** Whether `type` is a mapped type, as `Pick<T, K>` is. */
const isMappedType = (type: ts.Type): boolean =>
  ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;

/**
 * The type `type`, a mapped type, maps its property `name` from
 * (`MappedTypeWithInternals`), where it gives `name` the value that type has
 * there: its template is `T[P]`, for `T` that type and `P` its own key, as in
 * `Pick`, `Omit`, `Partial` and `Readonly`, and the property keeps the
 * declarations of the one it maps, as a key an `as` clause renames does not.
 * `undefined` where `type` gives `name` a value of its own, as
 * `{ [P in keyof T]: { v: T[P] } }` does.
 */
const valueSourceOf = (
  type: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): ts.Type | undefined => {
  const kept = checker.getPropertyOfType(type, name)?.declarations;
  const { declaration, modifiersType } = type as MappedTypeWithInternals;
  const template = declaration?.type && unwrapTypeParentheses(declaration.type);
  const constraint = declaration?.typeParameter.constraint;
  if (
    !kept?.length || !template || !constraint ||
    !ts.isIndexedAccessTypeNode(template) ||
    !ts.isTypeReferenceNode(template.indexType) ||
    template.indexType.typeArguments ||
    checker.getSymbolAtLocation(template.indexType.typeName) !==
      checker.getSymbolAtLocation(declaration.typeParameter.name)
  ) {
    return undefined;
  }
  // `Pick` maps `K`, a parameter whose constraint is `keyof T`.
  let keys: ts.Type | undefined = checker.getTypeFromTypeNode(constraint);
  if ((keys.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const declared = keys.symbol?.declarations?.find(
      ts.isTypeParameterDeclaration,
    )?.constraint;
    keys = declared && checker.getTypeFromTypeNode(declared);
  }
  return keys !== undefined && (keys.flags & ts.TypeFlags.Index) !== 0 &&
      (keys as ts.IndexType).type ===
        checker.getTypeFromTypeNode(template.objectType)
    ? modifiersType
    : undefined;
};

/**
 * Whether every mapped type between `source` and the declarations of its
 * property `name` gives it the value it is declared with (`valueSourceOf()`),
 * so that those declarations state its value, following each member of a
 * union or an intersection that declares it.
 */
const valueDeclaredWithin = (
  source: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): boolean => {
  if (source.isUnionOrIntersection()) {
    return source.types.every((part) =>
      checker.getPropertyOfType(part, name) === undefined ||
      valueDeclaredWithin(part, name, checker)
    );
  }
  if (!isMappedType(source)) return true;
  const from = valueSourceOf(source, name, checker);
  return from !== undefined && valueDeclaredWithin(from, name, checker);
};

/**
 * Refuses `prop`, a property a mapped type gives a value of its own
 * (`valueDeclaredWithin()`), where a declaration it keeps writes a wrapper
 * the checker erases around `any` (`writesWrapperErasedByAny()`), as
 * `Confidential<any, C>` is: the property is read by its type, which does not
 * hold that wrapper, so its label, scope, or default would be lost.
 */
const refuseWrapperLeftBehind = (
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): void => {
  for (const declaration of prop.declarations ?? []) {
    const annotation = annotationOf(declaration);
    if (
      annotation &&
      (checker.getTypeFromTypeNode(annotation).flags & ts.TypeFlags.Any) !==
        0 &&
      writesWrapperErasedByAny(annotation, checker)
    ) {
      const name = prop.getName();
      throw new Error(
        `A mapped type gives \`${name}\` a value of its own, but ` +
          `\`${name}\` is declared as \`${annotation.getText()}\`, a wrapper ` +
          `around \`any\` that only its declaration holds, which that value ` +
          `does not keep. Map \`${name}\` to the value it is declared with, ` +
          `as \`T[K]\` does, or declare it without \`any\`.`,
      );
    }
  }
};

/**
 * What the annotations of a property several members of a type declare say
 * (`membersAnnotation()`): `node`, those written without a type parameter,
 * combined as the type combines its members, `undefined` where there are
 * none, and `generic`, the type each member whose annotation is written in a
 * type parameter gives the property.
 */
type MembersAnnotation = {
  readonly node: ts.TypeNode | undefined;
  readonly generic: readonly ts.Type[];
};

/**
 * The annotations the members of `source` that declare the property `name`
 * write it with (`MembersAnnotation`), combined as `source` combines those
 * members: a union of a union's, an intersection of an intersection's, and,
 * through a mapped type giving it the value it is declared with
 * (`valueSourceOf()`), those of the type it maps from. An annotation written
 * in a type parameter is read only under the bindings of its member's own
 * reading, which this one does not have, so the type its member gives the
 * property is kept instead. `undefined` where a member declares the property
 * with no annotation, or a mapped type gives it a value of its own.
 */
const membersAnnotation = (
  source: ts.Type,
  name: string,
  checker: ts.TypeChecker,
): MembersAnnotation | undefined => {
  if (source.isUnionOrIntersection()) {
    const nodes: ts.TypeNode[] = [];
    const generic: ts.Type[] = [];
    for (const part of source.types) {
      if (checker.getPropertyOfType(part, name) === undefined) continue;
      const read = membersAnnotation(part, name, checker);
      if (read === undefined) return undefined;
      if (read.node !== undefined) nodes.push(read.node);
      for (const member of read.generic) generic.push(member);
    }
    return {
      node: nodes.length <= 1
        ? nodes[0]
        : source.isUnion()
        ? ts.factory.createUnionTypeNode(nodes)
        : ts.factory.createIntersectionTypeNode(nodes),
      generic,
    };
  }
  if (isMappedType(source)) {
    const from = valueSourceOf(source, name, checker);
    return from && membersAnnotation(from, name, checker);
  }
  const prop = checker.getPropertyOfType(source, name);
  const declarations = prop?.declarations ?? [];
  const declaration = prop?.valueDeclaration ??
    (declarations.length === 1 ? declarations[0] : undefined);
  const node = declaration && annotationOf(declaration);
  if (prop === undefined || node === undefined) return undefined;
  return holdsTypeParameter(node, checker)
    ? { node: undefined, generic: [checker.getTypeOfSymbol(prop)] }
    : { node, generic: [] };
};

/**
 * Whether `type` is a primitive type, or a union of them, which holds no
 * label: a labeled one intersects a carrier.
 */
const holdsNoLabel = (type: ts.Type): boolean =>
  type.isUnion() ? type.types.every(holdsNoLabel) : (type.flags &
    (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike |
      ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike |
      ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null |
      ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

  /**
   * The annotation read for each property several members of a type declare
   * (`#annotationOfMembers()`), kept so every read of the property reads the
   * same node.
   */
  #membersAnnotations = new WeakMap<ts.Symbol, ts.TypeNode | undefined>();

  constructor(schemaGenerator: SchemaGenerator) {
    this.#schemaGenerator = schemaGenerator;
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Handle object types (interfaces, type literals, classes)
    const flags = type.flags;
    if ((flags & ts.TypeFlags.Object) !== 0) return true;
    // Also claim the exact TypeScript `object` type via string check.
    return context.typeChecker.typeToString(type) === "object";
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const checker = context.typeChecker;

    // If this is the TS `object` type (unknown object shape), emit a permissive
    // object schema instead of attempting to enumerate properties.
    // This avoids false "no formatter" errors for unions containing `object`.
    const typeName = checker.typeToString(type);
    if (typeName === "object") {
      return { type: "object", additionalProperties: true };
    }

    const builtin = this.#lookupBuiltInSchema(type, checker);
    if (builtin) return builtin;

    // Do not early-return for empty object types. Instead, try to enumerate
    // properties via the checker to allow type literals to surface members.

    const properties: Record<string, MutableJSONSchema> = {};
    const required: string[] = [];
    const shouldRespectExplicitPropertyShape = isExplicitPropertyShapeTypeNode(
      context.typeNode,
    );

    const props = propertiesInSourceOrder(
      type,
      checker.getPropertiesOfType(type),
      context.typeNode,
      checker,
    );
    // A CFC metadata carrier a mapped type folded into the object is a
    // label, not a member: no value holds it.
    let carrier: ts.Symbol | undefined;
    for (const prop of props) {
      const propName = prop.getName();
      if (propName === CFC_CARRIER_PROPERTY) {
        carrier = prop;
        continue;
      }

      let propTypeNode = getExplicitPropertyTypeNode(
        context.typeNode,
        propName,
        checker,
      );
      const propDecl = prop.valueDeclaration ??
        (prop.declarations?.[0] as ts.Declaration | undefined);
      // A mapped type's property has no declaration of its own: it keeps
      // those of the property it maps, which state its value only where every
      // mapping between them copies it (`valueDeclaredWithin()`). One given a
      // value of its own is read by its type.
      const declaresValue = !isMappedType(type) ||
        valueDeclaredWithin(type, propName, checker);
      if (!declaresValue) refuseWrapperLeftBehind(prop, checker);
      // A property several members of a union or an intersection declare, as
      // a `Pick` or an `Omit` over one makes, is never read by one member's
      // annotation, which says what it is in that member alone: it is read by
      // every member's (`#annotationOfMembers()`), or else by the type the
      // checker gives it, which is all of them.
      const annotated = declaresValue &&
        (prop.valueDeclaration !== undefined ||
          prop.declarations?.length === 1);
      propTypeNode ??= declaresValue && !annotated
        ? this.#annotationOfMembers(prop, type, checker)
        : undefined;

      if (propDecl) {
        if (
          ts.isMethodSignature(propDecl) || ts.isMethodDeclaration(propDecl)
        ) {
          continue;
        }
        if (
          ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)
        ) {
          if (!propTypeNode && annotated && propDecl.type) {
            propTypeNode = propDecl.type as ts.TypeNode;
          }
        } else if (
          !propTypeNode && annotated &&
          (ts.isPropertyAssignment(propDecl) ||
            ts.isShorthandPropertyAssignment(propDecl))
        ) {
          // An object literal's member writes no annotation, and the value it
          // is written from may be one only syntax spells, such as a
          // `PolicyOf<typeof rules>` label. It is read at the annotation of
          // the binding it reads, where that annotation names a value binding
          // and denotes the member's type (`readBindingAnnotation()`). An
          // annotation that names a writer leaves the value read from its
          // type: this object views the document that stores the writer's
          // policy, and reads that policy in part
          // (`GenerationContext.definesDocument`).
          const annotation = readBindingAnnotation(
            readDeclaringSymbol(
              ts.isPropertyAssignment(propDecl)
                ? propDecl.initializer
                : propDecl.name,
              checker,
            ),
            checker.getTypeOfSymbol(prop),
            checker,
          );
          propTypeNode = annotation &&
              namesOnlyPolicyBindings(annotation, checker)
            ? annotation
            : undefined;
        }
      }

      if (shouldSkipInternalProperty(propName, propDecl, context)) {
        continue;
      }

      if (
        shouldRespectExplicitPropertyShape &&
        !typeNodeExplicitlyDeclaresProperty(context.typeNode, propName, checker)
      ) {
        continue;
      }

      if ((prop.flags & ts.SymbolFlags.Method) !== 0) continue;

      const instantiatedPropType = instantiatedPropertyType(
        context.instantiatedAs,
        propName,
        checker,
      );
      // Get the actual property type and recursively delegate to the main schema generator
      const readsBoundNode = propTypeNode && context.boundTypeParameters &&
        holdsTypeParameter(
          propTypeNode,
          checker,
          context.boundTypeParameters.arguments,
        ) &&
        !usesParameterUnreachably(propTypeNode, checker);
      const resolvedPropType = readsBoundNode && propTypeNode
        ? checker.getTypeFromTypeNode(propTypeNode)
        : safeGetPropertyType(prop, type, checker, propTypeNode);

      const callable = classifyCallableProperty(
        instantiatedPropType ?? resolvedPropType,
        checker,
        context.boundTypeParameters,
      );
      if (callable) {
        if (callable.kind === "wrapper") {
          const wrapperSchema = callable.schema;
          if (
            !isOptionalSymbol(prop) &&
            !isDefaultNodeWithUndefined(propTypeNode, checker)
          ) {
            required.push(propName);
          }
          attachDeprecatedStreamMark(wrapperSchema, prop, checker);
          attachPropertyDoc(
            wrapperSchema as Record<string, unknown>,
            prop,
            propName,
            checker,
          );
          properties[propName] = wrapperSchema;
        }
        continue;
      }

      if (
        !isOptionalSymbol(prop) &&
        !isDefaultNodeWithUndefined(propTypeNode, checker)
      ) {
        required.push(propName);
      }

      // Delegate to the main generator (specific formatters handle wrappers/defaults)
      const readsOptionalBound = readsBoundNode && isOptionalSymbol(prop);
      const generated = readsOptionalBound
        ? this.#schemaGenerator.formatOptionalProperty(
          resolvedPropType,
          context,
          propTypeNode!,
          instantiatedPropType,
        )
        : this.#schemaGenerator.formatChildType(
          resolvedPropType,
          context,
          propTypeNode,
          instantiatedPropType,
        );
      if (isObjectOrArray(generated)) {
        attachDeprecatedStreamMark(
          generated as Record<string, unknown>,
          prop,
          checker,
        );
      }
      // Attach property description from JSDoc (if any)
      if (isObjectOrArray(generated)) {
        attachPropertyDoc(
          generated as Record<string, unknown>,
          prop,
          propName,
          checker,
        );
      }
      if (propName === "$UI") {
        const uiContract = getUiContractHint(context, propTypeNode);
        if (uiContract) {
          properties[propName] = attachUiContract(generated, uiContract);
          continue;
        }
      }
      properties[propName] = generated;
    }

    const schema: MutableJSONSchemaObj = { type: "object", properties };

    // Handle string/number index signatures → additionalProperties with description
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const chosenIndex = stringIndex ?? numberIndex;
    if (chosenIndex) {
      const indexNode = checker.getIndexInfoOfType(
        type,
        stringIndex ? ts.IndexKind.String : ts.IndexKind.Number,
      )?.declaration?.type;
      const boundIndex = indexNode && context.boundTypeParameters &&
        holdsTypeParameter(
          indexNode,
          checker,
          context.boundTypeParameters.arguments,
        );
      const readIndex = boundIndex &&
        !usesParameterUnreachably(indexNode, checker);
      const apSchema = this.#schemaGenerator.formatChildType(
        readIndex ? checker.getTypeFromTypeNode(indexNode) : chosenIndex,
        context,
        indexNode,
        instantiatedValueType(context.instantiatedAs, checker),
      );
      // Attempt to read JSDoc from index signature declarations
      const sym = type.getSymbol?.();
      const foundDocs: string[] = [];
      if (sym) {
        for (const decl of sym.declarations ?? []) {
          if (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) {
            for (const member of decl.members) {
              if (ts.isIndexSignatureDeclaration(member)) {
                const docs = getDeclDocs(member);
                for (const d of docs) {
                  if (!foundDocs.includes(d)) foundDocs.push(d);
                }
              }
            }
          }
        }
      }
      if (foundDocs.length > 0 && isObjectOrArray(apSchema)) {
        (apSchema as Record<string, unknown>).description = foundDocs[0]!;
        if (foundDocs.length > 1) {
          const comment = typeof apSchema.$comment === "string"
            ? (apSchema.$comment as string)
            : undefined;
          (apSchema as Record<string, unknown>).$comment = comment
            ? comment
            : "Conflicting docs for index signatures; using first";
          logger.warn(
            "schema-gen",
            () => "JSDoc conflict for index signatures; using first doc",
          );
        }
      }
      (schema as Record<string, unknown>).additionalProperties =
        apSchema as MutableJSONSchemaObj;
      withIndexKeys(schema, stringIndex ? "string" : "number", context);
      // A number index signature beside a string one is lowered as the string
      // one alone, so a writer policy only its values hold is lost. A document
      // stored that way would admit any writer to them. A string side whose
      // reading stopped at a bound is not known to hold one, and a number
      // side whose reading stopped at one may: either way the policy may be
      // lost.
      const lostPolicy =
        context.definesDocument && stringIndex && numberIndex &&
          writerPolicyHeldWithin(stringIndex, checker) === undefined
          ? readWriterPolicy(numberIndex, checker)
          : undefined;
      if (lostPolicy !== undefined) {
        reportUnreadWriterBinding(
          context,
          // A policy past a bound names no alias; the report names the one a
          // single writer's policy is written with.
          lostPolicy === "unread" ? "WriteAuthorizedBy" : lostPolicy,
          "This schema defines a document, which would admit any writer, and " +
            "a number index signature beside a string one is lowered as the " +
            "string one alone, so the writer policy its values hold is lost. " +
            "Declare the policy on the string index signature too.",
        );
      }
    }
    if (required.length > 0) schema.required = required;

    return carrier
      ? withValueRecordsOf(
        this.#schemaGenerator.withLabelsCarriedBy(
          schema,
          type,
          carrier,
          context,
        ),
        schema,
        context,
      )
      : schema;
  }

  /**
   * The annotation of `prop`, a property of `type` that several members of a
   * union or an intersection declare (`membersAnnotation()`). Where some write
   * it in a type parameter, which only its member's own reading binds, the
   * property is read by the type the checker gives it, which holds every
   * member's labels, unless that type is `any`, which holds none. Then the
   * others' annotations are read, where each member written in a type
   * parameter gives the property a primitive type, which holds no label, and
   * the property is refused otherwise.
   */
  #annotationOfMembers(
    prop: ts.Symbol,
    type: ts.Type,
    checker: ts.TypeChecker,
  ): ts.TypeNode | undefined {
    if (this.#membersAnnotations.has(prop)) {
      return this.#membersAnnotations.get(prop);
    }
    const read = membersAnnotation(type, prop.getName(), checker);
    let node = read?.node;
    if (read !== undefined && read.generic.length > 0) {
      if ((checker.getTypeOfSymbol(prop).flags & ts.TypeFlags.Any) === 0) {
        node = undefined;
      } else {
        const labeled = read.generic.find((member) => !holdsNoLabel(member));
        if (labeled !== undefined) {
          const name = prop.getName();
          throw new Error(
            `\`${name}\` is declared by several members of a union or an ` +
              `intersection, one with an annotation written in a type ` +
              `parameter that reads as \`${checker.typeToString(labeled)}\` ` +
              `here, and the checker reads \`${name}\` as \`any\`, which ` +
              `holds no labels. The labels of that annotation cannot be read ` +
              `there unless it reads as a primitive type: declare ` +
              `\`${name}\` in that member without the type parameter, or in ` +
              `the others without \`any\`.`,
          );
        }
      }
    }
    this.#membersAnnotations.set(prop, node);
    return node;
  }

  #lookupBuiltInSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): MutableJSONSchema | undefined {
    const builtin = getNativeTypeSchema(type, checker);
    return builtin === undefined ? undefined : cloneSchemaDefinition(builtin);
  }
}

/**
 * Verb listing mark (WS-F): a stream-valued property whose declaration carries
 * `@deprecated` JSDoc lowers to standard JSON Schema `deprecated: true`.
 * Annotation-class (classified in the piece compat checker), so it adds and
 * removes freely; `cf piece verbs` hides marked verbs by default while
 * `cf piece call` never consults it. Applied only where the property schema is
 * stream-marked — deprecation of non-verb data is out of this mark's scope.
 */
function attachDeprecatedStreamMark(
  schema: Record<string, unknown>,
  prop: ts.Symbol,
  checker: ts.TypeChecker,
): void {
  const asCell = schema.asCell;
  const isStream = Array.isArray(asCell) && asCell.includes("stream");
  if (!isStream) return;
  if (symbolHasDeprecatedTag(prop, checker)) {
    schema.deprecated = true;
  }
}
