import {
  type SchemaGenerationOptions,
  SchemaGenerator,
} from "@commonfabric/schema-generator";
import { numberFromExpression } from "@commonfabric/schema-generator/numeric-expression";
import { isObjectOrArray } from "@commonfabric/utils/types";
import ts from "typescript";
import { resolveWriterBinding } from "@commonfabric/schema-generator/writer-binding";

import {
  getNodeText,
  getTypeFromTypeNodeWithFallback,
  recoverAuthoredPosition,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import {
  CF_HELPERS_IDENTIFIER,
  HelpersOnlyTransformer,
  TransformationContext,
} from "../core/mod.ts";
import {
  unwrapExpression,
  unwrapTransparentWrapperOnce,
} from "../utils/expression.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { normalizeWriterIdentityFile } from "../utils/writer-identity-file.ts";
import { compileCfcPolicyManifestsForSource } from "./cfc-policy-authoring.ts";
import { reportOpaqueReservedResultKeys } from "./reserved-result-keys.ts";

export class SchemaGeneratorTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const schemaGenerator = new SchemaGenerator();
    const { sourceFile, tsContext: transformation, checker } = context;
    const { typeRegistry, schemaHints } = context.state;
    const writerIdentityForSourceFile = (fileName: string) => {
      const moduleIdentities = context.options.moduleIdentities;
      const moduleIdentity = moduleIdentities?.get(fileName);
      if (moduleIdentities && moduleIdentity === undefined) {
        throw new Error(
          `Cannot mint WriteAuthorizedBy claim: no module identity for defining source '${fileName}'`,
        );
      }
      return {
        file: normalizeWriterIdentityFile(
          fileName,
          context.options.canonicalWriterIdentityFile,
        ),
        ...(moduleIdentity !== undefined ? { moduleIdentity } : {}),
      };
    };

    let schemaUse: ts.Node = sourceFile;
    const visit: ts.Visitor = (node) => {
      if (isToSchemaNode(node)) {
        const typeArg = node.typeArguments[0]!;
        const typeArguments = ts.isTypeReferenceNode(typeArg)
          ? typeArg.typeArguments
          : undefined;
        // Mint-time identity binding: when the compiler knows module
        // identities (the engine computes them from pristine source BEFORE
        // the TS compile), this direct-root claim is born stamped with its own
        // module's content identity. General nested claims use the same
        // resolver from inside the schema-generator and resolve imported
        // bindings against their defining source.
        const writeAuthorizedByIdentity = extractWriteAuthorizedByIdentity(
          typeArg,
          sourceFile.fileName,
          checker,
          writerIdentityForSourceFile,
        );
        let schemaTypeArg: ts.TypeNode = typeArg;
        if (
          writeAuthorizedByIdentity &&
          isWriteAuthorizedByType(typeArg) &&
          typeArguments?.length
        ) {
          schemaTypeArg = typeArguments[0]!;
        }

        // First check if we have a registered Type for this node or the typeArg
        // (from schema-injection when synthetic TypeNodes were created).
        //
        // Note on typeRegistry's three overloaded uses (see core/mod.ts): this
        // reads the toSchema CallExpression key (use-(c), synthetic call result)
        // here, then TypeNode keys (use-(b)) via getTypeFromTypeNodeWithFallback
        // below and inside the schema-generator package. The uses don't collide
        // because they key on different node-kinds; no split needed.
        let type: ts.Type;
        if (typeRegistry.has(node)) {
          type = typeRegistry.get(node)!;
        } else {
          // Use fallback to handle synthetic TypeNodes that may be in the registry
          type = getTypeFromTypeNodeWithFallback(
            schemaTypeArg,
            checker,
            typeRegistry,
          );
        }

        const arg0 = node.arguments[0] && unwrapExpression(node.arguments[0]);
        let optionsObj: Record<string, unknown> = {};
        let widenLiterals: boolean | undefined;
        if (arg0 && ts.isObjectLiteralExpression(arg0)) {
          optionsObj = evaluateObjectLiteral(arg0, checker);
          // Extract widenLiterals as a generation option (don't merge into schema)
          if (typeof optionsObj.widenLiterals === "boolean") {
            widenLiterals = optionsObj.widenLiterals;
            delete optionsObj.widenLiterals;
          }
        }

        // Build options for schema generation
        const generationOptions: SchemaGenerationOptions = {
          ...(widenLiterals !== undefined ? { widenLiterals } : {}),
          onDiagnostic: (diagnostic) => {
            const original = diagnostic.node &&
              ts.getOriginalNode(diagnostic.node);
            const useRange = recoverAuthoredPosition(node) ??
              recoverAuthoredPosition(schemaUse);
            context.reportDiagnosticOnce({
              ...diagnostic,
              node: original?.getSourceFile()?.fileName === sourceFile.fileName
                ? original
                : useRange
                ? ts.setTextRange(
                  context.factory.createIdentifier(""),
                  useRange,
                )
                : schemaUse,
            });
          },
          // The program's own word on default-library membership; the
          // generator only holds a checker, which cannot reach the program.
          isDefaultLibrarySourceFile: (file) =>
            context.isSourceFileDefaultLibrary(file),
          // A node the pipeline printed from a type is read as that type.
          printedFrom: (typeNode) => context.state.printedFrom(typeNode),
          // The schema-generator owns the general/nested CFC alias path. Give
          // it the same spelling and stamp source used by the direct
          // WriteAuthorizedBy special case below, including for bindings
          // declared in imported authored modules.
          writerIdentityForSourceFile,
        };

        // Schema generation reads a print by the type it was printed from,
        // which says nothing of a piece taken out of it, so a node built from
        // pieces would be read as a node.
        const piece = context.state.printPieceIn(schemaTypeArg);
        if (piece) {
          const root = context.state.printedWithin(piece);
          const printedType = root && context.state.printedFrom(root);
          throw new Error(
            `A piece of the type node printed from \`${
              printedType ? checker.typeToString(printedType) : "?"
            }\` reached schema generation outside that node. A printed ` +
              `type node is read by its type, so no node may be built from ` +
              `its parts.`,
          );
        }

        // If Type resolved to 'any' or the synthetic TypeNode intentionally
        // contains unknown, use the synthetic-node generator so the checker
        // does not recover a wider semantic type from the original source.
        let schema: unknown;
        if (
          ((typeArg.pos === -1 &&
            typeArg.end === -1 &&
            (type.flags & ts.TypeFlags.Any)) ||
            containsAnyOrUnknownTypeNode(typeArg))
        ) {
          // Synthetic TypeNode path - use new method that shares context properly
          schema = schemaGenerator.generateSchemaFromSyntheticTypeNode(
            schemaTypeArg,
            checker,
            typeRegistry,
            schemaHints,
            sourceFile,
            generationOptions,
          );
        } else {
          // Normal Type path
          schema = schemaGenerator.generateSchema(
            type,
            checker,
            schemaTypeArg,
            generationOptions,
            schemaHints,
            sourceFile,
          );
        }

        // Handle boolean schemas (true/false) - can't spread them
        let finalSchema: unknown = typeof schema === "boolean"
          ? schema
          : { ...(schema as Record<string, unknown>), ...optionsObj };
        finalSchema = attachUiContractFromSchemaHints(
          finalSchema,
          node,
          schemaTypeArg,
          schemaHints,
        );
        if (writeAuthorizedByIdentity && typeof finalSchema !== "boolean") {
          finalSchema = attachWriteAuthorizedByMarker(
            finalSchema as Record<string, unknown>,
            writeAuthorizedByIdentity,
          );
        }
        finalSchema = resolvePolicyOfMarkers(finalSchema, context, node);
        const emittedSchema = typeof finalSchema === "boolean"
          ? finalSchema
          : { ...(finalSchema as Record<string, unknown>), ...optionsObj };
        // This is the one place a pattern's declared result exists as the
        // schema it generated, whatever type the author named and whichever
        // inference path SchemaInjection took to reach it. SchemaInjection
        // recorded which calls describe a result, and the node to point at.
        const patternResultAnchor = context.state
          .lookupPatternResultSchemaAnchor(node);
        if (patternResultAnchor) {
          reportOpaqueReservedResultKeys(
            context,
            emittedSchema,
            patternResultAnchor,
          );
        }
        const schemaAst = createSchemaAst(emittedSchema, context.factory);

        // Wrap in `as const satisfies JSONSchema` so that schema-inference
        // overloads (e.g. CellTypeConstructor.of, WishFunction) can infer
        // TypeScript types from the literal schema shape.
        const constAssertion = context.factory.createAsExpression(
          schemaAst,
          context.factory.createTypeReferenceNode(
            context.factory.createIdentifier("const"),
            undefined,
          ),
        );

        const jsonSchemaName = context.cfHelpers.getHelperQualified(
          "JSONSchema",
        );
        const satisfiesExpression = context.factory.createSatisfiesExpression(
          constAssertion,
          context.factory.createTypeReferenceNode(jsonSchemaName),
        );

        return satisfiesExpression;
      }

      // Injected toSchema calls have no position or parent links. Their nearest
      // enclosing authored range locates diagnostics about imported types.
      const enclosingUse = schemaUse;
      const range = recoverAuthoredPosition(node);
      if (range) {
        schemaUse = node;
      }
      const visited = visitEachChildWithJsx(node, visit, transformation);
      schemaUse = enclosingUse;
      return visited;
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }
}

