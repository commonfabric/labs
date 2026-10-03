import { getLogger } from "@commonfabric/utils/logger";
import {
  BINDING_IDENTITY_HELPER_NAME,
  createBindingIdentityHelperSource,
  createFunctionHardeningHelperSource,
  RESERVED_FACTORY_BINDINGS,
} from "@commonfabric/utils/sandbox-contract";

import {
  isIdentifierStartCode,
  isSimpleIdentifierText,
  readIdentifierEnd,
  startsWithStatementWord,
} from "./compiled-js-identifiers.ts";
import {
  CompiledJsParseError,
  findTopLevelArrow,
  findTopLevelEquals,
  isStringLiteralRange,
  locationFromOffset,
  type ParsedFunction,
  parseFunctionText,
  splitTopLevelCommaList,
  type StatementChunk,
  stripJsTrivia,
  stripWholeParentheses,
  trimRange,
  tryParseCallExpression,
} from "./compiled-js-parser.ts";
import { ModuleVerificationError } from "./module-verification-error.ts";
import {
  isTrustedBuilder,
  isTrustedDataHelper,
  SAFE_GLOBAL_IDENTIFIERS,
  TOP_LEVEL_CALL_RESULT_ERROR,
} from "./policy.ts";

export type BindingKind =
  | "builder"
  | "data"
  | "function"
  | "import"
  | "unknown";

export interface BindingInfo {
  kind: BindingKind;
  dependencySpecifier?: string;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
  hardeningHelper?: boolean;
  bindingIdentityHelper?: boolean;
  functionRange?: { start: number; end: number };
}

/**
 * Packaging-specific configuration for the format-agnostic security classifier
 * ({@link classifyModuleItems}), which is otherwise independent of how a module
 * body is wrapped.
 *
 * {@link verifyCompiledModuleBody} — the only production caller — passes EMPTY
 * sets, and that is not a stub: it is mutually exclusive with what the
 * transformer emits. `RESERVED_FACTORY_BINDINGS` is exactly
 * `SHADOWED_FACTORY_BINDINGS`, and the transformer emits one
 * `const <name> = undefined;` guard per shadowed name
 * (`createFactoryShadowGuardSource`). Reserving those names would therefore
 * reject every transformed module on its own guards, and requiring them would
 * reject any module that stopped emitting them. Empty sets are what make the
 * guards verify as ordinary primitive `const`s.
 *
 * Non-empty sets belong to a hypothetical wrapper that puts loader bindings in
 * scope around a module body. Nothing does that here, so the branches exist for
 * that contingency and are exercised only by
 * `runner/test/module-item-classifier.test.ts`. `reserved` is a REQUIRED
 * argument everywhere it is threaded: a default of the canonical reserved set
 * would silently enable the check that rejects transformer output.
 */
export interface ModuleItemClassificationOptions {
  /** Canonical shadow-guard statements that MUST be present, or none. */
  requiredGuards: ReadonlySet<string>;

  /** Reserved wrapper bindings authored code may not declare, or none. */
  reservedBindings: ReadonlySet<string>;

  /** Source offset used for the "missing required shadow guards" error. */
  missingGuardsErrorAt: number;
}

const logger = getLogger("compiled-bundle-verifier");

const CANONICAL_HARDENING_HELPER = stripJsTrivia(
  createFunctionHardeningHelperSource(),
);
const CANONICAL_BINDING_IDENTITY_HELPER = stripJsTrivia(
  createBindingIdentityHelperSource(),
);

/**
 * The canonical reserved-binding set from the shared sandbox contract — the
 * value a wrapper-bearing caller would pass as
 * {@link ModuleItemClassificationOptions.reservedBindings}. Deliberately NOT a
 * default on any parameter: see that interface for why the production path
 * passes an empty set instead.
 */
export const RESERVED_FACTORY_BINDING_SET: ReadonlySet<string> = new Set<
  string
>(
  RESERVED_FACTORY_BINDINGS,
);

const DEFAULT_EXPORT_ALLOWED_BINDING_ERROR =
  "Default exports must be trusted builders, direct functions, verified data, or import re-exports";

interface ParsedNormalizedCallReference {
  kind: "identifier" | "member" | "commaMember";
  root: string;
  property?: string;
  properties?: string[];
}

/**
 * Format-agnostic security classifier for a module's top-level items (compiled
 * to CommonJS form). It seeds top-level bindings, then verifies each statement
 * against the SES module-item rules (direct functions, trusted-builder calls
 * with direct callbacks, `__cf_data`/`schema` wrappers, export assignments,
 * reexport getters, function-hardening/binding-identity statements) and rejects
 * everything else. `env` arrives pre-seeded with the module's imports (for a
 * module record, the specifiers its body requires). Packaging differences
 * (shadow guards, reserved bindings) are supplied via `options`, so the core
 * stays independent of how a body is wrapped.
 */
