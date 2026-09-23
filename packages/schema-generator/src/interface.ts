import type ts from "typescript";
import type {
  JSONSchema,
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import { type Mutable } from "@commonfabric/utils/types";

/**
 * JSON Schema object type - mutable version of the Common Fabric JSONSchema interface
 */
export type SchemaDefinition = Mutable<JSONSchema>;

/** File and optional content identity attached to a writer-binding claim. */
export interface WriterSourceIdentity {
  readonly file: string;
  readonly moduleIdentity?: string;
}

/** The `ifc.uiContract` a caller asks the generator to emit for a node. */
export interface UiContractHint {
  readonly helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
  readonly action?: string;
  readonly surface?: string;
  readonly role?: string;
  readonly kind?: string;
  readonly trustedPattern?: string;
  readonly requiredEventIntegrity?: readonly string[];
}

/**
 * Per-node overrides supplied by the caller, keyed by the node the hint
 * applies to. The generator only reads these, so every member is read-only.
 */
export interface SchemaHint {
  readonly items?: unknown;
  readonly cfcUiContract?: UiContractHint;
}

export type SchemaHints = WeakMap<ts.Node, SchemaHint>;

/** A recoverable schema-generation problem at its authored node, if known. */
export interface SchemaGenerationDiagnostic {
  readonly severity: "warning";
  readonly type: "schema-default:unresolved" | "schema-type:unread";
  readonly message: string;
  readonly node?: ts.Node;
}

/** Options that affect schema generation without changing the authored type. */
export interface SchemaGenerationOptions {
  readonly widenLiterals?: boolean;

  /** Receives warnings; without a callback the generator logs them. */
  readonly onDiagnostic?: (diagnostic: SchemaGenerationDiagnostic) => void;

  /**
   * Resolves a TypeScript source-file name to the writer identity that should
   * be embedded in `WriteAuthorizedBy` metadata. Transformer callers use this
   * to apply their compile-name-to-authored-name mapping and, when available,
   * attach the defining module's content identity at mint time.
   */
  readonly writerIdentityForSourceFile?: (
    fileName: string,
  ) => WriterSourceIdentity;

  /**
   * The program's own word on whether a source file is a default library
   * (`program.isSourceFileDefaultLibrary`). The transformer supplies it; a
   * generator running without a program falls back to file names
   * (`typescript/default-library.ts`).
   */
  readonly isDefaultLibrarySourceFile?: (sourceFile: ts.SourceFile) => boolean;

  /**
   * The type a type node was printed from, for a node the caller printed from
   * a type, and `undefined` for any other node. A printed node stands for its
   * type and says nothing more, so the generator reads that type in place of
   * the node wherever the node appears: as the whole node, or inside a node
   * the caller built.
   */
  readonly printedFrom?: (node: ts.TypeNode) => ts.Type | undefined;
}

/**
 * Unified context for schema generation - contains all state in one place
 */
export interface GenerationContext {
  // Immutable context (set once)

  /** TypeScript type checker */
  readonly typeChecker: ts.TypeChecker;

  /** Pre-computed cyclic type set */
  readonly cyclicTypes: ReadonlySet<ts.Type>;

  /** Pre-computed cyclic name set */
  readonly cyclicNames: ReadonlySet<string>;

  // Accumulating state (grows during generation)

  /** Named type definitions for $refs */
  definitions: Record<string, SchemaDefinition>;

  /** Which $refs have been emitted */
  emittedRefs: Set<string>;

  /**
   * Source distinctions needed while reducing intersections. Schemas can
   * coincide for different types, and a fallback can hide its constituents.
   * Constituents are formatted lazily when an enclosing intersection needs
   * them; standalone fallbacks retain their normal formatter behavior. The
   * record is keyed on the schema object itself, so it reaches a reader only
   * through the object a formatter returned — the one the definitions hold
   * and a `$ref` resolves to — and a copy carries none of it.
   */
  schemaOrigins?: WeakMap<
    MutableJSONSchemaObj,
    | { kind: "void" }
    | { kind: "intersection" | "union"; parts: () => MutableJSONSchema[] }
  >;

  // Stack state (push/pop during recursion)

  /** Current recursion path for cycle detection */
  definitionStack: Set<string | ts.Type>;

  /** Currently building these named types */
  inProgressNames: Set<string>;

  // Optional context

  /** Type node for additional context */
  typeNode?: ts.TypeNode;

  /**
   * The node whose schema hints apply at this position when it is not the node
   * read: a printed node, read by its type, keeps the hints a caller attached
   * to it.
   */
  hintsNode?: ts.TypeNode;

  /** Source file name for authoring metadata that needs stable file identity */
  sourceFileName?: string;

  /** Source file for resolving names from synthetic type nodes */
  sourceFile?: ts.SourceFile;

  /** Optional type registry for synthetic nodes */
  typeRegistry?: WeakMap<ts.Node, ts.Type>;

  /** Widen literal types to base types during schema generation */
  widenLiterals?: boolean;

  /** Receives recoverable schema-generation problems. */
  onDiagnostic?: (diagnostic: SchemaGenerationDiagnostic) => void;

  /** Resolve writer-claim file spelling and optional mint-time identity. */
  writerIdentityForSourceFile?: (
    fileName: string,
  ) => WriterSourceIdentity;

  /** The program's word on default-library membership, when supplied. */
  isDefaultLibrarySourceFile?: (sourceFile: ts.SourceFile) => boolean;

  /** The type a printed node stands for (`SchemaGenerationOptions`). */
  printedFrom?: (node: ts.TypeNode) => ts.Type | undefined;

  /** Schema hints for overriding default behavior (keyed by TypeNode) */
  schemaHints?: SchemaHints;

  /** Override for array items schema, propagated from wrapper types */
  arrayItemsOverride?: JSONSchema;

  /**
   * Synthetic type nodes that node-based analysis could not fully interpret,
   * including type literals with unreadable property names. A caller that also
   * holds a usable type for the position installs an array here, and a non-empty
   * one afterwards tells it the node-driven schema is incomplete. Shared by
   * every child context.
   */
  uninterpretedTypeNodes?: ts.TypeNode[];
}

/**
 * Interface for type formatters that convert TypeScript types to JSON Schema
 */
export interface TypeFormatter {
  /**
   * Check if this formatter can handle the given type
   */
  supportsType(type: ts.Type, context: GenerationContext): boolean;

  /**
   * Convert the type to JSON Schema
   */
  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): SchemaDefinition;
}
