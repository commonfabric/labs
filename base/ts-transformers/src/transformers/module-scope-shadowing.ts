import { SHADOWED_FACTORY_BINDINGS } from "@commonfabric/utils/sandbox-contract";
import ts from "typescript";

import { TransformationContext, Transformer } from "../core/mod.ts";

export class ModuleScopeShadowingTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const statements = [...sourceFile.statements];
    const insertAt = findFactoryGuardInsertionIndex(statements);
    const guards = SHADOWED_FACTORY_BINDINGS.map((name: string) =>
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(name),
              undefined,
              undefined,
              factory.createIdentifier("undefined"),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      )
    );

    return factory.updateSourceFile(
      sourceFile,
      [
        ...statements.slice(0, insertAt),
        ...guards,
        ...statements.slice(insertAt),
      ],
    );
  }
}

function findFactoryGuardInsertionIndex(
  statements: readonly ts.Statement[],
): number {
  let index = 0;
  while (
    index < statements.length && ts.isImportDeclaration(statements[index])
  ) {
    index += 1;
  }
  return index;
}
