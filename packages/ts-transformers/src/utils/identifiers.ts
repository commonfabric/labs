import ts from "typescript";

const DEFAULT_FALLBACK = "_";

export interface SanitizeIdentifierOptions {
  readonly fallback?: string;
  readonly trimLeadingUnderscores?: boolean;
}

export interface UniqueIdentifierOptions extends SanitizeIdentifierOptions {
  readonly suffixSeparator?: string;
}

export function isSafeIdentifierText(name: string): boolean {
  if (name.length === 0) return false;
  const codePoints = Array.from(name);
  const first = codePoints[0]?.codePointAt(0);
  if (
    first === undefined ||
    !ts.isIdentifierStart(first, ts.ScriptTarget.ESNext)
  ) {
    return false;
  }
  for (const codePoint of codePoints.slice(1)) {
    const code = codePoint.codePointAt(0);
    if (
      code === undefined ||
      !ts.isIdentifierPart(code, ts.ScriptTarget.ESNext)
    ) {
      return false;
    }
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    name,
  );
  const token = scanner.scan();
  const isWholeToken = scanner.getTokenText().length === name.length;
  if (!isWholeToken) return true;
  return token < ts.SyntaxKind.FirstReservedWord ||
    token > ts.SyntaxKind.LastReservedWord;
}

export function sanitizeIdentifierCandidate(
  raw: string,
  options: SanitizeIdentifierOptions = {},
): string {
  const fallbackValue = options.fallback ?? DEFAULT_FALLBACK;

  const normalizeFallback = (value: string): string => {
    let text = value;
    if (options.trimLeadingUnderscores) {
      text = text.replace(/^_+/, "");
    }
    text = text.replace(/[^A-Za-z0-9_$]/g, "_");

    if (text.length === 0) {
      return DEFAULT_FALLBACK;
    }

    const first = text.codePointAt(0);
    if (
      first === undefined ||
      !ts.isIdentifierStart(first, ts.ScriptTarget.ESNext)
    ) {
      text = `${DEFAULT_FALLBACK}${text}`;
    }

    if (!isSafeIdentifierText(text)) {
      return DEFAULT_FALLBACK;
    }

    return text;
  };

  const fallback = normalizeFallback(fallbackValue);

  let candidate = raw;
  if (options.trimLeadingUnderscores) {
    candidate = candidate.replace(/^_+/, "");
  }

  candidate = candidate.replace(/[^A-Za-z0-9_$]/g, "_");

  if (candidate.length === 0) {
    candidate = fallback;
  }

  const ensureIdentifierStart = (text: string): string => {
    if (text.length === 0) return fallback;
    const first = text.codePointAt(0);
    if (
      first !== undefined &&
      ts.isIdentifierStart(first, ts.ScriptTarget.ESNext)
    ) {
      return text;
    }
    return `${fallback}${text}`;
  };

  candidate = ensureIdentifierStart(candidate);

  if (!isSafeIdentifierText(candidate)) {
    candidate = fallback;
  }

  let safe = candidate;
  while (!isSafeIdentifierText(safe)) {
    safe = ensureIdentifierStart(`${safe}_`);
  }

  return safe;
}

export function getUniqueIdentifier(
  candidate: string,
  used: Set<string>,
  options: UniqueIdentifierOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  const separator = options.suffixSeparator ?? "_";

  const base = sanitizeIdentifierCandidate(candidate, options);
  let name = base.length > 0
    ? base
    : sanitizeIdentifierCandidate(fallback, options);

  if (used.has(name)) {
    let index = 1;
    while (true) {
      const next = sanitizeIdentifierCandidate(
        `${name}${separator}${index++}`,
        { ...options, fallback },
      );
      if (!used.has(next)) {
        name = next;
        break;
      }
    }
  }

  used.add(name);
  return name;
}

export function maybeReuseIdentifier(
  identifier: ts.Identifier,
  used: Set<string>,
): ts.Identifier {
  if (!used.has(identifier.text) && isSafeIdentifierText(identifier.text)) {
    used.add(identifier.text);
    return identifier;
  }
  const fresh = getUniqueIdentifier(identifier.text, used);
  return ts.factory.createIdentifier(fresh);
}

export function createPropertyName(
  name: string,
  factory: ts.NodeFactory,
): ts.PropertyName {
  return isSafeIdentifierText(name)
    ? factory.createIdentifier(name)
    : factory.createStringLiteral(name);
}

export interface ReserveIdentifierOptions extends UniqueIdentifierOptions {
  readonly emptyFallback?: string;
}

