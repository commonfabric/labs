/**
 * JSX Prop Name Validation Transformer
 *
 * Reports a compile-time error for a hyphenated prop on an intrinsic element,
 * such as `<cf-resizable-panel default-size={28}>`, unless it is an event
 * (`oncf-change`) or a `data-*` or `aria-*` attribute.
 *
 * The renderer sets a JSX prop as the element's property of the same name,
 * and no property name holds a hyphen, so such a prop adds a property nothing
 * reads and the element keeps its default. TypeScript does not report it
 * either: a hyphenated JSX name the element's type does not declare is
 * accepted unchecked. Refusing the hyphenated form leaves the property name
 * as the one spelling, and TypeScript checks that one against the element's
 * declared props.
 *
 * `@commonfabric/pattern-contract/jsx-prop-names` holds the rule, which the
 * renderer applies too.
 */

import ts from "typescript";
import {
  camelCasePropName,
  isMisnamedPropName,
} from "@commonfabric/pattern-contract/jsx-prop-names";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";

export class JsxPropNameValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node)) this.#validate(node, context);
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
    return context.sourceFile;
  }

  #validate(attribute: ts.JsxAttribute, context: TransformationContext): void {
    if (!ts.isIdentifier(attribute.name)) return;
    const name = attribute.name.text;
    if (!isMisnamedPropName(name)) return;
    const element = attribute.parent.parent;
    const tag = element.tagName;
    // A component's props are its parameter's fields, which may hold any
    // name; only an element's are its properties.
    if (!ts.isIdentifier(tag) || !isIntrinsicTagName(tag.text)) return;

    const property = camelCasePropName(name);
    const declared = context.checker.getContextualType(attribute.parent);
    const known = declared !== undefined &&
      context.checker.getPropertyOfType(
          context.checker.getApparentType(declared),
          property,
        ) !== undefined;
    context.reportDiagnostic({
      severity: "error",
      type: "jsx:misnamed-prop",
      message: known
        ? `\`${name}\` names no property of <${tag.text}>, so it would ` +
          `do nothing. A JSX prop sets the property of its name: write ` +
          `\`${property}\`.`
        : `\`${name}\` names no property of <${tag.text}>, so it would ` +
          `do nothing, and <${tag.text}> declares no \`${property}\` ` +
          `either. A JSX prop sets the property of its name; only ` +
          `\`data-*\`, \`aria-*\` and event (\`on…\`) props hold a hyphen.`,
      node: attribute,
    });
  }
}

/** Whether a JSX tag names an element rather than a component, as
 * TypeScript decides it: a lower-case first letter, or a hyphen. */
function isIntrinsicTagName(tag: string): boolean {
  return /^[a-z]/.test(tag) || tag.includes("-");
}
