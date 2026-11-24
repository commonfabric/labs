import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import {
  calleeName,
  callsMatching,
  callsNamed,
  collect,
  isImmediatelyInvokedFunction,
  parseModule,
} from "../transformed-ast.ts";
import { validateSource } from "../utils.ts";

const HEAD = `/// <cts-enable />
import { pattern, str, UI } from "commonfabric";
`;

async function compile(body: string) {
  const { diagnostics, output } = await validateSource(HEAD + body, {
    types: COMMONFABRIC_TYPES,
  });
  return { diagnostics, output: parseModule(output) };
}

/**
 * The runtime `whenTrue` argument of the single `ifElse` call that a JSX
 * ternary `flag ? <branch> : <i />` lowers to.
 */
async function loweredTrueBranch(branch: string): Promise<ts.Expression> {
  const { output } = await compile(`
interface Input { count: number; flag: boolean }
export default pattern<Input>(({ count, flag }) => {
  return { [UI]: <div>{flag ? ${branch} : <i />}</div> };
});`);
  const [ifElse] = callsNamed(output, "ifElse");
  if (!ifElse) throw new Error("expected an ifElse call");
  // Schemas come first; the runtime arguments are the last three.
  return ifElse.arguments[ifElse.arguments.length - 2]!;
}

function isLiftCall(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) &&
    /^__cfLift/.test(calleeName(expression) ?? "");
}

describe("expression-site-policy", () => {
  describe("JSX ternaries whose branch is an immediately invoked function", () => {
    it("keeps a block-bodied function returning JSX inline", async () => {
      // The whole branch is one unit the ternary routes as is.
      const branch = await loweredTrueBranch(
        "(() => { const d = 2; return <b>{count + d}</b>; })()",
      );

      expect(
        ts.isCallExpression(branch) && isImmediatelyInvokedFunction(branch),
      ).toBe(true);
    });

    it("lifts an expression-bodied function", async () => {
      const branch = await loweredTrueBranch("(() => <b>{count}</b>)()");

      expect(isLiftCall(branch)).toBe(true);
    });

    it("lifts a function invoked through optional chaining", async () => {
      const branch = await loweredTrueBranch(
        "(() => { return <b>{count}</b>; })?.()",
      );

      expect(isLiftCall(branch)).toBe(true);
    });

    it("lifts a function whose last statement returns a non-JSX value", async () => {
      const branch = await loweredTrueBranch("(() => { return count; })()");

      expect(isLiftCall(branch)).toBe(true);
    });
  });

  describe("tagged template interpolations", () => {
    it("lifts a computed interpolation of a reactive-origin tag", async () => {
      const { output } = await compile(`
interface Input { n: number }
export default pattern<Input>(({ n }) => {
  const label = str\`count \${n * 2}\`;
  return { label };
});`);

      const [template] = collect(output, ts.isTaggedTemplateExpression);
      if (!template || !ts.isTemplateExpression(template.template)) {
        throw new Error("expected a tagged template with a span");
      }
      expect(isLiftCall(template.template.templateSpans[0]!.expression)).toBe(
        true,
      );
    });

    it("leaves a computed interpolation of a plain function tag unlifted", async () => {
      // A plain tag reads its values once, so the span is no reactive site;
      // the computation stays in place and is reported instead.
      const { output, diagnostics } = await compile(`
function tag(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.join("") + values.length;
}
interface Input { n: number }
export default pattern<Input>(({ n }) => {
  const label = tag\`count \${n * 2}\`;
  return { label };
});`);

      const [template] = collect(output, ts.isTaggedTemplateExpression);
      if (!template || !ts.isTemplateExpression(template.template)) {
        throw new Error("expected a tagged template with a span");
      }
      const span = template.template.templateSpans[0]!.expression;
      expect(ts.isBinaryExpression(span)).toBe(true);
      expect(callsMatching(output, /^__cfLift/)).toEqual([]);
      expect(diagnostics.map((d) => d.type)).toEqual([
        "pattern-context:computation",
      ]);
    });
  });
});
