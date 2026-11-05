import { assertEquals } from "@std/assert";
import ts from "typescript";
import {
  isEventHandlerJsxAttribute,
  isEventHandlerType,
} from "../../src/ast/event-handlers.ts";

/**
 * Creates a TypeScript program from JSX source and returns utilities for testing.
 */
function createJsxTestProgram(jsxSource: string) {
  const fileName = "/test.tsx";
  const programSource = `
// Type definitions for testing
declare function handler<E, S>(fn: (event: E, state: S) => void): (state: S) => void;
declare const state: { count: number };

// Custom component with typed callback prop
interface CustomButtonProps {
  // Function props (all treated as handlers in Common Fabric JSX)
  callback: () => void;
  asyncCallback: () => Promise<void>;
  toggle: () => boolean;
  eventHandler: (event: MouseEvent) => void;
  mapper: (item: number) => string;
  renderItem: (item: number) => any;
  twoParamHandler: (event: MouseEvent, ctx: any) => void;
  reducer: (acc: number, item: number, index: number) => number;

  // Non-function props
  label: string;
  count: number;
}
declare function CustomButton(props: CustomButtonProps): JSX.Element;

// JSX intrinsic elements
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    button: {
      onClick?: (event: MouseEvent) => void;
      onSubmit?: (event: Event) => void;
      type?: string;
      children?: any;
    };
    div: {
      onClick?: (event: MouseEvent) => void;
      children?: any;
    };
    span: {
      children?: any;
    };
  }
}

declare class MouseEvent {}
declare class Event {}
declare class Promise<T> {}

// Test JSX
const element = ${jsxSource};
`;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    programSource,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? programSource : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();

  return { sourceFile, checker, program };
}

/**
 * Find a JSX attribute by name in the source file.
 */
function findJsxAttribute(
  sourceFile: ts.SourceFile,
  attrName: string,
): ts.JsxAttribute | undefined {
  let found: ts.JsxAttribute | undefined;

  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText() === attrName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

//
// Tests for isEventHandlerType
//

Deno.test("isEventHandlerType - function with 0-1 params is a handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} toggle={() => true} eventHandler={(e) => {}} label="test" count={1} mapper={(n) => String(n)} renderItem={(n) => n} twoParamHandler={(e, ctx) => {}} reducer={(acc, item, idx) => acc + item} />`,
  );

  // Functions with 0 or 1 parameters should be detected as handlers
  const handlerProps = [
    "callback", // 0 params
    "asyncCallback", // 0 params
    "toggle", // 0 params
    "eventHandler", // 1 param
    "mapper", // 1 param
    "renderItem", // 1 param
  ];

  for (const propName of handlerProps) {
    const attr = findJsxAttribute(sourceFile, propName);
    if (!attr?.initializer || !ts.isJsxExpression(attr.initializer)) {
      throw new Error(`${propName} attribute not found`);
    }

    const expr = attr.initializer.expression!;
    const contextualType = checker.getContextualType(expr);

    if (!contextualType) {
      throw new Error(`No contextual type for ${propName}`);
    }

    assertEquals(
      isEventHandlerType(contextualType, checker),
      true,
      `${propName} (function type with 0-1 params) should be detected as handler`,
    );
  }

  // Functions with 2+ parameters should NOT be detected as handlers
  const nonHandlerFunctionProps = [
    "twoParamHandler", // 2 params
    "reducer", // 3 params
  ];

  for (const propName of nonHandlerFunctionProps) {
    const attr = findJsxAttribute(sourceFile, propName);
    if (!attr?.initializer || !ts.isJsxExpression(attr.initializer)) {
      throw new Error(`${propName} attribute not found`);
    }

    const expr = attr.initializer.expression!;
    const contextualType = checker.getContextualType(expr);

    if (!contextualType) {
      throw new Error(`No contextual type for ${propName}`);
    }

    assertEquals(
      isEventHandlerType(contextualType, checker),
      false,
      `${propName} (function type with 2+ params) should NOT be detected as handler`,
    );
  }
});

