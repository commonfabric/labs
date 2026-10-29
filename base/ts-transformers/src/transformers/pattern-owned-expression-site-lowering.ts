import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { rewritePatternOwnedExpressionSites } from "./expression-site-lowering.ts";

export class PatternOwnedExpressionSiteLoweringTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    return rewritePatternOwnedExpressionSites(context.sourceFile, context);
  }
}