function resolvePolicyOfMarkers(
  value: unknown,
  context: TransformationContext,
  diagnosticNode: ts.Node,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolvePolicyOfMarkers(entry, context, diagnosticNode)
    );
  }
  if (!isObjectOrArray(value)) return value;
  const record = value as Record<string, unknown>;
  const marker = record.__ctPolicyIdentityOf;
  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const identity = marker as { file?: unknown; path?: unknown };
    const file = typeof identity.file === "string" ? identity.file : undefined;
    const symbol = Array.isArray(identity.path) &&
        typeof identity.path[0] === "string"
      ? identity.path[0]
      : undefined;
    const identityEntries = [
      ...(context.options.moduleIdentities?.entries() ?? []),
    ];
    const exactSourceEntry = file === undefined
      ? undefined
      : identityEntries.find(([sourceName]) =>
        sourceName.replace(/\\/g, "/") === file
      );
    const normalizedSourceEntries = file === undefined
      ? []
      : identityEntries.filter(([sourceName]) =>
        normalizeWriterIdentityFile(
          sourceName,
          context.options.canonicalWriterIdentityFile,
        ) === file
      );
    const sourceEntry = exactSourceEntry ??
      (normalizedSourceEntries.length === 1
        ? normalizedSourceEntries[0]
        : undefined);
    let manifests = sourceEntry === undefined
      ? undefined
      : context.state.getPolicyManifests().get(sourceEntry[0]);
    if (sourceEntry !== undefined && manifests === undefined) {
      const definingSource = context.program.getSourceFile(sourceEntry[0]);
      if (definingSource !== undefined) {
        try {
          manifests = compileCfcPolicyManifestsForSource(
            definingSource,
            sourceEntry[1],
          );
          context.state.recordPolicyManifests(
            sourceEntry[0],
            manifests,
          );
        } catch {
          manifests = undefined;
        }
      }
    }
    const artifact = manifests?.find((candidate) =>
      candidate.manifest.symbol === symbol
    );
    if (!sourceEntry || !symbol || !artifact) {
      context.reportDiagnostic({
        node: diagnosticNode,
        type: "cfc-policy-of",
        message:
          "PolicyOf requires a direct typeof reference to a compiler-verified exported exchangeRules() binding.",
      });
      return value;
    }
    const { __ctPolicyIdentityOf: _, ...rest } = record;
    return {
      ...rest,
      moduleIdentity: sourceEntry[1],
      symbol,
      policyDigest: artifact.policyDigest,
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      resolvePolicyOfMarkers(entry, context, diagnosticNode),
    ]),
  );
}

