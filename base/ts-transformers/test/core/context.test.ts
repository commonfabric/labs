import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { TransformationContext } from "../../src/core/context.ts";
import { CrossStageState } from "../../src/core/cross-stage-state.ts";

/** Records the symbols the context marks as synthetic reactive collections. */
class RecordingState extends CrossStageState {
  readonly marked: ts.Symbol[] = [];

  override markSyntheticReactiveCollection(symbol: ts.Symbol): void {
    this.marked.push(symbol);
    super.markSyntheticReactiveCollection(symbol);
  }
}

function contextFor(source: string) {
  const fileName = "/context.ts";
  const options: ts.CompilerOptions = { noLib: true, strict: true };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
  );
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.fileExists = (name) => name === fileName;
  const program = ts.createProgram([fileName], options, host);
  const state = new RecordingState();
  let built: TransformationContext | undefined;
  ts.transform(sourceFile, [(tsContext) => {
    built = new TransformationContext({
      program,
      sourceFile,
      tsContext,
      options: { state },
    });
    return (file) => file;
  }]);
  if (!built) throw new Error("The transformation did not run.");
  const context = built;
  const find = <T extends ts.Node>(
    guard: (node: ts.Node) => node is T,
    predicate: (node: T) => boolean,
  ): T => {
    let found: T | undefined;
    const visit = (node: ts.Node): void => {
      if (!found && guard(node) && predicate(node)) found = node;
      else ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!found) throw new Error("Node not found");
    return found;
  };
  const read = (name: string): ts.Identifier =>
    find(
      ts.isIdentifier,
      (node) => node.text === name && ts.isReturnStatement(node.parent),
    );
  return { context, state, checker: program.getTypeChecker(), find, read };
}

describe("context", () => {
  describe("TransformationContext", () => {
    describe("instance members", () => {
      describe("markSyntheticReactiveCollectionDeclaration()", () => {
        it("marks the symbol of a declaration or identifier that resolves to one", () => {
          const { context, state, checker, find } = contextFor(
            "const items = [1]; function read() { return items; }",
          );
          const declaration = find(ts.isVariableDeclaration, () => true);
          const symbol = checker.getSymbolAtLocation(declaration.name);

          context.markSyntheticReactiveCollectionDeclaration(declaration);
          context.markSyntheticReactiveCollectionDeclaration(
            find(ts.isIdentifier, (node) => ts.isReturnStatement(node.parent)),
          );

          expect(symbol).toBeDefined();
          expect(state.marked).toEqual([symbol, symbol]);
        });

        it("marks nothing for a node with no resolvable symbol", () => {
          const { context, state, find } = contextFor(
            "declare const pair: number[]; const [first] = pair;",
          );

          context.markSyntheticReactiveCollectionDeclaration(
            find(
              ts.isVariableDeclaration,
              (node) => ts.isArrayBindingPattern(node.name),
            ),
          );
          context.markSyntheticReactiveCollectionDeclaration(
            ts.factory.createIdentifier("pair"),
          );
          context.markSyntheticReactiveCollectionDeclaration(
            find(ts.isArrayBindingPattern, () => true),
          );

          expect(state.marked).toEqual([]);
        });
      });

      describe("isArrayMethodElementBindingReference()", () => {
        it("returns `true` for the first parameter of a marked callback, plain or destructured", () => {
          const { context, read } = contextFor(
            `const plain = (item: number, index: number) => { return item; };
             const destructured = ({ id }: { id: number }) => { return id; };
             const second = (item: number, index: number) => { return index; };`,
          );
          const arrows: ts.ArrowFunction[] = [];
          const collect = (node: ts.Node): void => {
            if (ts.isArrowFunction(node)) arrows.push(node);
            ts.forEachChild(node, collect);
          };
          collect(context.sourceFile);
          for (const arrow of arrows) context.markAsArrayMethodCallback(arrow);

          expect(context.isArrayMethodElementBindingReference(read("item")))
            .toBe(true);
          expect(context.isArrayMethodElementBindingReference(read("id")))
            .toBe(true);
          expect(context.isArrayMethodElementBindingReference(read("index")))
            .toBe(false);
        });

        it("returns `false` for a destructured binding outside any function", () => {
          const { context, read, find } = contextFor(
            `declare const record: { id: number };
             const { id } = record;
             const show = () => { return id; };`,
          );
          context.markAsArrayMethodCallback(
            find(ts.isArrowFunction, () => true),
          );

          expect(context.isArrayMethodElementBindingReference(read("id")))
            .toBe(false);
        });
      });
    });
  });
});