export function reserveIdentifier(
  candidate: string,
  used: Set<string>,
  factory: ts.NodeFactory,
  options: ReserveIdentifierOptions = {},
): ts.Identifier {
  if (isSafeIdentifierText(candidate) && !used.has(candidate)) {
    used.add(candidate);
    return factory.createIdentifier(candidate);
  }

  const emptyFallback = options.emptyFallback ?? "ref";
  const baseCandidate = candidate.length > 0 ? candidate : emptyFallback;

  const unique = getUniqueIdentifier(baseCandidate, used, {
    ...options,
    fallback: emptyFallback,
  });
  return factory.createIdentifier(unique);
}

/**
 * Creates binding elements for object destructuring from property names.
 * Handles safe identifier vs string literal property names automatically.
 *
 * @param names - Property names to create bindings for
 * @param factory - TypeScript node factory
 * @param createBindingName - Callback to generate the binding identifier/pattern for each property
 * @returns Array of binding elements suitable for createObjectBindingPattern
 */
export function createBindingElementsFromNames(
  names: Iterable<string>,
  factory: ts.NodeFactory,
  createBindingName: (propertyName: string) => ts.BindingName,
): ts.BindingElement[] {
  const elements: ts.BindingElement[] = [];
  for (const name of names) {
    const propertyName = isSafeIdentifierText(name)
      ? undefined
      : createPropertyName(name, factory);
    elements.push(
      factory.createBindingElement(
        undefined,
        propertyName,
        createBindingName(name),
        undefined,
      ),
    );
  }
  return elements;
}

export interface ParameterFromBindingsOptions {
  readonly type?: ts.TypeNode;
}

/**
 * Creates a parameter declaration with object binding pattern from binding elements.
 *
 * @param bindings - Binding elements for the parameter
 * @param factory - TypeScript node factory
 * @param options - Optional configuration
 * @returns Parameter declaration with object binding pattern
 */
export function createParameterFromBindings(
  bindings: readonly ts.BindingElement[],
  factory: ts.NodeFactory,
  options: ParameterFromBindingsOptions = {},
): ts.ParameterDeclaration {
  return factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern([...bindings]),
    undefined,
    options.type,
    undefined,
  );
}

/**
 * Generate both property name and param name for an expression,
 * following the standard pattern used across lift-applied/reactive bindings.
 *
 * @param expressionText - Base text from the expression (typically from getExpressionText)
 * @param isIdentifier - Whether the expression is a simple identifier
 * @param index - Index for fallback naming (e.g., ref1, ref2, _v1, _v2)
 * @param usedPropertyNames - Set of used property names (mutated)
 * @param usedParamNames - Set of used param names (mutated)
 * @returns Object with propertyName and paramName
 */
export function createPropertyParamNames(
  expressionText: string,
  isIdentifier: boolean,
  index: number,
  usedPropertyNames: Set<string>,
  usedParamNames: Set<string>,
): { propertyName: string; paramName: string } {
  // Property name: use expression text with dots replaced by underscores
  const baseName = expressionText.replace(/\./g, "_");
  const propertyName = getUniqueIdentifier(baseName, usedPropertyNames, {
    fallback: `ref${index + 1}`,
    trimLeadingUnderscores: true,
  });

  // Param name: use identifier text directly, or fallback to _v1, _v2, etc.
  const paramCandidate = isIdentifier ? expressionText : `_v${index + 1}`;
  const paramName = getUniqueIdentifier(paramCandidate, usedParamNames, {
    fallback: `_v${index + 1}`,
  });

  return { propertyName, paramName };
}

export function normalizeBindingName(
  name: ts.BindingName,
  factory: ts.NodeFactory,
  used: Set<string>,
): ts.BindingName {
  if (ts.isIdentifier(name)) {
    return maybeReuseIdentifier(name, used);
  }

  if (ts.isObjectBindingPattern(name)) {
    const elements = name.elements.map((element) =>
      factory.createBindingElement(
        element.dotDotDotToken,
        element.propertyName,
        normalizeBindingName(element.name, factory, used),
        element.initializer as ts.Expression | undefined,
      )
    );
    return factory.createObjectBindingPattern(elements);
  }

  if (ts.isArrayBindingPattern(name)) {
    const elements = name.elements.map((element) => {
      if (ts.isOmittedExpression(element)) {
        return element;
      }
      if (ts.isBindingElement(element)) {
        return factory.createBindingElement(
          element.dotDotDotToken,
          element.propertyName,
          normalizeBindingName(element.name, factory, used),
          element.initializer as ts.Expression | undefined,
        );
      }
      return element;
    });
    return factory.createArrayBindingPattern(elements);
  }

  return name;
}

export function extractBindingNames(binding: ts.BindingName): string[] {
  if (ts.isIdentifier(binding)) {
    return [binding.text];
  }

  const names: string[] = [];

  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      for (const name of extractBindingNames(element.name)) names.push(name);
    }
  } else if (ts.isArrayBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      for (const name of extractBindingNames(element.name)) names.push(name);
    }
  }

  return names;
}
