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
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  getPropertyNameText,
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
import { unwrapTypeParentheses } from "../typescript/type-node.ts";
import { attachUiContract, getUiContractHint } from "../ui-contract.ts";

const logger = getLogger("schema-generator.object", {
  enabled: true,
  level: "warn",
});

/**
 * Check if a callable type (like ModuleFactory or HandlerFactory) returns a wrapper type.
 * ModuleFactory<T, R> when called returns Reactive<R>.
 * If R is Stream<T>, we should generate { asCell: ["stream"] } instead of skipping.
 * If R is Cell<T>, we should generate { asCell: ["cell"] } instead of skipping.
 *
 * Returns the schema definition for the wrapper if detected, undefined otherwise.
 */
export function getWrapperSchemaFromCallable(
  type: ts.Type,
  checker: ts.TypeChecker,
): MutableJSONSchemaObj | undefined {
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) return undefined;

  // Get the return type of the first call signature
  const callReturnType = callSignatures[0]!.getReturnType();

  // Check if the return type is a wrapper (Stream<T>, Cell<T>, or Reactive<...>)
  const wrapperInfo = getCellWrapperInfo(callReturnType, checker);
  if (wrapperInfo?.kind === "Stream") {
    return { asCell: ["stream"] };
  }
  if (wrapperInfo?.kind === "Cell") {
    return { asCell: ["cell"] };
  }
  if (wrapperInfo?.kind === "SqliteDb") {
    return { asCell: ["sqlite"] };
  }

  return undefined;
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
 * `FabricExecPlainObject` is used as a compile-time constraint on internal
 * execution graph types. Its inherited index signature does not describe
 * authored data accepted by a pattern, so it must not become a JSON Schema
 * `additionalProperties` declaration. The name is a type alias, so a base
 * declared through it resolves to the aliased type and carries the alias as
 * its alias symbol; that is what identifies it.
 */
function hasFabricExecPlainObjectBase(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;

  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Interface) === 0) return false;

  return (checker.getBaseTypes(type as ts.InterfaceType) ?? []).some((base) =>
    (base.aliasSymbol ?? base.getSymbol())?.getName() ===
      "FabricExecPlainObject"
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
    for (const prop of props) {
      const propName = prop.getName();

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

      // Get the actual property type and recursively delegate to the main schema generator
      const resolvedPropType = safeGetPropertyType(
        prop,
        type,
        checker,
        propTypeNode,
      );

      if (isFunctionLike(resolvedPropType)) {
        // Special case: ModuleFactory/HandlerFactory types that return Stream or Cell
        // should generate { asCell: ["stream"] } or { asCell: ["cell"] } instead of being skipped
        const wrapperSchema = getWrapperSchemaFromCallable(
          resolvedPropType,
          checker,
        );
        if (wrapperSchema) {
          // This is a factory that returns a wrapper type (Stream or Cell)
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
    const chosenIndex = hasFabricExecPlainObjectBase(type, checker)
      ? undefined
      : stringIndex ?? numberIndex;
    if (chosenIndex) {
      const apSchema = this.#schemaGenerator.formatChildType(
        chosenIndex,
        context,
        undefined,
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

    return schema;
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
