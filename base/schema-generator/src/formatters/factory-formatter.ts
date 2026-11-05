import ts from "typescript";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { getCellWrapperInfo } from "../typescript/cell-brand.ts";
import { isCommonFabricSymbol } from "../typescript/common-fabric-symbols.ts";
import type { TypeWithInternals } from "../type-utils.ts";

export type FactoryTypeKind = "pattern" | "module" | "handler";

export interface FactoryTypeInfo {
  readonly type: ts.Type;
  readonly kind: FactoryTypeKind;
  readonly inputType: ts.Type;
  readonly outputType: ts.Type;
}

interface HintedFactoryContract {
  readonly kind: FactoryTypeKind;
  readonly inputTypeNode: ts.TypeNode;
  readonly inputType?: ts.Type;
  readonly inputSchema?: unknown;
  readonly outputTypeNode: ts.TypeNode;
  readonly outputType?: ts.Type;
  readonly outputSchema?: unknown;
}

const FACTORY_ALIAS_KINDS: Readonly<Record<string, FactoryTypeKind>> = {
  PatternFactory: "pattern",
  ModuleFactory: "module",
  HandlerFactory: "handler",
};

function hasFabricFactoryBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return checker.getPropertiesOfType(type).some((property) =>
    property.getName().startsWith("__@FABRIC_FACTORY_TYPE") &&
    isCommonFabricSymbol(property, checker)
  );
}

function hasProperty(
  type: ts.Type,
  checker: ts.TypeChecker,
  name: string,
): boolean {
  return checker.getPropertyOfType(type, name) !== undefined;
}

function detectFactoryKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeKind | undefined {
  // A union remains a stored union. UnionFormatter must retain every arm as
  // `anyOf`; invocation compatibility is a transformer concern.
  if ((type.flags & ts.TypeFlags.Union) !== 0) return undefined;

  const aliasName = (type as TypeWithInternals).aliasSymbol?.name;
  const namedKind = aliasName === undefined
    ? undefined
    : FACTORY_ALIAS_KINDS[aliasName];

  // Direct public aliases are authoritative. Alias and branded-intersection
  // spellings lose the public alias name, so recognize those by the private
  // FabricFactory brand plus the stable public factory surface.
  if (
    namedKind !== undefined &&
    (type as TypeWithInternals).aliasSymbol !== undefined &&
    isCommonFabricSymbol((type as TypeWithInternals).aliasSymbol!, checker)
  ) {
    return namedKind;
  }
  if (!hasFabricFactoryBrand(type, checker)) {
    return undefined;
  }

  if (
    hasProperty(type, checker, "argumentSchema") &&
    hasProperty(type, checker, "resultSchema")
  ) {
    return "pattern";
  }
  if (hasProperty(type, checker, "with")) return "handler";
  if (hasProperty(type, checker, "type")) return "module";
  return undefined;
}

function unwrapFactoryInput(type: ts.Type): ts.Type {
  const alias = type as TypeWithInternals;
  if (
    alias.aliasSymbol?.name === "FactoryInput" &&
    alias.aliasTypeArguments?.[0]
  ) {
    return alias.aliasTypeArguments[0];
  }
  return type;
}

function unwrapHandlerEvent(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const wrapper = getCellWrapperInfo(type, checker);
  if (wrapper?.kind !== "Stream") return undefined;
  const args = wrapper.typeRef.typeArguments ??
    checker.getTypeArguments(wrapper.typeRef);
  return args[0];
}

/**
 * Detect only a factory whose alias or private brand comes from Common Fabric.
 * Transformer, schema-writer, and runtime-authority decisions must use this
 * form. Compiler-owned synthetic contracts bypass name matching through
 * explicit schema hints instead.
 */
export function detectTrustedFactoryType(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeInfo | undefined {
  return detectFactoryTypeInternal(type, checker);
}

function detectFactoryTypeInternal(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeInfo | undefined {
  const kind = detectFactoryKind(type, checker);
  if (kind === undefined) return undefined;

  const signature = type.getCallSignatures()[0];
  const parameter = signature?.parameters[0];
  if (!signature || !parameter) return undefined;

  const inputType = unwrapFactoryInput(checker.getTypeOfSymbol(parameter));
  const callResult = signature.getReturnType();
  const outputType = kind === "handler"
    ? unwrapHandlerEvent(callResult, checker)
    : callResult;
  if (!outputType) return undefined;

  return { type, kind, inputType, outputType };
}

/** True when a stored value type is a factory or a union containing one. */
export function containsFactoryType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) =>
      containsFactoryType(member, checker)
    );
  }
  return detectTrustedFactoryType(type, checker) !== undefined;
}

