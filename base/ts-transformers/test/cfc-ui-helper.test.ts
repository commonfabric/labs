import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import {
  CommonFabricTransformerPipeline,
  CrossStageState,
  transformCfDirective,
} from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";
import { collect, parseModule, patternSchemas } from "./transformed-ast.ts";

/** Every JSX tag name (opening/self-closing) appearing under `root`. */
function jsxTagNames(root: ts.Node): string[] {
  const names: string[] = [];
  const add = (tagName: ts.JsxTagNameExpression): void => {
    if (ts.isIdentifier(tagName)) names.push(tagName.text);
  };
  for (const element of collect(root, ts.isJsxElement)) {
    add(element.openingElement.tagName);
  }
  for (const element of collect(root, ts.isJsxSelfClosingElement)) {
    add(element.tagName);
  }
  return names;
}

/**
 * A JSX opening or self-closing element under `root` whose tag is `tag`.
 * Fails when the count is not exactly one.
 */
function soleJsxElement(
  root: ts.Node,
  tag: string,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  const openings = collect(root, ts.isJsxElement)
    .map((element) => element.openingElement)
    .filter((opening) =>
      ts.isIdentifier(opening.tagName) && opening.tagName.text === tag
    );
  const selfClosing = collect(root, ts.isJsxSelfClosingElement).filter((
    element,
  ) => ts.isIdentifier(element.tagName) && element.tagName.text === tag);
  const all = [...openings, ...selfClosing];
  assertEquals(all.length, 1, `expected exactly one <${tag}>`);
  return all[0]!;
}

/**
 * The value of attribute `name` on a JSX element. Returns `{ literal }` for a
 * string-literal value, `{ dynamic: true }` for a `{...}` expression value, and
 * `{}` when the attribute is absent — so a missing, literal, and dynamic
 * attribute are all distinguishable.
 */
function jsxAttr(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): { literal: string } | { dynamic: true } | Record<string, never> {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
    const initializer = attr.initializer;
    if (initializer && ts.isStringLiteral(initializer)) {
      return { literal: initializer.text };
    }
    return { dynamic: true };
  }
  return {};
}