function createSchemaAst(
  schema: unknown,
  factory: ts.NodeFactory,
): ts.Expression {
  if (isWriteAuthorizedByMarker(schema)) {
    return createWriteAuthorizedByMarkerAst(schema, factory);
  }
  if (schema === null) return factory.createNull();
  if (typeof schema === "string") return factory.createStringLiteral(schema);
  if (typeof schema === "number") return createNumericAst(schema, factory);
  if (typeof schema === "boolean") {
    return schema ? factory.createTrue() : factory.createFalse();
  }
  if (Array.isArray(schema)) {
    return factory.createArrayLiteralExpression(
      schema.map((item) => createSchemaAst(item, factory)),
    );
  }
  if (typeof schema === "object") {
    const properties = Object.entries(schema as Record<string, unknown>).map((
      [key, value],
    ) => {
      // Use createPropertyName which handles safe identifiers vs string literals
      // This includes checking for reserved words using TypeScript's scanner
      const propertyName = createPropertyName(key, factory);

      return factory.createPropertyAssignment(
        propertyName,
        createSchemaAst(value, factory),
      );
    });
    return factory.createObjectLiteralExpression(properties, true);
  }
  return factory.createIdentifier("undefined");
}

// The TS factory rejects negative numbers in createNumericLiteral; they must
// be emitted as a unary minus wrapping a positive literal. Non-finite values
// have no literal form at all, so emit them as global identifiers.
function createNumericAst(
  value: number,
  factory: ts.NodeFactory,
): ts.Expression {
  if (Number.isNaN(value)) return factory.createIdentifier("NaN");
  if (value === Infinity) return factory.createIdentifier("Infinity");
  if (value === -Infinity) {
    return factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      factory.createIdentifier("Infinity"),
    );
  }
  if (value < 0 || Object.is(value, -0)) {
    return factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      factory.createNumericLiteral(-value),
    );
  }
  return factory.createNumericLiteral(value);
}