/** True when a type node or one of its descendants carries a factory contract. */
export function typeNodeContainsFactoryContractHint(
  typeNode: ts.Node,
  context: GenerationContext,
): boolean {
  const hint = context.schemaHints?.get(typeNode) ??
    context.schemaHints?.get(ts.getOriginalNode(typeNode));
  if (hint?.factoryContracts?.length) return true;
  let found = false;
  ts.forEachChild(typeNode, (child) => {
    if (!found && typeNodeContainsFactoryContractHint(child, context)) {
      found = true;
    }
  });
  return found;
}

/** Formats PatternFactory, ModuleFactory, and HandlerFactory values. */
export class FactoryFormatter implements TypeFormatter {
  constructor(private readonly schemaGenerator: SchemaGenerator) {}

  private hintedFactories(
    context: GenerationContext,
  ): readonly HintedFactoryContract[] | undefined {
    const typeNode = context.typeNode ?? context.hintsNode;
    if (!typeNode || !context.schemaHints) return undefined;
    const hint = context.schemaHints.get(typeNode) ??
      context.schemaHints.get(ts.getOriginalNode(typeNode));
    return hint?.factoryContracts;
  }

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return (this.hintedFactories(context)?.length ?? 0) > 0 ||
      detectTrustedFactoryType(type, context.typeChecker) !== undefined;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): MutableJSONSchema {
    const hints = this.hintedFactories(context);
    const detected = detectTrustedFactoryType(type, context.typeChecker);
    if ((!hints || hints.length === 0) && !detected) {
      throw new Error("FactoryFormatter received a non-factory type");
    }

    const alternatives = hints?.length
      ? hints.map((hint) => this.formatContract(context, hint))
      : [this.formatDetected(context, detected!)];
    return alternatives.length === 1
      ? alternatives[0]!
      : { anyOf: alternatives };
  }

  private formatContract(
    context: GenerationContext,
    hint: HintedFactoryContract,
  ): MutableJSONSchemaObj {
    // Each carried public schema is an independently comparable document.
    // Generate it in a fresh schema context so any $ref has its own $defs
    // rather than borrowing definitions from the containing value schema.
    const inputSchema = hint.inputSchema !== undefined
      ? hint.inputSchema as MutableJSONSchema
      : this.schemaGenerator.generateHintedFactoryContractSchema(
        hint.inputTypeNode,
        hint.inputType,
        context.typeChecker,
        context.typeRegistry,
        context.schemaHints,
        context.sourceFile,
      );
    const outputSchema = hint.outputSchema !== undefined
      ? hint.outputSchema as MutableJSONSchema
      : this.schemaGenerator.generateHintedFactoryContractSchema(
        hint.outputTypeNode,
        hint.outputType,
        context.typeChecker,
        context.typeRegistry,
        context.schemaHints,
        context.sourceFile,
      );
    return asFactorySchema(hint.kind, inputSchema, outputSchema);
  }

  private formatDetected(
    context: GenerationContext,
    detected: FactoryTypeInfo,
  ): MutableJSONSchemaObj {
    const formatContractSchema = (type: ts.Type) =>
      this.schemaGenerator.generateFactoryContractSchema(
        type,
        context.typeChecker,
      );
    const inputSchema = formatContractSchema(detected.inputType);
    const outputSchema = formatContractSchema(detected.outputType);
    return asFactorySchema(detected.kind, inputSchema, outputSchema);
  }
}

function asFactorySchema(
  kind: FactoryTypeKind,
  inputSchema: MutableJSONSchema,
  outputSchema: MutableJSONSchema,
): MutableJSONSchemaObj {
  const asFactory = kind === "handler"
    ? {
      kind: "handler" as const,
      contextSchema: inputSchema,
      eventSchema: outputSchema,
    }
    : {
      kind,
      argumentSchema: inputSchema,
      resultSchema: outputSchema,
    };
  return { asFactory } as MutableJSONSchemaObj;
}
