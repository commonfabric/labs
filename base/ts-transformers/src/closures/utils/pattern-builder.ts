import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import { preserveSourceMapRange } from "../../ast/mod.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  createBindingElementsFromNames,
  createParameterFromBindings,
  extractBindingNames,
  normalizeBindingName,
  reserveIdentifier,
} from "../../utils/identifiers.ts";

export interface PatternParameter {
  name: string; // The property name in the destructured object (e.g. "element", "index")
  bindingName?: ts.BindingName; // The local variable name (e.g. "el", "i")
  propertyName?: string; // Optional override for the property name if different from 'name'
  initializer?: ts.Expression; // Optional default value
}

export class PatternBuilder {
  #parameters: PatternParameter[] = [];
  #captureTree: Map<string, CaptureTreeNode> = new Map();
  #usedBindingNames = new Set<string>();

  #captureRenames: Map<string, string> = new Map();

  #context: TransformationContext;
  #factory: ts.NodeFactory;

  constructor(
    context: TransformationContext,
    factory: ts.NodeFactory = context.factory,
  ) {
    this.#context = context;
    this.#factory = factory;
  }

  /**
   * Add a parameter to the destructured input object.
   */
  addParameter(
    name: string,
    bindingName?: ts.BindingName,
    propertyName?: string,
    initializer?: ts.Expression,
  ): this {
    this.#parameters.push({ name, bindingName, propertyName, initializer });
    return this;
  }

  /**
   * Set the capture tree to generate the 'params' object or merged captures.
   */
  setCaptureTree(tree: Map<string, CaptureTreeNode>): this {
    this.#captureTree = tree;
    return this;
  }

  /**
   * Register used binding names to avoid collisions.
   */
  registerUsedNames(names: Set<string> | string[]): this {
    for (const name of names) {
      this.#usedBindingNames.add(name);
    }
    return this;
  }

  /**
   * Set a map of renamed captures.
   * Key: original capture name
   * Value: new property name in the destructured object
   */
  setCaptureRenames(renames: Map<string, string>): this {
    this.#captureRenames = renames;
    return this;
  }

  /**
   * Build the arrow function with destructured parameters.
   *
   * @param originalCallback The original callback function (to preserve modifiers/types)
   * @param body The transformed body of the function
   * @param paramsPropertyName The name of the property containing captures (default: "params").
   *                           If null, captures are merged into the top-level object (for lift-applied).
   */
  buildCallback(
    originalCallback: ts.ArrowFunction | ts.FunctionExpression,
    body: ts.ConciseBody,
    paramsPropertyName: string | null = "params",
    returnType?: ts.TypeNode | null,
  ): ts.ArrowFunction | ts.FunctionExpression {
    const bindingElements: ts.BindingElement[] = [];

    // 1. Add explicitly registered parameters
    for (const param of this.#parameters) {
      const bindingName = param.bindingName ||
        this.#factory.createIdentifier(param.name);
      const propertyName = param.propertyName
        ? this.#factory.createIdentifier(param.propertyName)
        : (param.name !== (bindingName as any)?.text
          ? this.#factory.createIdentifier(param.name)
          : undefined);

      bindingElements.push(
        this.#factory.createBindingElement(
          undefined,
          propertyName,
          bindingName,
          param.initializer,
        ),
      );
      for (const name of extractBindingNames(bindingName)) {
        this.#usedBindingNames.add(name);
      }
    }

    // 2. Add captures
    const createBindingIdentifier = (name: string): ts.Identifier => {
      return reserveIdentifier(name, this.#usedBindingNames, this.#factory);
    };

    // If we have renames, we need to handle them
    const captureBindings: ts.BindingElement[] = [];
    for (const originalName of this.#captureTree.keys()) {
      const renamedName = this.#captureRenames.get(originalName) ??
        originalName;

      const bindingName = createBindingIdentifier(renamedName);
      const propertyName = renamedName !== bindingName.text
        ? this.#factory.createIdentifier(renamedName)
        : undefined;

      captureBindings.push(
        this.#factory.createBindingElement(
          undefined,
          propertyName,
          bindingName,
          undefined,
        ),
      );
    }