function attachWriteAuthorizedByMarker(
  schema: boolean | Record<string, unknown>,
  identity: { file: string; path: string[]; moduleIdentity?: string },
): boolean | Record<string, unknown> {
  if (typeof schema === "boolean") return schema;
  const ifc = schema.ifc && typeof schema.ifc === "object"
    ? schema.ifc as Record<string, unknown>
    : {};
  return {
    ...schema,
    ifc: {
      ...ifc,
      writeAuthorizedBy: {
        __ctWriterIdentityOf: identity,
      },
    },
  };
}

function attachUiContractFromSchemaHints(
  schema: unknown,
  sourceNode: ts.Node,
  typeNode: ts.TypeNode,
  schemaHints: WeakMap<
    ts.Node,
    {
      items?: unknown;
      cfcUiContract?: {
        helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
        action?: string;
        surface?: string;
        role?: string;
        kind?: string;
        trustedPattern?: string;
        requiredEventIntegrity?: readonly string[];
      };
    }
  >,
): unknown {
  const hint = schemaHints.get(sourceNode)?.cfcUiContract ??
    schemaHints.get(ts.getOriginalNode(sourceNode))?.cfcUiContract ??
    schemaHints.get(typeNode)?.cfcUiContract ??
    schemaHints.get(ts.getOriginalNode(typeNode))?.cfcUiContract;
  if (!hint) {
    return schema;
  }

  if (typeof schema === "boolean") {
    return schema === false ? { not: true, ifc: { uiContract: hint } } : {
      ifc: { uiContract: hint },
    };
  }
  if (!isObjectOrArray(schema)) {
    return schema;
  }

  const recordSchema = schema as Record<string, unknown>;
  const uiProperty = getUiPropertySchema(recordSchema);
  if (uiProperty) {
    return {
      ...recordSchema,
      properties: {
        ...(recordSchema.properties as Record<string, unknown>),
        $UI: attachUiContractToSchemaRecord(uiProperty, hint),
      },
    };
  }

  return attachUiContractToSchemaRecord(recordSchema, hint);
}

function getUiPropertySchema(
  schema: Record<string, unknown>,
): Record<string, unknown> | boolean | undefined {
  if (
    !schema.properties ||
    !isObjectOrArray(schema.properties)
  ) {
    return undefined;
  }

  const uiProperty = (schema.properties as Record<string, unknown>).$UI;
  if (typeof uiProperty === "boolean") {
    return uiProperty;
  }
  return isObjectOrArray(uiProperty)
    ? uiProperty as Record<string, unknown>
    : undefined;
}

function attachUiContractToSchemaRecord(
  schema: Record<string, unknown> | boolean,
  hint: {
    helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    action?: string;
    surface?: string;
    role?: string;
    kind?: string;
    trustedPattern?: string;
    requiredEventIntegrity?: readonly string[];
  },
): Record<string, unknown> {
  if (typeof schema === "boolean") {
    return schema === false ? { not: true, ifc: { uiContract: hint } } : {
      ifc: { uiContract: hint },
    };
  }

  const existingIfc = schema.ifc && typeof schema.ifc === "object"
    ? schema.ifc as Record<string, unknown>
    : {};
  return {
    ...schema,
    ifc: {
      ...existingIfc,
      uiContract: hint,
    },
  };
}

function extractWriteAuthorizedByIdentity(
  typeNode: ts.TypeNode,
  sourceFileName: string,
  checker: ts.TypeChecker,
  writerIdentityForSourceFile: (fileName: string) => {
    file: string;
    moduleIdentity?: string;
  },
): { file: string; path: string[]; moduleIdentity?: string } | undefined {
  if (!isWriteAuthorizedByType(typeNode)) {
    return undefined;
  }
  const bindingNode = typeNode.typeArguments?.[1];
  if (!bindingNode || !ts.isTypeQueryNode(bindingNode)) {
    return undefined;
  }
  if (!ts.isIdentifier(bindingNode.exprName)) {
    return undefined;
  }
  // The same resolution the formatter applies to a nested claim: the writer
  // is named where it is DECLARED, through import bindings and re-exports,
  // by its declared name. A binding the checker cannot resolve falls back to
  // this file and the spelling, as before.
  const binding = resolveWriterBinding(bindingNode.exprName, checker);
  return {
    ...writerIdentityForSourceFile(binding?.fileName ?? sourceFileName),
    path: [binding?.name ?? bindingNode.exprName.text],
  };
}