export function classifyModuleItems(
  source: string,
  filename: string,
  statements: readonly StatementChunk[],
  env: Map<string, BindingInfo>,
  options: ModuleItemClassificationOptions,
): { hasHoistRegistration: boolean } {
  predeclareTopLevelBindings(source, statements, env, options);

  logger.timeStart("classifyModuleItems", "statements");
  // The transformer emits at most one trailing `__cfReg({ … })` registration
  // call per module; a second is a tampering signal (the runtime registrar also
  // traps it, but reject it here too). Whether a VALID call was seen is returned
  // so the loader grants the real registrar only to approved modules and a
  // throwing one to the rest (fail closed against a smuggled call).
  let sawHoistRegistration = false;
  try {
    const missingRequiredGuards = new Set(options.requiredGuards);
    for (const statement of statements) {
      const trimmed = trimRange(source, statement.start, statement.end);
      if (trimmed.start >= trimmed.end) continue;

      if (isStringDirectiveRange(source, trimmed.start, trimmed.end)) {
        continue;
      }

      const normalized = stripJsTrivia(
        source,
        statement.start,
        statement.end,
      );
      if (isCompiledEsModuleMarkerNormalized(normalized)) continue;
      if (isCompiledImportNormalizationRebindingNormalized(normalized, env)) {
        continue;
      }
      if (
        missingRequiredGuards.has(normalized)
      ) {
        missingRequiredGuards.delete(normalized);
        continue;
      }

      const functionName = getFunctionDeclarationNameFromRange(
        source,
        trimmed.start,
        trimmed.end,
      );
      if (functionName) {
        assertFactoryBindingIsNotReserved(
          source,
          filename,
          statement.start,
          functionName,
          options.reservedBindings,
        );
        registerFunctionStatement(source, statement, env, functionName);
        continue;
      }

      const variableKind = getVariableStatementKindFromRange(
        source,
        trimmed.start,
        trimmed.end,
      );
      if (variableKind) {
        verifyVariableStatement(
          source,
          filename,
          statement,
          env,
          variableKind,
          options.reservedBindings,
        );
        continue;
      }

      if (isClassDeclarationRange(source, trimmed.start, trimmed.end)) {
        throw verificationErrorAt(
          source,
          filename,
          statement.start,
          "Top-level class declarations are not allowed in SES mode",
        );
      }

      if (
        startsWithStatementWord(source, trimmed.start, trimmed.end, "exports")
      ) {
        verifyCompiledExportAssignment(source, filename, statement, env);
        continue;
      }
      if (isCompiledImportNormalizationRebindingNormalized(normalized, env)) {
        continue;
      }

      const reexport = tryParseCompiledReexportNormalized(normalized);
      if (reexport) {
        if (reexport.exportedName === "__esModule") {
          continue;
        }
        if (reexport.exportedName !== "default") {
          const binding = classifyNormalizedReferenceText(
            source,
            filename,
            statement.start,
            reexport.target,
            env,
          );
          if (binding.kind !== "import") {
            throw verificationErrorAt(
              source,
              filename,
              statement.start,
              "Compiled reexport getters must return imported bindings",
            );
          }
          env.set(reexport.exportedName, cloneBindingInfo(binding));
        }
        continue;
      }

      if (isCompiledExportStarStatementNormalized(normalized)) continue;

      if (
        isAllowedFunctionHardeningStatementNormalized(normalized, env) ||
        isAllowedBindingIdentityStatementNormalized(normalized, env) ||
        isPatternCoverageHitStatement(source, statement)
      ) {
        continue;
      }

      // The single trailing `__cfReg({ __cfPattern_1, … })` hoist-registration
      // call: a shorthand object of top-level builder-artifact bindings. `__cfReg`
      // is supplied by the module wrapper (its registrar param, which shadows a
      // no-op compartment global) and is intentionally NOT a
      // referenceable binding — so any OTHER use (nested, aliased, dynamic) falls
      // through to the unknown-identifier rejection below. Trust of the registered
      // values, single-call, and the closed-window guarantee are enforced at
      // runtime by the registrar (see module-record-compiler.createHoistRegistrar).
      if (isHoistRegistrationCallNormalized(normalized, env)) {
        if (sawHoistRegistration) {
          throw verificationErrorAt(
            source,
            filename,
            statement.start,
            "A module may contain at most one __cfReg() registration call",
          );
        }
        sawHoistRegistration = true;
        continue;
      }

      throw verificationErrorAt(
        source,
        filename,
        statement.start,
        "Compiled module contains unsupported top-level executable code",
      );
    }

    if (missingRequiredGuards.size > 0) {
      throw verificationErrorAt(
        source,
        filename,
        options.missingGuardsErrorAt,
        "Compiled module is missing required wrapper shadow guards",
      );
    }
  } finally {
    logger.timeEnd("classifyModuleItems", "statements");
  }
  return { hasHoistRegistration: sawHoistRegistration };
}

function predeclareTopLevelBindings(
  source: string,
  statements: readonly StatementChunk[],
  env: Map<string, BindingInfo>,
  options: ModuleItemClassificationOptions,
): void {
  const start = performance.now();
  try {
    for (const statement of statements) {
      const trimmed = trimRange(source, statement.start, statement.end);
      if (trimmed.start >= trimmed.end) continue;
      const normalized = stripJsTrivia(source, statement.start, statement.end);
      if (
        options.requiredGuards.has(normalized) ||
        isStringDirectiveRange(source, trimmed.start, trimmed.end) ||
        isCompiledEsModuleMarkerNormalized(normalized) ||
        isCompiledImportNormalizationRebindingNormalized(normalized, env)
      ) {
        continue;
      }

      const functionName = getFunctionDeclarationNameFromRange(
        source,
        trimmed.start,
        trimmed.end,
      );
      if (functionName) {
        if (options.reservedBindings.has(functionName)) {
          continue;
        }
        registerFunctionStatement(source, statement, env, functionName);
        continue;
      }

      if (
        !getVariableStatementKindFromRange(source, trimmed.start, trimmed.end)
      ) {
        continue;
      }
      for (const declarator of parseVariableDeclarators(source, statement)) {
        if (options.reservedBindings.has(declarator.name)) {
          continue;
        }
        const provisional = provisionalBindingForExpression(
          source,
          declarator.initializer.start,
          declarator.initializer.end,
          env,
        );
        if (!env.has(declarator.name)) {
          env.set(
            declarator.name,
            provisional ? cloneBindingInfo(provisional) : { kind: "unknown" },
          );
        }
      }
    }
  } finally {
    logger.time(start, "predeclareTopLevelBindings");
  }
}

function verifyVariableStatement(
  source: string,
  filename: string,
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
  kind: ReturnType<typeof getVariableStatementKindFromRange>,
  reserved: ReadonlySet<string>,
): void {
  const start = performance.now();
  try {
    if (kind !== "const") {
      throw verificationErrorAt(
        source,
        filename,
        statement.start,
        "Top-level mutable bindings are not allowed in SES mode",
      );
    }

    for (const declarator of parseVariableDeclarators(source, statement)) {
      assertFactoryBindingIsNotReserved(
        source,
        filename,
        declarator.initializer.start,
        declarator.name,
        reserved,
      );
      const provisional = provisionalBindingForExpression(
        source,
        declarator.initializer.start,
        declarator.initializer.end,
        env,
      );
      if (provisional) {
        env.set(declarator.name, cloneBindingInfo(provisional));
      }

      const binding = classifyExpressionText(
        source,
        filename,
        declarator.initializer.start,
        declarator.initializer.end,
        env,
      );
      env.set(declarator.name, binding);
    }
  } finally {
    logger.time(start, "verifyVariableStatement");
  }
}