function createProgram(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const fileName = "/test.tsx";
  const transformedSource = transformCfDirective(source);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "__cfHelpers.h",
    jsxFragmentFactory: "__cfHelpers.h.fragment",
    strict: true,
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictBindCallApply: true,
    strictPropertyInitialization: true,
    noImplicitThis: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const rootFiles = [fileName, ...Object.keys(COMMONFABRIC_TYPES)];
  const sourceFiles = new Map<string, string>([
    [fileName, transformedSource],
    ...Object.entries(COMMONFABRIC_TYPES),
  ]);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    name,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const sourceText = sourceFiles.get(name);
    if (sourceText !== undefined) {
      return ts.createSourceFile(name, sourceText, languageVersion, true);
    }
    return originalGetSourceFile(
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (name) => sourceFiles.get(name) ?? originalReadFile(name);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sourceFiles.has(name) || originalFileExists(name);
  host.resolveModuleNames = (moduleNames) =>
    moduleNames.map((name) => {
      if (name === "commonfabric") {
        return {
          resolvedFileName: "commonfabric.d.ts",
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }
      return undefined;
    });

  const program = ts.createProgram(rootFiles, compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error("Missing source file for UI helper test");
  }

  return { program, sourceFile };
}

Deno.test(
  "UI helpers lower to intrinsic tags and emit data-ui markers",
  async () => {
    const source = `/// <cts-enable />
      import { UiAction, UiDisclosure, UiPromptSlot } from "commonfabric";

      export default () => (
        <div>
          <UiAction action="SubmitDirectCommand" onClick={() => null}>Go</UiAction>
          <UiPromptSlot surface="PromptPane" role="assistant" />
          <UiDisclosure kind="warning">Heads up</UiDisclosure>
        </div>
      );
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    assertEquals(
      jsxAttr(soleJsxElement(root, "ct-button"), "data-ui-action"),
      { literal: "SubmitDirectCommand" },
    );
    const textarea = soleJsxElement(root, "ct-textarea");
    assertEquals(jsxAttr(textarea, "data-ui-surface"), {
      literal: "PromptPane",
    });
    assertEquals(jsxAttr(textarea, "data-ui-role"), { literal: "assistant" });
    const card = soleJsxElement(root, "ct-card");
    assertEquals(jsxAttr(card, "data-ui-disclosure-kind"), {
      literal: "warning",
    });
    const cardChild = (card as ts.JsxOpeningElement).parent as ts.JsxElement;
    assertEquals(
      cardChild.children.map((child) => child.getText()).join(""),
      "Heads up",
    );
    for (const helper of ["UiAction", "UiPromptSlot", "UiDisclosure"]) {
      assertEquals(jsxTagNames(root).includes(helper), false);
    }
  },
);

Deno.test(
  "UI helper literal props seed cfcUiContract hints but dynamic props do not",
  () => {
    const source = `/// <cts-enable />
      import { UiAction } from "commonfabric";

      const dynamicAction = "SubmitDirectCommand";

      export default () => (
        <div>
          <UiAction action="SubmitDirectCommand" />
          <UiAction action={dynamicAction} />
        </div>
      );
    `;

    const { program, sourceFile } = createProgram(source);
    const state = new CrossStageState();
    const schemaHints = state.schemaHints;
    const pipeline = new CommonFabricTransformerPipeline({ state });

    const result = ts.transform(sourceFile, pipeline.toFactories(program));
    const transformedFile = result.transformed[0];
    assert(transformedFile, "Expected transformed source file");

    const helperNodes = [] as Array<ts.JsxElement | ts.JsxSelfClosingElement>;
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
        (
          (ts.isJsxElement(node) &&
            ts.isIdentifier(node.openingElement.tagName) &&
            node.openingElement.tagName.text === "ct-button") ||
          (ts.isJsxSelfClosingElement(node) &&
            ts.isIdentifier(node.tagName) &&
            node.tagName.text === "ct-button")
        )
      ) {
        helperNodes.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(transformedFile);

    assertEquals(helperNodes.length, 2);
    const literalHint = schemaHints.get(helperNodes[0] as ts.Node);
    const dynamicHint = schemaHints.get(helperNodes[1] as ts.Node);

    assertEquals(
      literalHint,
      {
        cfcUiContract: {
          helper: "UiAction",
          action: "SubmitDirectCommand",
        },
      },
    );
    assertEquals(dynamicHint, undefined);

    result.dispose?.();
  },
);

Deno.test(
  "UI helper contract hints propagate onto generated schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, UI, UiAction } from "commonfabric";

      export default pattern<{ title: string }>((state) => ({
        [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
        title: state.title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const { output: outputSchema } = patternSchemas(parseModule(output));

    assertEquals((outputSchema.ifc as Record<string, unknown>).uiContract, {
      helper: "UiAction",
      action: "SubmitDirectCommand",
    });
  },
);

Deno.test(
  "UI helper contract hints require all required semantic props to be literal",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, UI, UiPromptSlot } from "commonfabric";

      const dynamicRole = "assistant";

      export default pattern<{ title: string }>((state) => ({
        [UI]: <UiPromptSlot surface="PromptPane" role={dynamicRole} />,
        title: state.title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);

    const textarea = soleJsxElement(root, "ct-textarea");
    assertEquals(jsxAttr(textarea, "data-ui-surface"), {
      literal: "PromptPane",
    });
    assertEquals(jsxAttr(textarea, "data-ui-role"), { dynamic: true });
    const { output: outputSchema } = patternSchemas(root);
    assertEquals(
      (outputSchema.ifc as Record<string, unknown> | undefined)?.uiContract,
      undefined,
    );
  },
);

Deno.test(
  "UI helper contract hints also reach explicit output schemas",
  async () => {
    const source = `/// <cts-enable />
      import { pattern, UI, UiAction } from "commonfabric";

      type Model = { title: string };

      export default pattern<Model, Model>((state) => ({
        [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
        title: state.title,
      }));
    `;

    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const { output: outputSchema } = patternSchemas(parseModule(output));

    assertEquals((outputSchema.ifc as Record<string, unknown>).uiContract, {
      helper: "UiAction",
      action: "SubmitDirectCommand",
    });
  },
);
