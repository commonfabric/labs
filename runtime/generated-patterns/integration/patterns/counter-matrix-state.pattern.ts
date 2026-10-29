import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

type Matrix = number[][];

interface CounterMatrixStateArgs {
  matrix: Default<Matrix, [[0, 0], [0, 0]]>;
}

interface Dimensions {
  rows: number;
  columns: number;
}

interface SetCellEvent {
  row?: number;
  column?: number;
  value?: number;
}

interface SetRowEvent {
  row?: number;
  values?: number[];
}

interface SetColumnEvent {
  column?: number;
  values?: number[];
  value?: number;
}

const fallbackMatrix: Matrix = [
  [0, 0],
  [0, 0],
];

const cloneFallback = (): Matrix => fallbackMatrix.map((row) => [...row]);

const sanitizeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const sanitizeMatrix = (raw: Matrix | undefined): Matrix => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return cloneFallback();
  }

  let width = 0;
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length > width) {
      width = entry.length;
    }
  }

  if (width === 0) {
    width = fallbackMatrix[0].length;
  }

  return raw.map((entry) => {
    if (!Array.isArray(entry)) {
      return Array.from({ length: width }, () => 0);
    }

    const sanitized = entry.map(sanitizeNumber);
    if (sanitized.length < width) {
      return [
        ...sanitized,
        ...Array.from({ length: width - sanitized.length }, () => 0),
      ];
    }
    if (sanitized.length > width) {
      return sanitized.slice(0, width);
    }
    return sanitized;
  });
};

const computeRowTotals = (raw: Matrix | undefined): number[] => {
  return sanitizeMatrix(raw).map((row) =>
    row.reduce((sum, value) => sum + value, 0)
  );
};

const computeColumnTotals = (raw: Matrix | undefined): number[] => {
  const matrix = sanitizeMatrix(raw);
  if (matrix.length === 0) {
    return [];
  }
  const width = matrix[0].length;
  return Array.from({ length: width }, (_, column) => {
    return matrix.reduce((sum, row) => sum + row[column], 0);
  });
};

const computeDimensions = (raw: Matrix | undefined): Dimensions => {
  const matrix = sanitizeMatrix(raw);
  const columns = matrix.length > 0 ? matrix[0].length : 0;
  return { rows: matrix.length, columns };
};

const setCellValue = handler(
  (
    event: SetCellEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (
      typeof event?.row !== "number" ||
      typeof event?.column !== "number" ||
      typeof event?.value !== "number" ||
      !Number.isFinite(event.value)
    ) {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const { row, column, value } = event;
    if (row < 0 || row >= matrixValue.length) {
      return;
    }

    const rowValue = matrixValue[row];
    if (!Array.isArray(rowValue) || column < 0 || column >= rowValue.length) {
      return;
    }

    const rowCell: Cell<number[]> = context.matrix.key(row);
    const cell: Cell<number> = rowCell.key(column);
    cell.set(value);
  },
);

const setRowValues = handler(
  (
    event: SetRowEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (typeof event?.row !== "number") {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const rowIndex = event.row;
    if (rowIndex < 0 || rowIndex >= matrixValue.length) {
      return;
    }

    const existingRow = matrixValue[rowIndex];
    const rowCell: Cell<number[]> = context.matrix.key(rowIndex);
    const targetLength = Array.isArray(existingRow) ? existingRow.length : 0;
    if (targetLength === 0) {
      return;
    }

    const provided = Array.isArray(event.values) ? event.values : [];
    const nextRow = Array.from({ length: targetLength }, (_, column) => {
      const candidate = provided[column];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      const fallback = Array.isArray(existingRow)
        ? existingRow[column]
        : undefined;
      return sanitizeNumber(fallback);
    });

    rowCell.set(nextRow);
  },
);

const setColumnValues = handler(
  (
    event: SetColumnEvent | undefined,
    context: { matrix: Cell<Matrix> },
  ) => {
    if (typeof event?.column !== "number") {
      return;
    }

    const matrixValue = context.matrix.get();
    if (!Array.isArray(matrixValue)) {
      return;
    }

    const columnIndex = event.column;
    if (columnIndex < 0) {
      return;
    }

    const valuesArray = Array.isArray(event.values) ? event.values : undefined;
    const defaultValue = typeof event.value === "number" &&
        Number.isFinite(event.value)
      ? event.value
      : undefined;

    matrixValue.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || columnIndex >= row.length) {
        return;
      }

      const rowCell: Cell<number[]> = context.matrix.key(rowIndex);
      const cell: Cell<number> = rowCell.key(columnIndex);
      const candidate = valuesArray && valuesArray[rowIndex];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        cell.set(candidate);
        return;
      }
      if (defaultValue !== undefined) {
        cell.set(defaultValue);
      }
    });
  },
);

const liftTotal = lift((rows: number[]) =>
  rows.reduce((sum, value) => sum + value, 0)
);

const liftRowSummary = lift((rows: number[]) =>
  rows.map((value, index) => `r${index}=${value}`).join(" | ")
);

const liftColumnSummary = lift((columns: number[]) =>
  columns.map((value, index) => `c${index}=${value}`).join(" | ")
);

export const counterWithMatrixState = pattern<CounterMatrixStateArgs>(
  ({ matrix }) => {
    const matrixView = sanitizeMatrix(matrix);
    const rowTotals = computeRowTotals(matrix);
    const columnTotals = computeColumnTotals(matrix);
    const dimensions = computeDimensions(matrix);
    const total = liftTotal(rowTotals);
    const rowSummary = liftRowSummary(rowTotals);
    const columnSummary = liftColumnSummary(columnTotals);
    const label =
      str`Rows ${rowSummary} | Cols ${columnSummary} | Total ${total}`;

    return {
      matrix,
      matrixView,
      rowTotals,
      columnTotals,
      dimensions,
      total,
      rowSummary,
      columnSummary,
      label,
      setCell: setCellValue({ matrix }),
      setRow: setRowValues({ matrix }),
      setColumn: setColumnValues({ matrix }),
    };
  },
);

export default counterWithMatrixState;