function isWriteAuthorizedByType(
  typeNode: ts.TypeNode,
): typeNode is ts.TypeReferenceNode {
  return ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "WriteAuthorizedBy" &&
    !!typeNode.typeArguments &&
    typeNode.typeArguments.length >= 2;
}

function isWriteAuthorizedByMarker(
  schema: unknown,
): schema is { __ctWriterIdentityOf: { file: string; path: string[] } } {
  return !!schema && typeof schema === "object" &&
    "__ctWriterIdentityOf" in schema &&
    Object.keys(schema as Record<string, unknown>).length === 1 &&
    isWriterIdentityPayload(
      (schema as Record<string, unknown>).__ctWriterIdentityOf,
    );
}

function isWriterIdentityPayload(
  value: unknown,
): value is { file: string; path: string[] } {
  return !!value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).file === "string" &&
    Array.isArray((value as Record<string, unknown>).path) &&
    ((value as Record<string, unknown>).path as unknown[]).every((entry) =>
      typeof entry === "string"
    );
}

function createWriteAuthorizedByMarkerAst(
  schema: {
    __ctWriterIdentityOf: {
      file: string;
      path: string[];
      moduleIdentity?: string;
    };
  },
  factory: ts.NodeFactory,
): ts.Expression {
  const identity = schema.__ctWriterIdentityOf;
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      createPropertyName("__ctWriterIdentityOf", factory),
      factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
          createPropertyName("file", factory),
          factory.createStringLiteral(identity.file),
        ),
        factory.createPropertyAssignment(
          createPropertyName("path", factory),
          factory.createArrayLiteralExpression(
            identity.path.map((segment) =>
              factory.createStringLiteral(segment)
            ),
          ),
        ),
        ...(typeof identity.moduleIdentity === "string"
          ? [
            factory.createPropertyAssignment(
              createPropertyName("moduleIdentity", factory),
              factory.createStringLiteral(identity.moduleIdentity),
            ),
          ]
          : []),
      ], true),
    ),
  ], true);
}

function evaluateObjectLiteral(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      // Handle both identifier and string literal property names
      let propName: string | undefined;
      if (ts.isIdentifier(prop.name)) {
        propName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        propName = prop.name.text;
      }

      if (propName !== undefined) {
        const value = evaluateExpression(prop.initializer, checker);
        if (value !== undefined) {
          result[propName] = value;
        }
      }
    }
  }
  return result;
}

function evaluateExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
): unknown {
  // Wrappers that do not change the value: parentheses, and the type-only
  // assertion forms. Without this every parenthesized option is dropped, of
  // whatever type -- `("text")` as surely as `(-1)`. Reading the shared set
  // keeps that list the same one the rest of the pipeline looks through.
  const unwrapped = unwrapTransparentWrapperOnce(node);
  if (unwrapped) {
    return evaluateExpression(unwrapped, checker);
  }

  if (ts.isStringLiteral(node)) return node.text;
  const numeric = numberFromExpression(node, checker);
  if (numeric !== undefined) return numeric;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (ts.isObjectLiteralExpression(node)) {
    return evaluateObjectLiteral(node, checker);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => evaluateExpression(element, checker));
  }
  const constantValue = checker.getConstantValue(
    node as ts.PropertyAccessExpression,
  );
  if (constantValue !== undefined) return constantValue;
  return undefined;
}

// Helper type extending CallExpression with
// truthy typeArguments.
interface ToSchemaNode extends ts.CallExpression {
  typeArguments: ts.NodeArray<ts.TypeNode>;
}

function containsAnyOrUnknownTypeNode(node: ts.TypeNode): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      current.kind === ts.SyntaxKind.AnyKeyword ||
      current.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isToSchemaNode(node: ts.Node): node is ToSchemaNode {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length !== 1) return false;

  // Raw identity expression `toSchema<T>()`
  if (
    ts.isIdentifier(expression) &&
    expression.text === "toSchema" &&
    typeArguments &&
    typeArguments.length === 1
  ) {
    return true;
  }
  // Raw property access expression `__cfHelpers.toSchema<T>()`
  if (
    ts.isPropertyAccessExpression(expression) &&
    getNodeText(expression.expression) === CF_HELPERS_IDENTIFIER &&
    expression.name.text === "toSchema"
  ) {
    return true;
  }
  return false;
}
