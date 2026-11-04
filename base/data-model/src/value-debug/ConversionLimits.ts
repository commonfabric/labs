/**
 * The limits a conversion runs within, each resolved from the option of the
 * same name: the limit stated, or its default when none was, capped at its
 * absolute maximum.
 */
export type ConversionLimits = {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxBufferLength: number;
  readonly maxProperties: number;
  readonly maxStringLength: number;
  readonly maxStringLines: number;
};
