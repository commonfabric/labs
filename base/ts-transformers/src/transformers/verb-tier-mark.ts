import ts from "typescript";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { detectCallKind } from "../ast/call-kind.ts";
import { visitEachChildWithJsx } from "../ast/utils.ts";
import { unwrapExpression } from "../utils/expression.ts";

/**
 * Verb listing marks, producer 1 (verb contract WS-F): a stream whose handler
 * binds session-scoped state is wrapper-tier — a UI affordance outside the
 * headless contract — so its RESULT-schema property gains the annotation-class
 * mark `tier: "wrapper"`. `cf piece verbs` hides marked verbs by default;
 * everything stays callable and `cf piece call` never consults the mark.
 *
 * Runs AFTER SchemaGeneratorTransformer and BEFORE ReactiveVariableFor, on
 * purpose: at this point builder hoisting has already lifted every handler
 * factory to a module-scope const whose bound-state schema is a LITERAL
 * (`__cfHandler_N = handler(eventSchema, { ...scope: "session"... }, cb)`),
 * the pattern call carries its generated result-schema literal, and the
 * callback's returned object literal still holds bare identifiers (no
 * `.for(...)` wrapping yet). Everything the inference needs is syntax in one
 * file — no checker, no cross-stage state, no client-side heuristics later.
 *
 * The correlation is name-based within the file: result property → returned
 * value expression → (identifier → nearest const initializer, callback body
 * first, then module scope) → handler-factory application → the factory's
 * state-schema literal → a `scope: "session"` property assignment at any
 * depth. Every hop that does not match simply leaves the property unmarked —
 * the mark fails open, matching the read-path guard's certain-only stance.
 */
export class VerbTierMarkTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile, checker, factory, tsContext } = context;

    const moduleConsts = collectConstInitializers(sourceFile.statements);

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const kind = detectCallKind(node, checker);
        if (
          kind?.kind === "builder" && kind.builderName === "pattern" &&
          node.arguments.length >= 3
        ) {
          const updated = markPatternResultSchema(
            node,
            moduleConsts,
            checker,
            factory,
          );
          if (updated) {
            return visitEachChildWithJsx(updated, visit, tsContext);
          }
        }
      }
      return visitEachChildWithJsx(node, visit, tsContext);
    };

    return visit(sourceFile) as ts.SourceFile;
  }
}

/** Name → initializer for `const` declarations in a statement list. */
function collectConstInitializers(
  statements: readonly ts.Statement[],
): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        map.set(decl.name.text, decl.initializer);
      }
    }
  }
  return map;
}

function markPatternResultSchema(
  node: ts.CallExpression,
  moduleConsts: Map<string, ts.Expression>,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
): ts.CallExpression | undefined {
  const callbackArg = node.arguments[0];
  const resultSchemaArg = node.arguments[node.arguments.length - 1];
  if (!callbackArg || !resultSchemaArg) return undefined;

  const callback = unwrapExpr(callbackArg);
  if (
    !ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)
  ) return undefined;

  const returned = callbackReturnObjectLiteral(callback);
  if (!returned) return undefined;

  const bodyConsts = collectConstInitializers(callbackBodyStatements(callback));

  // Names the pattern's OWN schemas mark session-scoped: a handler that
  // binds one of these cells reads or writes per-session state, which is
  // very nearly the tier's definition — the factory's declared context
  // schema is scope-free precisely when the sessionness lives in the cell
  // passed at the application site.
  const sessionNames = new Set<string>();
  for (const schemaArg of node.arguments.slice(1)) {
    collectSessionScopedPropertyNames(unwrapExpr(schemaArg), sessionNames);
  }

  // Property names whose value resolves to a session-bound handler.
  const wrapperTier = new Set<string>();
  for (const property of returned.properties) {
    let name: string | undefined;
    let value: ts.Expression | undefined;
    if (ts.isShorthandPropertyAssignment(property)) {
      name = property.name.text;
      value = property.name;
    } else if (ts.isPropertyAssignment(property)) {
      name = staticPropertyName(property.name);
      value = property.initializer;
    }
    if (!name || !value) continue;
    if (
      resolvesToSessionBoundHandler(
        value,
        bodyConsts,
        moduleConsts,
        sessionNames,
        checker,
      )
    ) {
      wrapperTier.add(name);
    }
  }
  if (wrapperTier.size === 0) return undefined;

  const schemaLiteral = unwrapExpr(resultSchemaArg);
  if (!ts.isObjectLiteralExpression(schemaLiteral)) return undefined;
  const updatedSchema = addTierToStreamProperties(
    resultSchemaArg,
    schemaLiteral,
    wrapperTier,
    factory,
  );
  if (!updatedSchema) return undefined;

  const args = [...node.arguments];
  args[args.length - 1] = updatedSchema;
  return factory.updateCallExpression(
    node,
    node.expression,
    node.typeArguments,
    args,
  );
}