function provisionalBindingForExpression(
  source: string,
  start: number,
  end: number,
  env: Map<string, BindingInfo>,
): BindingInfo | undefined {
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);

  const directFunction = tryParseDirectFunction(source, inner.start, inner.end);
  if (directFunction) {
    return {
      kind: "function",
      functionRange: { start: directFunction.start, end: directFunction.end },
    };
  }

  const call = tryParseCallExpression(source, inner.start, inner.end);
  if (!call) {
    return undefined;
  }

  const normalizedCallee = stripJsTrivia(call.callee);
  const trustedCall = resolveTrustedCallName(normalizedCallee, env);
  if (trustedCall) {
    if (isTrustedBuilder(trustedCall)) {
      return { kind: "builder" };
    }
    return {
      kind: "data",
    };
  }

  const hardeningBinding = env.get(normalizedCallee);
  if (!hardeningBinding?.hardeningHelper || call.args.length !== 1) {
    const bindingIdentityHelper = env.get(normalizedCallee);
    if (
      !bindingIdentityHelper?.bindingIdentityHelper || call.args.length !== 2
    ) {
      return undefined;
    }
    return classifyExpressionText(
      source,
      "<binding-identity>",
      call.args[0].start,
      call.args[0].end,
      env,
    );
  }

  const hardened = trimRange(source, call.args[0].start, call.args[0].end);
  const hardenedFn = tryParseDirectFunction(
    source,
    hardened.start,
    hardened.end,
  );
  if (!hardenedFn) {
    return undefined;
  }

  return {
    kind: "function",
    functionRange: { start: hardenedFn.start, end: hardenedFn.end },
  };
}

function verifyCompiledExportAssignment(
  source: string,
  filename: string,
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
): void {
  const chain = parseExportAssignmentChain(source, statement);
  if (chain.valueIsVoidZero) {
    for (const name of chain.exportedNames) {
      env.set(name, { kind: "unknown" });
    }
    return;
  }

  const binding = classifyExpressionText(
    source,
    filename,
    chain.value.start,
    chain.value.end,
    env,
  );
  if (chain.exportedNames.includes("default")) {
    verifyDefaultExportBinding(source, filename, chain.value.start, binding);
  }
  for (const name of chain.exportedNames) {
    env.set(name, cloneBindingInfo(binding));
  }
}

function verifyDefaultExportBinding(
  source: string,
  filename: string,
  offset: number,
  binding: BindingInfo,
): void {
  if (!isDisallowedTrustedRuntimeDefaultExport(binding)) {
    return;
  }

  throw verificationErrorAt(
    source,
    filename,
    offset,
    DEFAULT_EXPORT_ALLOWED_BINDING_ERROR,
  );
}

function isDisallowedTrustedRuntimeDefaultExport(
  binding: BindingInfo,
): boolean {
  if (binding.kind !== "import") {
    return false;
  }

  return !binding.dependencySpecifier ||
    binding.dependencySpecifier === "require" ||
    binding.dependencySpecifier === "exports" ||
    binding.trustedRuntimeName === "commonfabric" ||
    binding.trustedRuntimeName === "commonfabric/schema";
}

