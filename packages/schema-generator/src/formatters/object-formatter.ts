import {
  type MutableJSONSchema,
  type MutableJSONSchemaObj,
} from "@commonfabric/api";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";

import {
  attachDocTags,
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
import {
  getCellWrapperInfo,
  isCellInternalMarkerName,
} from "../typescript/cell-brand.ts";
import {
  isDefaultNodeWithUndefined,
  isOptionalSymbol,
} from "../typescript/property-optionality.ts";
import {
  holdsTypeParameter,
  typeParameterOfType,
  unwrapTypeParentheses,
} from "../typescript/type-node.ts";
import { usesParameterUnreachably } from "../type-parameter-bindings.ts";
import { CFC_CARRIER_PROPERTY } from "./common-fabric-formatter.ts";
import { withIfcLabels } from "../ifc-labels.ts";
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
 * Attach a property's JSDoc description (and its lowered tags) to the schema
 * about to be emitted for it. Both emission paths go through this — the
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
  attachDocTags(schema, text);
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
  if (propName.startsWith("__@")) {
    return true;
  }

  if (isCellInternalMarkerName(propName)) {
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
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  #schemaGenerator: SchemaGenerator;

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

    const props = checker.getPropertiesOfType(type);
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

      if (propDecl) {
        if (
          ts.isMethodSignature(propDecl) || ts.isMethodDeclaration(propDecl)
        ) {
          continue;
        }
        if (
          ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)
        ) {
          if (!propTypeNode && propDecl.type) {
            propTypeNode = propDecl.type as ts.TypeNode;
          }
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
      const resolvedPropType = propTypeNode && context.boundTypeParameters &&
          holdsTypeParameter(
            propTypeNode,
            checker,
            context.boundTypeParameters.arguments,
          ) &&
          !usesParameterUnreachably(propTypeNode, checker)
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
      const generated = this.#schemaGenerator.formatChildType(
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
        boundIndex ? indexNode : undefined,
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
        attachDocTags(apSchema as Record<string, unknown>, foundDocs[0]!);
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
    }
    if (required.length > 0) schema.required = required;

    const labels = carrier &&
      this.#schemaGenerator.labelsCarriedBy(carrier, context);
    return labels
      ? labels.reduce<MutableJSONSchema>(
        (labelled, label) => withIfcLabels(labelled, label),
        schema,
      )
      : schema;
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
