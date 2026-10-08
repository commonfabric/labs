import type ts from "typescript";
import type {
  JSONSchema,
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import { type Mutable } from "@commonfabric/utils/types";

import type { AnyValueBesideUnwritten } from "./ifc-labels.ts";

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
 * The value a node was narrowed from, such as a capture written with only the
 * members its callback reads. Only the value's own type, or the declaration
 * spelling it, says which CFC labels it carries.
 */
export interface NarrowedFrom {
  readonly type: ts.Type;
  /** The declaration's own node for `type`, where one is at hand. */
  readonly typeNode?: ts.TypeNode;
}

/**
 * Per-node overrides supplied by the caller, keyed by the node the hint
 * applies to. The generator only reads these, so every member is read-only.
 */
export interface SchemaHint {
  readonly items?: unknown;
  readonly cfcUiContract?: UiContractHint;
  /** The value the node narrows, whose CFC labels its schema keeps. */
  readonly narrowedFrom?: NarrowedFrom;
  /**
   * The annotation a print of a member's type is read in place of: one that
   * names a value binding, such as `PolicyOf<typeof rules>`, which a print
   * spells as the structural type of the value it names.
   */
  readonly spelledBy?: ts.TypeNode;
}

export type SchemaHints = WeakMap<ts.Node, SchemaHint>;

/**
 * A schema-generation problem at its authored node, if known. Generation goes
 * on past either severity; an error says the schema it produced is not one to
 * accept, as a write restriction it could not read is not.
 */
export interface SchemaGenerationDiagnostic {
  readonly severity: "warning" | "error";
  readonly type:
    | "schema-default:unresolved"
    | "schema-type:unread"
    | "cfc-schema:recursion-limit"
    | "cfc-write-authorized-by:unread"
    | "cfc-label:unread";
  readonly message: string;
  readonly node?: ts.Node;
}

/** Options that affect schema generation without changing the authored type. */
export interface SchemaGenerationOptions {
  readonly widenLiterals?: boolean;

  /**
   * Generate a schema that declares no scope: each scope wrapper is read as
   * its payload, with no `scope` and no cap on a cell's `asCell` entry. A
   * lift's result whose type its author did not write is generated this way,
   * since the runtime stores it at the narrowest scope its callback reads.
   */
  readonly declaresNoScope?: boolean;

  /**
   * Receives each diagnostic, a warning or an error; without a callback the
   * generator logs it. An error says the schema generated is not one to accept.
   */
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

  /**
   * A number for each record of `schemaOrigins` that a merge's key has met,
   * so equal schemas that came from different types key different merges
   * (`withOriginsNumbered()`).
   */
  originNumbers?: Map<object, number>;

  /**
   * The name of each intersection the node path met again inside itself while
   * merging it, by the key `mergeParts()` gives the merge: the merge is
   * written as a definition of that name, and each meeting as a reference.
   */
  mergedIntersectionNames: Map<string, string>;

  /**
   * A fresh name for an anonymous definition, `AnonymousType_` and a count
   * the generator keeps for every name it gives one.
   */
  nameAnonymousDefinition: () => string;

  /**
   * Each value an intersection the checker gives `any` settled to that met a
   * definition still being generated, checked once generation is done
   * (`assertAnyValuesKeptLabels()`).
   */
  anyValuesBesideUnwritten: AnyValueBesideUnwritten[];

  // Stack state (push/pop during recursion)

  /** Current recursion path for cycle detection */
  definitionStack: Set<string | ts.Type>;

  /** Currently building these named types */
  inProgressNames: Set<string>;

  // Optional context

  /** Type node for additional context */
  typeNode?: ts.TypeNode;

  /**
   * A CFC union alternative sharing a semantic member with another written
   * alternative. Its node is read inline, before type-based definition and
   * cycle handling, so distinct policy bindings cannot share one definition.
   * Consumed at that node; its payload retains ordinary cycle handling.
   */
  inlineUnionMember?: ts.TypeNode;

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

  /** The schema declares no scope (`SchemaGenerationOptions.declaresNoScope`). */
  declaresNoScope?: boolean;

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

  /**
   * Reads only the CFC labels a type attaches at its top: a type that no CFC
   * wrapper holds is read as accepting anything, and not formatted, except a
   * union or an intersection, whose members can carry labels to it, and
   * `null` and `undefined`, which tell a value that may be missing apart from
   * its value member.
   */
  labelsOnly?: boolean;

  /**
   * The type at this position whose CFC metadata carriers the reading holding
   * it has read, reading the rest of it in place: a payload of several
   * members, or none, which no type apart from the carriers holds. Like the
   * node, it is not passed on to a child.
   */
  carriersRead?: ts.Type;

  /**
   * Types whose scope brand the scope wrapper reading them has taken off, read
   * here as its payload: the type the brand was read from, the payload type
   * itself (`scopePayloadType()`) where it is distinct, and each member of it
   * as a union.
   */
  scopeBrandRead?: ReadonlySet<ts.Type>;

  /**
   * The members written for `payload`, the payload of a union of scope
   * wrappers beside `null` or `undefined` written as one, `PerUser<A> | null`:
   * the payload written in each wrapper, and each `null` or `undefined`, as
   * the members of `A | null` written in `PerUser<A | null>` are. The union
   * formatter reads `payload` at these nodes, as it reads a union at the
   * union node written for it.
   */
  scopePayloadNodes?: {
    readonly payload: ts.Type;
    readonly nodes: readonly ts.TypeNode[];
  };

  /**
   * Type parameters read as their arguments, for a node read from the
   * declaration that is written in them (`BoundTypeParameters`).
   */
  boundTypeParameters?: BoundTypeParameters;

  /**
   * Under type parameter bindings, the type the checker instantiates at the
   * position being read, where the reading has it: the payload of the type a
   * CFC alias chain instantiates, and in turn each property of it, its array
   * element, and the one member of an optional or nullable value that is
   * neither `undefined` nor `null`. A type read under bindings is identified
   * together with it, so a recursion whose arguments the checker settles, as
   * `Sec<T | undefined>` inside `Sec<T>` settles after one step, is found as
   * one although its written arguments nest without end. It is set only where
   * a reader passes it for the position it reads.
   */
  instantiatedAs?: ts.Type;
}

/**
 * Type parameters bound to their arguments, for a CFC payload or a plain
 * generic carrying authored binding identities, read from its declaration
 * rather than from an instantiation. Wherever a bound parameter appears, its
 * argument is read. A type that still depends on one where the binding cannot
 * reach, such as `T["name"]` or a conditional type, is reported through
 * `uninterpretedTypeNodes` as not fully read.
 */
export interface BoundTypeParameters {
  readonly arguments: ReadonlyMap<
    ts.TypeParameterDeclaration,
    BoundTypeArgument
  >;
  /** The node read under these bindings, reported where none is nearer. */
  readonly declaredNode: ts.TypeNode;
}

/**
 * A type parameter's argument. One written as a type argument, or as the
 * parameter's default, is read from its node under the bindings of the place
 * it is written, since the node may itself name parameters bound there, and
 * may say what its type cannot, such as a `Default` or a `typeof` binding.
 * One with a type and no node is read as that type.
 */
export interface BoundTypeArgument {
  readonly type: ts.Type;
  readonly node?: ts.TypeNode;
  /**
   * The bindings `node` is written under, or, for an argument with no node,
   * the bindings of the place the checker gave `type` at; absent where it is
   * under none.
   */
  readonly bound?: BoundTypeParameters;
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