Deno.test("isEventHandlerType - non-function type is NOT a handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} toggle={() => true} eventHandler={(e) => {}} label="test" count={1} mapper={(n) => String(n)} renderItem={(n) => n} twoParamHandler={(e, ctx) => {}} reducer={(acc, item, idx) => acc + item} />`,
  );

  // Non-function props should NOT be detected as handlers
  const nonFunctionProps = ["label", "count"];

  for (const propName of nonFunctionProps) {
    const attr = findJsxAttribute(sourceFile, propName);
    if (!attr?.initializer) {
      throw new Error(`${propName} attribute not found`);
    }

    // For string/number literals, get the type of the initializer
    let type: ts.Type | undefined;
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
      type = checker.getContextualType(attr.initializer.expression);
    } else if (ts.isStringLiteral(attr.initializer)) {
      type = checker.getTypeAtLocation(attr.initializer);
    }

    if (!type) {
      throw new Error(`No type for ${propName}`);
    }

    assertEquals(
      isEventHandlerType(type, checker),
      false,
      `${propName} (non-function type) should NOT be detected as handler`,
    );
  }
});

//
// Tests for isEventHandlerJsxAttribute - name-based detection
//

Deno.test("isEventHandlerJsxAttribute - onClick detected by name (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button onClick={() => console.log("clicked")}>Click</button>`,
  );

  const onClickAttr = findJsxAttribute(sourceFile, "onClick");
  if (!onClickAttr) {
    throw new Error("onClick attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(onClickAttr),
    true,
    "onClick should be detected by name without checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - onSubmit detected by name (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button onSubmit={() => console.log("submitted")}>Submit</button>`,
  );

  const onSubmitAttr = findJsxAttribute(sourceFile, "onSubmit");
  if (!onSubmitAttr) {
    throw new Error("onSubmit attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(onSubmitAttr),
    true,
    "onSubmit should be detected by name without checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - non-on attribute not detected (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button type="button">Click</button>`,
  );

  const typeAttr = findJsxAttribute(sourceFile, "type");
  if (!typeAttr) {
    throw new Error("type attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(typeAttr),
    false,
    "type attribute should NOT be detected as handler",
  );
});

//
// Tests for isEventHandlerJsxAttribute - type-based detection
//

Deno.test("isEventHandlerJsxAttribute - function prop detected by type (with checker)", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} toggle={() => true} eventHandler={(e) => {}} label="test" count={1} mapper={(n) => String(n)} renderItem={(n) => n} twoParamHandler={(e, ctx) => {}} reducer={(acc, item, idx) => acc + item} />`,
  );

  // Functions with 0 or 1 parameters should be detected as handlers with checker
  const handlerProps = [
    "callback", // 0 params
    "asyncCallback", // 0 params
    "toggle", // 0 params
    "eventHandler", // 1 param
    "mapper", // 1 param
    "renderItem", // 1 param
  ];

  for (const propName of handlerProps) {
    const attr = findJsxAttribute(sourceFile, propName);
    if (!attr) {
      throw new Error(`${propName} attribute not found`);
    }

    assertEquals(
      isEventHandlerJsxAttribute(attr, checker),
      true,
      `${propName} (function prop with 0-1 params) should be detected as handler with checker`,
    );
  }

  // Functions with 2+ parameters should NOT be detected as handlers
  const nonHandlerFunctionProps = [
    "twoParamHandler", // 2 params
    "reducer", // 3 params
  ];

  for (const propName of nonHandlerFunctionProps) {
    const attr = findJsxAttribute(sourceFile, propName);
    if (!attr) {
      throw new Error(`${propName} attribute not found`);
    }

    assertEquals(
      isEventHandlerJsxAttribute(attr, checker),
      false,
      `${propName} (function prop with 2+ params) should NOT be detected as handler with checker`,
    );
  }
});

Deno.test("isEventHandlerJsxAttribute - label (string prop) NOT detected as handler", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} toggle={() => true} eventHandler={(e) => {}} label="test" count={1} mapper={(n) => String(n)} renderItem={(n) => n} twoParamHandler={(e, ctx) => {}} reducer={(acc, item, idx) => acc + item} />`,
  );

  const labelAttr = findJsxAttribute(sourceFile, "label");
  if (!labelAttr) {
    throw new Error("label attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(labelAttr, checker),
    false,
    "label (string prop) should NOT be detected as handler",
  );
});