/**
 * The compile-time name of a property written as an identifier or a string
 * literal — the two static spellings an authored object literal uses. Both
 * passes of this transformer read names through this one helper so they
 * cannot disagree: a quoted verb name (`{ "open-composer": openComposer }`)
 * is as inferable as a bare one. A computed name returns `undefined` — the
 * inference names a verb or it names nothing.
 */
function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** Strip the transparent wrapper set to reach the expression a tier reads. */
function unwrapExpr(expr: ts.Expression): ts.Expression {
  return unwrapExpression(expr);
}

function callbackBodyStatements(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): readonly ts.Statement[] {
  return ts.isBlock(callback.body) ? callback.body.statements : [];
}

function callbackReturnObjectLiteral(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): ts.ObjectLiteralExpression | undefined {
  if (!ts.isBlock(callback.body)) {
    const expr = unwrapExpr(callback.body);
    return ts.isObjectLiteralExpression(expr) ? expr : undefined;
  }
  for (const statement of callback.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      const expr = unwrapExpr(statement.expression);
      if (ts.isObjectLiteralExpression(expr)) return expr;
    }
  }
  return undefined;
}

/** Property names inside a schema literal's `properties` whose schema
 * subtree carries `scope: "session"` at any depth. */
function collectSessionScopedPropertyNames(
  schema: ts.Expression,
  into: Set<string>,
): void {
  if (!ts.isObjectLiteralExpression(schema)) return;
  const propertiesEntry = schema.properties.find((p) =>
    ts.isPropertyAssignment(p) && staticPropertyName(p.name) === "properties"
  ) as ts.PropertyAssignment | undefined;
  if (!propertiesEntry) return;
  const props = unwrapExpr(propertiesEntry.initializer);
  if (!ts.isObjectLiteralExpression(props)) return;
  for (const property of props.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = staticPropertyName(property.name);
    if (name && containsSessionScope(property.initializer)) into.add(name);
  }
}

/**
 * Does this returned value resolve to an applied handler factory that binds
 * session-scoped state? Two independent signals, either suffices:
 * the factory's bound-state schema literal carries `scope: "session"` at any
 * depth (closure-lowered `action`s over session cells), or the APPLICATION
 * binds a cell the pattern's own schemas mark session-scoped (explicit
 * `handler(...)` factories, whose declared context is scope-free — the
 * sessionness lives in the argument).
 */
function resolvesToSessionBoundHandler(
  value: ts.Expression,
  bodyConsts: Map<string, ts.Expression>,
  moduleConsts: Map<string, ts.Expression>,
  sessionNames: ReadonlySet<string>,
  checker: ts.TypeChecker,
): boolean {
  const resolve = (expr: ts.Expression, depth: number): ts.Expression => {
    if (depth > 8) return expr;
    const unwrapped = unwrapExpr(expr);
    if (ts.isIdentifier(unwrapped)) {
      const next = bodyConsts.get(unwrapped.text) ??
        moduleConsts.get(unwrapped.text);
      if (next) return resolve(next, depth + 1);
    }
    return unwrapped;
  };

  // The value is the APPLICATION: factory({ bindings }) — possibly reached
  // through a const. The factory is the callee, possibly itself a const.
  const applied = resolve(value, 0);
  if (!ts.isCallExpression(applied)) return false;
  const factoryExpr = resolve(applied.expression, 0);
  if (!ts.isCallExpression(factoryExpr)) return false;

  const kind = detectCallKind(factoryExpr, checker);
  if (kind?.kind !== "builder" || kind.builderName !== "handler") return false;

  // Wrapper-tier requires a VOID event: a true composer wrapper's input IS
  // the session draft, so its event carries nothing (`false` for lowered
  // no-event actions, `asCell: ["opaque"]` for declared `handler<void, …>`).
  // Measured on the topics board: without this conjunct the inference marks
  // `addTopic` — the flagship headless verb — because it incidentally CLEARS
  // the composer draft after a create. A verb with a real event payload that
  // touches a session cell is doing its job, not wrapping a UI.
  const eventSchema = factoryExpr.arguments[0];
  if (!eventSchema || !eventSchemaIsVoid(unwrapExpr(eventSchema))) {
    return false;
  }

  // Signal 1 — handler(eventSchema, stateSchema, cb): the bound-state
  // schema literal itself.
  const stateSchema = factoryExpr.arguments[1];
  if (stateSchema && containsSessionScope(unwrapExpr(stateSchema))) {
    return true;
  }

  // Signal 2 — the application's argument object binds a session-scoped
  // cell by name (shorthand or identifier-valued assignment).
  const bindings = applied.arguments[0];
  if (bindings) {
    const literal = unwrapExpr(bindings);
    if (ts.isObjectLiteralExpression(literal)) {
      for (const property of literal.properties) {
        const bound = ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : ts.isPropertyAssignment(property) &&
              ts.isIdentifier(unwrapExpr(property.initializer))
          ? (unwrapExpr(property.initializer) as ts.Identifier).text
          : undefined;
        if (bound && sessionNames.has(bound)) return true;
      }
    }
  }
  return false;
}