function classifyExpressionText(
  source: string,
  filename: string,
  start: number,
  end: number,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const measureStart = performance.now();
  try {
    const trimmed = trimRange(source, start, end);
    const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
    const firstCode = source.charCodeAt(inner.start);
    const lastCode = source.charCodeAt(inner.end - 1);

    if (
      lastCode === 125 &&
      (
        firstCode === 40 ||
        firstCode === 97 ||
        firstCode === 102
      )
    ) {
      const directFunction = tryParseDirectFunction(
        source,
        inner.start,
        inner.end,
      );
      if (directFunction) {
        return {
          kind: "function",
          functionRange: {
            start: directFunction.start,
            end: directFunction.end,
          },
        };
      }
    }

    if (
      lastCode === 41 &&
      isIdentifierStartCode(firstCode) &&
      !startsWithStatementWord(source, inner.start, inner.end, "new")
    ) {
      const call = tryParseCallExpression(source, inner.start, inner.end);
      if (call) {
        const normalizedCallee = stripJsTrivia(call.callee);
        const trustedCall = resolveTrustedCallName(normalizedCallee, env);
        if (trustedCall) {
          if (isTrustedBuilder(trustedCall)) {
            verifyTrustedBuilderCall(
              source,
              filename,
              trustedCall,
              call.args,
              env,
            );
            return { kind: "builder" };
          }
          verifyTrustedDataCall(
            source,
            filename,
            call.start,
            trustedCall,
            call.args.length,
          );
          return {
            kind: "data",
          };
        }

        const hardeningBinding = env.get(normalizedCallee);
        if (hardeningBinding?.hardeningHelper) {
          if (call.args.length !== 1) {
            throw verificationErrorAt(
              source,
              filename,
              call.start,
              "Function hardening helpers accept exactly one argument",
            );
          }
          const argBinding = classifyExpressionText(
            source,
            filename,
            call.args[0].start,
            call.args[0].end,
            env,
          );
          if (argBinding.kind !== "function") {
            throw verificationErrorAt(
              source,
              filename,
              call.args[0].start,
              "Function hardening must target direct function values",
            );
          }
          return cloneBindingInfo(argBinding);
        }

        const bindingIdentityHelper = env.get(normalizedCallee);
        if (bindingIdentityHelper?.bindingIdentityHelper) {
          if (call.args.length !== 2) {
            throw verificationErrorAt(
              source,
              filename,
              call.start,
              "Verified binding annotation helpers accept exactly two arguments",
            );
          }
          const argBinding = classifyExpressionText(
            source,
            filename,
            call.args[0].start,
            call.args[0].end,
            env,
          );
          if (argBinding.kind === "unknown") {
            throw verificationErrorAt(
              source,
              filename,
              call.args[0].start,
              "Verified binding annotation must target trusted top-level bindings",
            );
          }
          return cloneBindingInfo(argBinding);
        }

        if (isLocalCallableExpression(normalizedCallee, env)) {
          throw verificationErrorAt(
            source,
            filename,
            call.start,
            TOP_LEVEL_CALL_RESULT_ERROR,
          );
        }

        throw verificationErrorAt(
          source,
          filename,
          call.start,
          "Only trusted builder calls, schema(), canonical function hardening, and canonical binding annotation are allowed at module scope in SES mode",
        );
      }
    }

    const normalized = stripJsTrivia(source, inner.start, inner.end);

    if (isPrimitiveLikeExpression(normalized) || normalized === "void0") {
      return { kind: "data" };
    }

    if (isRawMutableExpression(normalized)) {
      throw verificationErrorAt(
        source,
        filename,
        inner.start,
        "Mutable top-level data must be wrapped in __cf_data() in SES mode",
      );
    }

    if (isIifeExpression(normalized)) {
      throw verificationErrorAt(
        source,
        filename,
        inner.start,
        "Only trusted builder calls, schema(), canonical function hardening, and canonical binding annotation are allowed at module scope in SES mode",
      );
    }

    const directFunction = tryParseDirectFunction(
      source,
      inner.start,
      inner.end,
    );
    if (directFunction) {
      return {
        kind: "function",
        functionRange: { start: directFunction.start, end: directFunction.end },
      };
    }

    const call = tryParseCallExpression(source, inner.start, inner.end);
    if (call) {
      const normalizedCallee = stripJsTrivia(call.callee);
      const trustedCall = resolveTrustedCallName(normalizedCallee, env);
      if (trustedCall) {
        if (isTrustedBuilder(trustedCall)) {
          verifyTrustedBuilderCall(
            source,
            filename,
            trustedCall,
            call.args,
            env,
          );
          return { kind: "builder" };
        }
        verifyTrustedDataCall(
          source,
          filename,
          call.start,
          trustedCall,
          call.args.length,
        );
        return {
          kind: "data",
        };
      }

      const hardeningBinding = env.get(normalizedCallee);
      if (hardeningBinding?.hardeningHelper) {
        if (call.args.length !== 1) {
          throw verificationErrorAt(
            source,
            filename,
            call.start,
            "Function hardening helpers accept exactly one argument",
          );
        }
        const argBinding = classifyExpressionText(
          source,
          filename,
          call.args[0].start,
          call.args[0].end,
          env,
        );
        if (argBinding.kind !== "function") {
          throw verificationErrorAt(
            source,
            filename,
            call.args[0].start,
            "Function hardening must target direct function values",
          );
        }
        return cloneBindingInfo(argBinding);
      }

      const bindingIdentityHelper = env.get(normalizedCallee);
      if (bindingIdentityHelper?.bindingIdentityHelper) {
        if (call.args.length !== 2) {
          throw verificationErrorAt(
            source,
            filename,
            call.start,
            "Verified binding annotation helpers accept exactly two arguments",
          );
        }
        return classifyExpressionText(
          source,
          filename,
          call.args[0].start,
          call.args[0].end,
          env,
        );
      }

      if (isLocalCallableExpression(normalizedCallee, env)) {
        throw verificationErrorAt(
          source,
          filename,
          call.start,
          TOP_LEVEL_CALL_RESULT_ERROR,
        );
      }

      throw verificationErrorAt(
        source,
        filename,
        call.start,
        "Only trusted builder calls, schema(), canonical function hardening, and canonical binding annotation are allowed at module scope in SES mode",
      );
    }

    if (isSimpleIdentifierText(normalized)) {
      if (
        normalized === "undefined" || normalized === "NaN" ||
        normalized === "Infinity"
      ) {
        return { kind: "data" };
      }
      const binding = env.get(normalized);
      if (!binding || binding.kind === "unknown") {
        throw verificationErrorAt(
          source,
          filename,
          inner.start,
          `Unknown top-level identifier '${normalized}' in SES mode`,
        );
      }
      return cloneBindingInfo(binding);
    }

    return classifyNormalizedReferenceText(
      source,
      filename,
      inner.start,
      normalized,
      env,
    );
  } finally {
    logger.time(measureStart, "classifyExpressionText");
  }
}

function classifyNormalizedReferenceText(
  source: string,
  filename: string,
  offset: number,
  normalized: string,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const measureStart = performance.now();
  try {
    const ref = parseNormalizedMemberReference(normalized);
    if (!ref) {
      throw verificationErrorAt(
        source,
        filename,
        offset,
        "Top-level value is not allowed in SES mode",
      );
    }

    if (ref.root === "exports" && ref.property) {
      const binding = env.get(ref.property);
      if (!binding || binding.kind === "unknown") {
        throw verificationErrorAt(
          source,
          filename,
          offset,
          `Unknown exported binding '${ref.property}' in SES mode`,
        );
      }
      return cloneBindingInfo(binding);
    }

    const binding = env.get(ref.root);
    if (!binding || binding.kind === "unknown") {
      throw verificationErrorAt(
        source,
        filename,
        offset,
        `Unknown top-level identifier '${ref.root}' in SES mode`,
      );
    }
    return cloneBindingInfo(binding);
  } finally {
    logger.time(measureStart, "classifyReferenceText");
  }
}

function verifyTrustedDataCall(
  source: string,
  filename: string,
  offset: number,
  trustedName: string,
  argCount: number,
): void {
  if (trustedName === "__cf_data" && argCount === 1) {
    return;
  }

  if (trustedName === "schema" && argCount === 1) {
    return;
  }

  throw verificationErrorAt(
    source,
    filename,
    offset,
    `Trusted helper '${trustedName}' received an unsupported argument shape`,
  );
}