    if (paramsPropertyName) {
      // Group captures under a 'params' property (for map/handler)
      // Always add params property to match existing behavior (e.g. params: {})
      const paramsPattern = this.#factory.createObjectBindingPattern(
        captureBindings,
      );
      bindingElements.push(
        this.#factory.createBindingElement(
          undefined,
          this.#factory.createIdentifier(paramsPropertyName),
          paramsPattern,
          undefined,
        ),
      );
    } else {
      // Merge captures into top-level object (for lift-applied)
      for (const binding of captureBindings) bindingElements.push(binding);
    }

    // 3. Create the destructured parameter
    const destructuredParam = createParameterFromBindings(
      bindingElements,
      this.#factory,
    );

    // 4. Create the function
    // If returnType is null, we explicitly want no return type.
    // If returnType is undefined, we preserve the original type.
    // If returnType is a node, we use it.
    const typeNode = returnType === null
      ? undefined
      : (returnType || originalCallback.type);

    // Carry the authored callback's source-map position onto the rebuilt
    // closure so the hoisting stage can recover where it was written (every
    // strategy — computed-origin, array-method, inline-handler — routes its
    // callback through here). Source-map-range ONLY, not full preserveLineage:
    // these callbacks are re-emitted as arrow heads and their types feed schema
    // derivation, so textRange/original would perturb emit. See
    // preserveSourceMapRange / CT-1868.
    const built = ts.isArrowFunction(originalCallback)
      ? this.#factory.createArrowFunction(
        originalCallback.modifiers,
        originalCallback.typeParameters,
        [destructuredParam],
        typeNode,
        originalCallback.equalsGreaterThanToken,
        body,
      )
      : this.#factory.createFunctionExpression(
        originalCallback.modifiers,
        originalCallback.asteriskToken,
        originalCallback.name,
        originalCallback.typeParameters,
        [destructuredParam],
        typeNode,
        body as ts.Block,
      );
    return preserveSourceMapRange(built, originalCallback);
  }

  /**
   * Build a handler callback with the two positional parameters the runtime
   * passes a handler: (event, params). The event parameter keeps the authored
   * callback's first parameter, or is named `eventParamName` when the callback
   * declares none; params destructures the captures, or is named
   * `paramsParamName` when there are none. The runtime passes nothing else,
   * so a further parameter of the authored callback, which TypeScript accepts
   * when it is optional or rest, would be unbound in the rebuilt callback; it
   * is reported as `handler-callback:extra-parameter`.
   */
  buildHandlerCallback(
    originalCallback: ts.ArrowFunction,
    body: ts.ConciseBody,
    eventParamName: string,
    paramsParamName: string,
  ): ts.ArrowFunction {
    const [eventParam, extraParam] = originalCallback.parameters;
    if (extraParam) {
      this.#context.reportDiagnostic({
        type: "handler-callback:extra-parameter",
        message: "An event handler or action() callback receives only the " +
          "event. Remove this parameter and read the value from a variable " +
          "in scope instead.",
        node: extraParam,
      });
    }

    // 1. Create event parameter
    // Ensure event parameter doesn't collide with captures
    const conflicts = new Set(this.#usedBindingNames);
    for (const key of this.#captureTree.keys()) {
      const renamed = this.#captureRenames.get(key) ?? key;
      conflicts.add(renamed);
    }

    let eventBindingName: ts.BindingName;
    if (eventParam) {
      // Use original parameter name if possible
      eventBindingName = normalizeBindingName(
        eventParam.name,
        this.#factory,
        conflicts,
      );

      // Register the chosen name as used
      if (ts.isIdentifier(eventBindingName)) {
        this.#usedBindingNames.add(eventBindingName.text);
      }
    } else {
      // Generate unique name
      eventBindingName = reserveIdentifier(
        eventParamName,
        conflicts,
        this.#factory,
      );
      this.#usedBindingNames.add(eventBindingName.text);
    }

    // 2. Create params parameter (destructured captures)
    const createBindingIdentifier = (name: string): ts.Identifier => {
      return reserveIdentifier(name, this.#usedBindingNames, this.#factory);
    };

    const captureBindings = createBindingElementsFromNames(
      this.#captureTree.keys(),
      this.#factory,
      createBindingIdentifier,
    );

    const paramsBindingName = captureBindings.length > 0
      ? this.#factory.createObjectBindingPattern(captureBindings)
      : reserveIdentifier(
        paramsParamName,
        this.#usedBindingNames,
        this.#factory,
      );

    const createParameter = (name: ts.BindingName) =>
      this.#factory.createParameterDeclaration(
        undefined,
        undefined,
        name,
        undefined,
        undefined,
        undefined,
      );

    return preserveSourceMapRange(
      this.#factory.createArrowFunction(
        originalCallback.modifiers,
        originalCallback.typeParameters,
        [createParameter(eventBindingName), createParameter(paramsBindingName)],
        originalCallback.type,
        originalCallback.equalsGreaterThanToken,
        body,
      ),
      originalCallback,
    );
  }
}