/** AST scan: a `scope: "session"` property assignment anywhere below. */
function containsSessionScope(node: ts.Node): boolean {
  if (
    ts.isPropertyAssignment(node) &&
    staticPropertyName(node.name) === "scope" &&
    ts.isStringLiteral(node.initializer) &&
    node.initializer.text === "session"
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => containsSessionScope(child)) ?? false;
}

/**
 * Add `tier: "wrapper"` to each named property's schema inside the result
 * schema literal's `properties` block — but only where that property schema is
 * already stream-marked (`asCell` containing `"stream"`): the inference names
 * a verb or it names nothing.
 */
function addTierToStreamProperties(
  original: ts.Expression,
  schemaLiteral: ts.ObjectLiteralExpression,
  names: ReadonlySet<string>,
  factory: ts.NodeFactory,
): ts.Expression | undefined {
  let changed = false;

  const propertiesEntry = schemaLiteral.properties.find((p) =>
    ts.isPropertyAssignment(p) && staticPropertyName(p.name) === "properties"
  ) as ts.PropertyAssignment | undefined;
  if (!propertiesEntry) return undefined;
  const propsLiteral = unwrapExpr(propertiesEntry.initializer);
  if (!ts.isObjectLiteralExpression(propsLiteral)) return undefined;

  const updatedProps = propsLiteral.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) return property;
    const propName = staticPropertyName(property.name);
    if (!propName || !names.has(propName)) return property;
    const schema = unwrapExpr(property.initializer);
    if (!ts.isObjectLiteralExpression(schema)) return property;
    if (!isStreamMarkedLiteral(schema)) return property;
    if (hasProperty(schema, "tier")) return property;
    changed = true;
    return factory.updatePropertyAssignment(
      property,
      property.name,
      factory.updateObjectLiteralExpression(schema, [
        ...schema.properties,
        factory.createPropertyAssignment(
          factory.createIdentifier("tier"),
          factory.createStringLiteral("wrapper"),
        ),
      ]),
    );
  });
  if (!changed) return undefined;

  const updatedSchemaLiteral = factory.updateObjectLiteralExpression(
    schemaLiteral,
    schemaLiteral.properties.map((p) =>
      p === propertiesEntry
        ? factory.updatePropertyAssignment(
          propertiesEntry,
          propertiesEntry.name,
          factory.updateObjectLiteralExpression(propsLiteral, updatedProps),
        )
        : p
    ),
  );

  // Re-wrap: the original may be `as const satisfies JSONSchema`; rebuild the
  // outer expression around the updated literal by structural replacement.
  return rewrapLike(original, updatedSchemaLiteral, factory);
}

function isStreamMarkedLiteral(schema: ts.ObjectLiteralExpression): boolean {
  for (const property of schema.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      staticPropertyName(property.name) === "asCell" &&
      ts.isArrayLiteralExpression(property.initializer)
    ) {
      return property.initializer.elements.some((el) =>
        ts.isStringLiteral(el) && el.text === "stream"
      );
    }
  }
  return false;
}

function hasProperty(
  schema: ts.ObjectLiteralExpression,
  name: string,
): boolean {
  return schema.properties.some((p) =>
    ts.isPropertyAssignment(p) && staticPropertyName(p.name) === name
  );
}

/** Rebuild the original wrapper chain (paren / as / satisfies) around a
 * replacement literal. */
function rewrapLike(
  original: ts.Expression,
  replacement: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  if (ts.isParenthesizedExpression(original)) {
    return factory.updateParenthesizedExpression(
      original,
      rewrapLike(original.expression, replacement, factory),
    );
  }
  if (ts.isAsExpression(original)) {
    return factory.updateAsExpression(
      original,
      rewrapLike(original.expression, replacement, factory),
      original.type,
    );
  }
  if (ts.isSatisfiesExpression(original)) {
    return factory.updateSatisfiesExpression(
      original,
      rewrapLike(original.expression, replacement, factory),
      original.type,
    );
  }
  return replacement;
}

/** A void event schema: `false`, or an opaque-marked object (`void` lowers to
 * `{ asCell: ["opaque"] }`). */
function eventSchemaIsVoid(schema: ts.Expression): boolean {
  if (schema.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (!ts.isObjectLiteralExpression(schema)) return false;
  if (
    schema.properties.some((p) =>
      ts.isPropertyAssignment(p) && staticPropertyName(p.name) === "properties"
    )
  ) {
    return false;
  }
  return schema.properties.some((p) =>
    ts.isPropertyAssignment(p) &&
    staticPropertyName(p.name) === "asCell" &&
    ts.isArrayLiteralExpression(p.initializer) &&
    p.initializer.elements.some((el) =>
      ts.isStringLiteral(el) && el.text === "opaque"
    )
  );
}