function verifyTrustedBuilderCall(
  source: string,
  filename: string,
  builderName: string,
  args: Array<{ start: number; end: number }>,
  env: Map<string, BindingInfo>,
): void {
  const measureStart = performance.now();
  try {
    // multiUserTest is the one builder without a callback: it tags a
    // descriptor object whose leaves are other trusted-builder results, so
    // its arguments verify as trusted value expressions.
    if (builderName === "multiUserTest") {
      for (const argument of args) {
        verifyTrustedValueExpression(
          source,
          filename,
          argument.start,
          argument.end,
          env,
        );
      }
      return;
    }
    const callbackIndexes = callbackIndexesForBuilder(
      source,
      builderName,
      args,
      env,
    );
    if (callbackIndexes.length === 0) {
      throw verificationErrorAt(
        source,
        filename,
        args[0]?.start ?? 0,
        `Trusted builder '${builderName}' must receive a direct callback in SES mode`,
      );
    }

    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (callbackIndexes.includes(index)) {
        const callback = resolveTrustedBuilderCallback(source, argument, env);
        if (!callback) {
          throw verificationErrorAt(
            source,
            filename,
            argument.start,
            `Trusted builder '${builderName}' must receive a direct callback, not an indirect reference`,
          );
        }
        continue;
      }
      verifyTrustedValueExpression(
        source,
        filename,
        argument.start,
        argument.end,
        env,
      );
    }
  } finally {
    logger.time(measureStart, "verifyTrustedBuilderCall");
  }
}

function callbackIndexesForBuilder(
  source: string,
  builderName: string,
  args: Array<{ start: number; end: number }>,
  env: Map<string, BindingInfo>,
): number[] {
  switch (builderName) {
    case "pattern":
    case "action":
    case "computed":
      return args.length >= 1 ? [0] : [];
    case "lift": {
      // `lift` is function-first, matching pattern()/handler(): the callback
      // leads and schemas trail (see the runtime dispatch in builder/module.ts).
      //   lift(fn)                          → callback at 0
      //   lift(fn, argSchema)               → callback at 0
      //   lift(fn, argSchema, resSchema)    → callback at 0
      //   lift(fn, false)                   → callback at 0 (no-input form)
      // The callback is always position 0. Scan the leading position(s)
      // defensively and pick the first that parses as a direct callback.
      // (Reachable at module scope as of CT-1644, which hoists `lift(...)()`
      // computations to a module-scope const; previously these only appeared
      // inline inside a handler/pattern body, unverified here.)
      for (let i = 0; i < Math.min(args.length, 3); i++) {
        if (resolveTrustedBuilderCallback(source, args[i]!, env)) {
          return [i];
        }
      }
      // No direct callback found; fall back to position 0 (where the callback
      // belongs) so the caller still emits the "must receive a direct callback"
      // diagnostic against the right argument.
      return args.length >= 1 ? [0] : [];
    }
    case "handler":
      if (
        args.length >= 1 &&
        !!resolveTrustedBuilderCallback(source, args[0], env)
      ) {
        return [0];
      }
      return args.length >= 3 ? [2] : [];
    case "derive":
      return args.length >= 4 ? [3] : args.length >= 2 ? [1] : [];
    default:
      return [];
  }
}

function verifyTrustedValueExpression(
  source: string,
  filename: string,
  start: number,
  end: number,
  env: Map<string, BindingInfo>,
): void {
  const measureStart = performance.now();
  try {
    const trimmed = trimRange(source, start, end);
    const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
    const normalized = stripJsTrivia(source, inner.start, inner.end);

    if (
      isPrimitiveLikeExpression(normalized) ||
      normalized === "void0" ||
      isRegexLiteral(normalized) ||
      normalized.startsWith("{") ||
      normalized.startsWith("[")
    ) {
      return;
    }

    if (isSimpleIdentifierText(normalized)) {
      if (SAFE_GLOBAL_IDENTIFIERS.has(normalized)) {
        return;
      }
      const binding = env.get(normalized);
      if (!binding || binding.kind === "unknown") {
        throw verificationErrorAt(
          source,
          filename,
          inner.start,
          `Unknown identifier '${normalized}' in SES-verified module scope`,
        );
      }
      return;
    }

    if (parseNormalizedMemberReference(normalized)) {
      classifyNormalizedReferenceText(
        source,
        filename,
        inner.start,
        normalized,
        env,
      );
      return;
    }

    const call = tryParseCallExpression(source, inner.start, inner.end);
    if (call) {
      const trustedName = resolveTrustedCallName(
        stripJsTrivia(call.callee),
        env,
      );
      if (trustedName) {
        verifyTrustedDataCall(
          source,
          filename,
          call.start,
          trustedName,
          call.args.length,
        );
        return;
      }
    }

    throw verificationErrorAt(
      source,
      filename,
      inner.start,
      "Only verified plain data and references to verified top-level bindings are allowed here in SES mode",
    );
  } finally {
    logger.time(measureStart, "verifyTrustedValueExpression");
  }
}

function isLocalCallableExpression(
  normalizedCallee: string,
  env: Map<string, BindingInfo>,
): boolean {
  const ref = parseNormalizedCallReference(normalizedCallee);
  if (!ref) {
    return false;
  }

  if (ref.kind === "identifier") {
    const binding = env.get(ref.root);
    return !!binding &&
      (
        binding.kind === "function" ||
        (binding.kind === "import" && !binding.trustedRuntimeName)
      );
  }

  const binding = env.get(ref.root);
  return !!binding && binding.kind === "import" &&
    !binding.trustedRuntimeName;
}

