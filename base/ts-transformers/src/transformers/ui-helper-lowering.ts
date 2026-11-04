import ts from "typescript";
import type { SchemaHint, TransformationContext } from "../core/mod.ts";
import { preserveSourceMapRange, visitEachChildWithJsx } from "../ast/mod.ts";

type UiHelperName = "UiAction" | "UiPromptSlot" | "UiDisclosure";

type UiHelperSpec = {
  readonly helper: UiHelperName;
  readonly defaultTag: string;
  readonly helperProps: readonly string[];
  readonly dataAttrs: readonly {
    readonly prop: string;
    readonly attr: string;
  }[];
};

const UI_HELPERS: Readonly<Record<UiHelperName, UiHelperSpec>> = {
  UiAction: {
    helper: "UiAction",
    defaultTag: "ct-button",
    helperProps: ["as", "action"],
    dataAttrs: [{ prop: "action", attr: "data-ui-action" }],
  },
  UiPromptSlot: {
    helper: "UiPromptSlot",
    defaultTag: "ct-textarea",
    helperProps: ["as", "surface", "role"],
    dataAttrs: [
      { prop: "surface", attr: "data-ui-surface" },
      { prop: "role", attr: "data-ui-role" },
    ],
  },
  UiDisclosure: {
    helper: "UiDisclosure",
    defaultTag: "ct-card",
    helperProps: ["as", "kind"],
    dataAttrs: [{ prop: "kind", attr: "data-ui-disclosure-kind" }],
  },
};

type RewrittenUiHelperResult = {
  readonly node: ts.JsxElement | ts.JsxSelfClosingElement;
  readonly hint?: SchemaHint;
};

export function rewriteUiHelperElement(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  context: TransformationContext,
  visit: ts.Visitor,
): RewrittenUiHelperResult | undefined {
  const visited = visitEachChildWithJsx(node, visit, context.tsContext) as
    | ts.JsxElement
    | ts.JsxSelfClosingElement;
  const spec = getUiHelperSpec(visited);
  if (!spec) {
    return undefined;
  }

  const attrs = getJsxAttributes(visited);
  const asValue = getStringLiteralAttributeValue(attrs, "as");
  const tagName = asValue?.text ?? spec.defaultTag;
  const dataAttrs = spec.dataAttrs.flatMap((entry) => {
    const attr = getJsxAttribute(attrs, entry.prop);
    if (!attr || attr.initializer === undefined) {
      return [];
    }
    // The data attribute stands at the authored helper prop's site, so it
    // carries that prop's range; the identifier is a new name and stays
    // synthetic.
    return [preserveSourceMapRange(
      context.factory.createJsxAttribute(
        context.factory.createIdentifier(entry.attr),
        createJsxAttributeInitializer(attr.initializer, context.factory),
      ),
      attr,
    )];
  });

  const preservedAttributes = attrs.properties.filter((attribute) =>
    !isHelperOnlyAttribute(attribute, spec)
  );

  const nextAttributes = context.factory.createJsxAttributes([
    ...dataAttrs,
    ...preservedAttributes,
  ]);
  const hint = createUiContractHint(spec, attrs);

  if (ts.isJsxSelfClosingElement(visited) && !hasJsxChildren(node)) {
    return {
      node: preserveSourceMapRange(
        context.factory.createJsxSelfClosingElement(
          context.factory.createIdentifier(tagName),
          visited.typeArguments,
          nextAttributes,
        ),
        visited,
      ),
      hint,
    };
  }

  if (ts.isJsxElement(visited)) {
    return {
      node: preserveSourceMapRange(
        context.factory.createJsxElement(
          context.factory.createJsxOpeningElement(
            context.factory.createIdentifier(tagName),
            visited.openingElement.typeArguments,
            nextAttributes,
          ),
          visited.children,
          context.factory.createJsxClosingElement(
            context.factory.createIdentifier(tagName),
          ),
        ),
        visited,
      ),
      hint,
    };
  }

  return undefined;
}

function getUiHelperSpec(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): UiHelperSpec | undefined {
  const tagName = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : node.tagName;
  if (!ts.isIdentifier(tagName)) {
    return undefined;
  }
  return UI_HELPERS[tagName.text as UiHelperName];
}

function getJsxAttributes(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): ts.JsxAttributes {
  return ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
}

function getJsxAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  for (const attribute of attributes.properties) {
    if (
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === name
    ) {
      return attribute;
    }
  }
  return undefined;
}

function getStringLiteralAttributeValue(
  attributes: ts.JsxAttributes,
  name: string,
): ts.StringLiteral | undefined {
  const attr = getJsxAttribute(attributes, name);
  if (!attr || attr.initializer === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(attr.initializer)) {
    return attr.initializer;
  }
  if (
    ts.isJsxExpression(attr.initializer) &&
    attr.initializer.expression &&
    ts.isStringLiteral(attr.initializer.expression)
  ) {
    return attr.initializer.expression;
  }
  return undefined;
}

/**
 * Rebuilds a helper prop's value for the data attribute that replaces it. Each
 * rebuilt node stands at the authored initializer's site, so it carries that
 * range — source-map range only, never text range or original-node identity.
 */
function createJsxAttributeInitializer(
  initializer: ts.JsxAttributeValue,
  factory: ts.NodeFactory,
): ts.JsxAttributeValue {
  if (ts.isStringLiteral(initializer)) {
    return preserveSourceMapRange(
      factory.createStringLiteral(initializer.text),
      initializer,
    );
  }
  if (ts.isJsxExpression(initializer)) {
    return preserveSourceMapRange(
      factory.createJsxExpression(
        initializer.dotDotDotToken,
        initializer.expression,
      ),
      initializer,
    );
  }
  return initializer;
}

function isHelperOnlyAttribute(
  attribute: ts.JsxAttributeLike,
  spec: UiHelperSpec,
): boolean {
  if (!ts.isJsxAttribute(attribute)) {
    return false;
  }
  return ts.isIdentifier(attribute.name) &&
    spec.helperProps.includes(attribute.name.text);
}

function hasJsxChildren(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): boolean {
  return ts.isJsxElement(node) && node.children.length > 0;
}

function createUiContractHint(
  spec: UiHelperSpec,
  attributes: ts.JsxAttributes,
): SchemaHint | undefined {
  const hint: Partial<NonNullable<SchemaHint["cfcUiContract"]>> = {
    helper: spec.helper,
  };
  for (const entry of spec.dataAttrs) {
    const literal = getStringLiteralAttributeValue(attributes, entry.prop);
    if (!literal) {
      return undefined;
    }
    (hint as Record<string, string>)[entry.prop] = literal.text;
  }

  return { cfcUiContract: hint as SchemaHint["cfcUiContract"] };
}