function resolveTrustedBuilderCallback(
  source: string,
  argument: { start: number; end: number },
  env: Map<string, BindingInfo>,
): { start: number; end: number } | undefined {
  const trimmed = trimRange(source, argument.start, argument.end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const directFunction = tryParseDirectFunction(source, inner.start, inner.end);
  if (directFunction) {
    return { start: directFunction.start, end: directFunction.end };
  }

  const normalized = stripJsTrivia(source, inner.start, inner.end);
  if (!isSimpleIdentifierText(normalized)) {
    return undefined;
  }

  const binding = env.get(normalized);
  if (
    binding?.kind !== "function" || !binding.functionRange ||
    binding.hardeningHelper
  ) {
    return undefined;
  }

  return binding.functionRange;
}

function resolveTrustedCallName(
  normalizedCallee: string,
  env: Map<string, BindingInfo>,
): string | undefined {
  const ref = parseNormalizedCallReference(normalizedCallee);
  if (!ref) {
    return undefined;
  }

  if (ref.kind === "identifier") {
    const binding = env.get(ref.root);
    if (
      binding?.trustedRuntimeName &&
      (isTrustedBuilder(binding.trustedRuntimeName) ||
        isTrustedDataHelper(binding.trustedRuntimeName))
    ) {
      return binding.trustedRuntimeName;
    }
    return undefined;
  }

  const binding = env.get(ref.root);
  if (!binding?.namespaceImport || !binding.trustedRuntimeName) {
    return undefined;
  }

  const properties = ref.properties ?? (ref.property ? [ref.property] : []);
  const helperName = properties.length === 1
    ? properties[0]
    : properties.length === 2 && properties[0] === "__cfHelpers"
    ? properties[1]
    : undefined;

  if (
    helperName &&
    (isTrustedBuilder(helperName) || isTrustedDataHelper(helperName))
  ) {
    return helperName;
  }

  return undefined;
}

function parseVariableDeclarators(
  source: string,
  statement: StatementChunk,
): Array<{ name: string; initializer: { start: number; end: number } }> {
  const measureStart = performance.now();
  try {
    const trimmed = trimRange(source, statement.start, statement.end);
    const keyword = getVariableStatementKindFromRange(
      source,
      trimmed.start,
      trimmed.end,
    );
    if (!keyword) {
      throw new Error("Expected a variable statement");
    }
    const listStart = trimmed.start + keyword.length;
    const listEnd =
      stripTrailingSemicolonRange(source, trimmed.start, trimmed.end)
        .end;
    return splitTopLevelCommaList(source, listStart, listEnd).map((range) => {
      const equals = findTopLevelEquals(source, range.start, range.end);
      if (equals === undefined) {
        throw new CompiledJsParseError(
          range.start,
          "Top-level declarations must initialize their bindings",
        );
      }
      const nameRange = trimRange(source, range.start, equals);
      const name = source.slice(nameRange.start, nameRange.end);
      if (!isSimpleIdentifierText(name)) {
        throw new CompiledJsParseError(
          nameRange.start,
          "Top-level declarations must bind simple identifiers",
        );
      }
      const initializer = trimRange(source, equals + 1, range.end);
      return {
        name,
        initializer,
      };
    });
  } finally {
    logger.time(measureStart, "parseVariableDeclarators");
  }
}

function parseExportAssignmentChain(
  source: string,
  statement: StatementChunk,
): {
  exportedNames: string[];
  value: { start: number; end: number };
  valueIsVoidZero: boolean;
} {
  const trimmed = stripTrailingSemicolonRange(
    source,
    statement.start,
    statement.end,
  );
  const equals = findTopLevelEquals(source, trimmed.start, trimmed.end);
  if (equals === undefined) {
    throw new CompiledJsParseError(
      trimmed.start,
      "Compiled exports must use direct assignment",
    );
  }

  const exportedName = getExportsPropertyName(
    source,
    trimmed.start,
    equals,
  );
  if (!exportedName) {
    throw new CompiledJsParseError(
      trimmed.start,
      "Compiled exports must use direct assignment",
    );
  }

  const rhs = trimRange(source, equals + 1, trimmed.end);
  const nestedEquals = findTopLevelEquals(source, rhs.start, rhs.end);
  if (
    nestedEquals !== undefined &&
    getExportsPropertyName(source, rhs.start, nestedEquals)
  ) {
    const nested = parseExportAssignmentChain(source, {
      start: rhs.start,
      end: rhs.end,
    });
    return {
      exportedNames: [exportedName, ...nested.exportedNames],
      value: nested.value,
      valueIsVoidZero: nested.valueIsVoidZero,
    };
  }

  return {
    exportedNames: [exportedName],
    value: rhs,
    valueIsVoidZero: stripJsTrivia(source, rhs.start, rhs.end) === "void0",
  };
}

function tryParseCompiledReexportNormalized(
  normalized: string,
): { exportedName: string; target: string } | undefined {
  const match = normalized.match(
    /^Object\.defineProperty\(exports,(["'])([^"']+)\1,\{enumerable:true,get:function\(\)\{return(.+);\}\}\);?$/,
  );
  if (!match) return undefined;
  return {
    exportedName: match[2],
    target: match[3],
  };
}

function isCompiledExportStarStatementNormalized(normalized: string): boolean {
  return /^__exportStar\([A-Za-z_$][\w$]*,exports\);?$/.test(normalized);
}

/**
 * Recognize the transformer's hoist-registration statement:
 * `__cfReg({ __cfPattern_h…, …, __cfPattern_1: __cfPattern_h…, … })` — a call
 * to `__cfReg` with a single object literal whose entries take exactly two
 * forms:
 *
 *   - a shorthand property naming a top-level binding (canonical hoist names
 *     and authored non-exported builder consts); or
 *   - a positional-alias property `__cf<Kind>_<n>: __cf<Kind>_h<digest>` whose
 *     VALUE names a top-level binding — the visit-order alias the transformer
 *     registers beside each content-addressed hoist so pointers stored under
 *     the historical numbering stay loadable.
 *
 * Both forms guarantee every registered VALUE is a module-level binding (no
 * arbitrary expression / closure value) — the property the shorthand-only rule
 * existed for; the alias form adds only an inert key. Anything else — spreads,
 * computed keys, string keys, non-alias-shaped `key:value` pairs — is rejected
 * as unsupported.
 */
function isHoistRegistrationCallNormalized(
  normalized: string,
  env: Map<string, BindingInfo>,
): boolean {
  const match = normalized.match(/^__cfReg\(\{([\s\S]*)\}\);?$/);
  if (!match) return false;
  const inner = match[1].replace(/,$/, "").trim();
  if (inner.length === 0) return false;
  for (const raw of inner.split(",")) {
    const entry = raw.trim();
    // Shorthand identifier (`{a,b}`): must be a declared top-level binding.
    if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
      if (!env.has(entry)) return false;
      continue;
    }
    // Positional-alias pair: numeric-alias key, content-addressed value, and
    // the VALUE must be a declared top-level binding. Nothing else passes, so
    // spreads / computed keys / string keys / arbitrary `key:value` stay
    // rejected exactly as before.
    const alias = entry.match(
      /^(__cf[A-Za-z]+_\d+):(__cf[A-Za-z]+_h[0-9a-f]+(?:_\d+)?)$/,
    );
    if (!alias) return false;
    if (!env.has(alias[2])) return false;
  }
  return true;
}

function isCompiledEsModuleMarkerNormalized(normalized: string): boolean {
  return normalized ===
    `Object.defineProperty(exports,"__esModule",{value:true});`;
}

function isCompiledImportNormalizationRebindingNormalized(
  normalized: string,
  env: Map<string, BindingInfo>,
): boolean {
  const match = normalized.match(
    /^([A-Za-z_$][\w$]*)=__importDefault\(\1\);?$/,
  );
  if (!match) return false;
  return env.get(match[1])?.kind === "import";
}

function isAllowedFunctionHardeningStatementNormalized(
  normalized: string,
  env: Map<string, BindingInfo>,
): boolean {
  const match = normalized.match(
    /^([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\);?$/,
  );
  if (!match) return false;

  const callee = env.get(match[1]);
  const target = env.get(match[2]);
  return callee?.hardeningHelper === true && target?.kind === "function";
}

function isAllowedBindingIdentityStatementNormalized(
  normalized: string,
  env: Map<string, BindingInfo>,
): boolean {
  const match = normalized.match(
    /^([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{[\s\S]*\}\);?$/,
  );
  if (!match) return false;

  const callee = env.get(match[1]);
  const target = env.get(match[2]);
  return (
    (match[1] === BINDING_IDENTITY_HELPER_NAME ||
      callee?.bindingIdentityHelper === true) &&
    (target?.kind === "function" || target?.kind === "builder")
  );
}

function isFunctionHardeningHelperDeclaration(source: string): boolean {
  return stripJsTrivia(source) === CANONICAL_HARDENING_HELPER;
}

function isBindingIdentityHelperDeclaration(source: string): boolean {
  return stripJsTrivia(source) === CANONICAL_BINDING_IDENTITY_HELPER;
}

function registerFunctionStatement(
  source: string,
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
  name = getFunctionDeclarationNameFromRange(
    source,
    trimRange(source, statement.start, statement.end).start,
    trimRange(source, statement.start, statement.end).end,
  ),
): void {
  if (!name) return;
  const statementText = source.slice(statement.start, statement.end);
  env.set(name, {
    kind: "function",
    hardeningHelper: isFunctionHardeningHelperDeclaration(statementText),
    bindingIdentityHelper: isBindingIdentityHelperDeclaration(statementText),
    functionRange: { start: statement.start, end: statement.end },
  });
}

function getFunctionDeclarationNameFromRange(
  source: string,
  start: number,
  end: number,
): string | undefined {
  let cursor = start;
  if (startsWithStatementWord(source, cursor, end, "async")) {
    cursor += 5;
    cursor = skipInlineWhitespace(source, cursor, end);
  }

  if (!startsWithStatementWord(source, cursor, end, "function")) {
    return undefined;
  }

  cursor += "function".length;
  cursor = skipInlineWhitespace(source, cursor, end);
  if (source[cursor] === "*") {
    return undefined;
  }

  const nameEnd = readIdentifierEnd(source, cursor, end);
  if (nameEnd === undefined) {
    return undefined;
  }
  return source.slice(cursor, nameEnd);
}

function tryParseDirectFunction(
  source: string,
  start: number,
  end: number,
): ParsedFunction | undefined {
  if (!looksLikeDirectFunctionSyntax(source, start, end)) {
    return undefined;
  }

  const normalized = stripJsTrivia(source, start, end);
  if (
    /^(?:async)?function(?:[A-Za-z_$][\w$]*)?\(/.test(normalized) ||
    /^(?:async)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)=>/.test(normalized)
  ) {
    return {
      start,
      end,
      params: [],
      body: {
        start,
        end,
        statements: [],
      },
    };
  }
  try {
    return parseFunctionText(source, start, end);
  } catch {
    return undefined;
  }
}

function looksLikeDirectFunctionSyntax(
  source: string,
  start: number,
  end: number,
): boolean {
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  if (inner.start >= inner.end) {
    return false;
  }

  return source.startsWith("function", inner.start) ||
    source.startsWith("async", inner.start) ||
    findTopLevelArrow(source, inner.start, inner.end) !== undefined;
}

function getExportsPropertyName(
  source: string,
  start: number,
  end: number,
): string | undefined {
  const normalized = stripJsTrivia(source, start, end);
  const dotMatch = normalized.match(/^exports\.([A-Za-z_$][\w$]*)$/);
  if (dotMatch) return dotMatch[1];
  const bracketMatch = normalized.match(/^exports\[(["'])([^"']+)\1\]$/);
  return bracketMatch?.[2];
}

function isStringDirectiveRange(
  source: string,
  start: number,
  end: number,
): boolean {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') {
    return false;
  }
  const last = source[end - 1] === ";" ? end - 2 : end - 1;
  return last > start && source[last] === quote;
}

function isClassDeclarationRange(
  source: string,
  start: number,
  end: number,
): boolean {
  return startsWithStatementWord(source, start, end, "class");
}

function getVariableStatementKindFromRange(
  source: string,
  start: number,
  end: number,
): "const" | "let" | "var" | undefined {
  if (startsWithStatementWord(source, start, end, "const")) return "const";
  if (startsWithStatementWord(source, start, end, "let")) return "let";
  if (startsWithStatementWord(source, start, end, "var")) return "var";
  return undefined;
}

function skipInlineWhitespace(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (cursor < end) {
    const code = source.charCodeAt(cursor);
    if (
      code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
      code === 32
    ) {
      cursor++;
      continue;
    }
    break;
  }
  return cursor;
}

function isPrimitiveLikeExpression(normalized: string): boolean {
  return normalized === "null" ||
    normalized === "true" ||
    normalized === "false" ||
    /^-?\d/.test(normalized) ||
    /^(['"]).*\1$/.test(normalized) ||
    isNoSubstitutionTemplateLiteral(normalized) ||
    /^\d+n$/.test(normalized);
}

function parseNormalizedCallReference(
  normalized: string,
): ParsedNormalizedCallReference | undefined {
  if (isSimpleIdentifierText(normalized)) {
    return {
      kind: "identifier",
      root: normalized,
    };
  }

  if (
    normalized.startsWith("(0,") &&
    normalized.endsWith(")")
  ) {
    const inner = parseNormalizedMemberReference(
      normalized.slice(3, normalized.length - 1),
    );
    if (!inner?.property) {
      return undefined;
    }
    return {
      kind: "commaMember",
      root: inner.root,
      property: inner.property,
      properties: inner.properties,
    };
  }

  const member = parseNormalizedMemberReference(normalized);
  if (!member?.property) {
    return undefined;
  }
  return {
    kind: "member",
    root: member.root,
    property: member.property,
    properties: member.properties,
  };
}

function parseNormalizedMemberReference(
  normalized: string,
): { root: string; property?: string; properties: string[] } | undefined {
  const rootEnd = readIdentifierEnd(normalized, 0, normalized.length);
  if (rootEnd === undefined) {
    return undefined;
  }

  const root = normalized.slice(0, rootEnd);
  let cursor = rootEnd;
  let property: string | undefined;
  const properties: string[] = [];
  let sawSegment = false;

  while (cursor < normalized.length) {
    const char = normalized[cursor];
    if (char === ".") {
      const propertyStart = cursor + 1;
      const propertyEnd = readIdentifierEnd(
        normalized,
        propertyStart,
        normalized.length,
      );
      if (propertyEnd === undefined) {
        return undefined;
      }
      property = normalized.slice(propertyStart, propertyEnd);
      properties.push(property);
      cursor = propertyEnd;
      sawSegment = true;
      continue;
    }

    if (char === "[") {
      const quote = normalized[cursor + 1];
      if (quote !== "'" && quote !== '"') {
        return undefined;
      }
      let index = cursor + 2;
      while (index < normalized.length && normalized[index] !== quote) {
        if (normalized[index] === "\\") {
          index += 2;
          continue;
        }
        index++;
      }
      if (index >= normalized.length || normalized[index + 1] !== "]") {
        return undefined;
      }
      property = normalized.slice(cursor + 2, index);
      properties.push(property);
      cursor = index + 2;
      sawSegment = true;
      continue;
    }

    return undefined;
  }

  if (!sawSegment) {
    return undefined;
  }

  return { root, property, properties };
}

function isNoSubstitutionTemplateLiteral(normalized: string): boolean {
  if (!normalized.startsWith("`") || !normalized.endsWith("`")) {
    return false;
  }

  for (let index = 1; index < normalized.length - 1; index++) {
    const char = normalized[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "$" && normalized[index + 1] === "{") {
      return false;
    }
    if (char === "`") {
      return false;
    }
  }

  return true;
}

function isRegexLiteral(normalized: string): boolean {
  return /^\/(?:\\.|[^/])+\/[A-Za-z]*$/.test(normalized);
}

function isIifeExpression(normalized: string): boolean {
  return /^\((?:async)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)=>.*\)\([^)]*\)$/.test(
    normalized,
  ) ||
    /^\(function.*\)\([^)]*\)$/.test(normalized);
}

function isPatternCoverageHitStatement(
  source: string,
  statement: StatementChunk,
): boolean {
  const call = tryParseCallExpression(source, statement.start, statement.end);
  if (!call) return false;
  const calleeRange = stripWholeParentheses(call.callee, 0, call.callee.length);
  const callee = call.callee.slice(calleeRange.start, calleeRange.end);
  if (callee !== "globalThis.__cfPatternCoverage?.hit") {
    return false;
  }
  if (call.args.length !== 2) return false;

  if (
    !isStringLiteralRange(source, call.args[0].start, call.args[0].end)
  ) {
    return false;
  }

  const spanId = stripJsTrivia(
    source,
    call.args[1].start,
    call.args[1].end,
  );
  return /^(?:0|[1-9]\d*)$/.test(spanId);
}

function isRawMutableExpression(normalized: string): boolean {
  return normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    normalized.startsWith("/") ||
    normalized.startsWith("new");
}

function stripTrailingSemicolonRange(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const trimmed = trimRange(source, start, end);
  if (source[trimmed.end - 1] === ";") {
    return trimRange(source, trimmed.start, trimmed.end - 1);
  }
  return trimmed;
}

function cloneBindingInfo(binding: BindingInfo): BindingInfo {
  return { ...binding };
}

function verificationErrorAt(
  source: string,
  file: string,
  offset: number,
  message: string,
): ModuleVerificationError {
  const { line, column } = locationFromOffset(source, offset);
  return new ModuleVerificationError(file, line, column, message);
}

function assertFactoryBindingIsNotReserved(
  source: string,
  filename: string,
  offset: number,
  name: string,
  reserved: ReadonlySet<string>,
): void {
  if (!reserved.has(name)) {
    return;
  }
  throw verificationErrorAt(
    source,
    filename,
    offset,
    `Reserved wrapper binding '${name}' is not allowed in SES mode`,
  );
}
