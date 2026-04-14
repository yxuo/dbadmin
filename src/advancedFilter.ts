export type AdvancedComparisonOperator = '>' | '>=' | '<' | '<=';

export type AdvancedFilterExpression =
  | {
      valueType: 'number';
      kind: 'comparison';
      operator: AdvancedComparisonOperator;
      operand: number;
    }
  | {
      valueType: 'number';
      kind: 'between';
      start: number;
      end: number;
    }
  | {
      valueType: 'date';
      kind: 'comparison';
      operator: AdvancedComparisonOperator;
      operand: string;
    }
  | {
      valueType: 'date';
      kind: 'between';
      start: string;
      end: string;
    };

export function parseAdvancedFilterForDataType(
  dataTypeRaw: string,
  rawFilterValue: string
): AdvancedFilterExpression | undefined {
  const dataType = String(dataTypeRaw || '').toLowerCase();
  if (!dataType) {
    return undefined;
  }

  if (isNumericDataType(dataType)) {
    return parseNumericAdvancedFilter(rawFilterValue);
  }

  if (isDateLikeDataType(dataType)) {
    return parseDateAdvancedFilter(rawFilterValue);
  }

  return undefined;
}

function isNumericDataType(dataType: string): boolean {
  return (
    dataType.includes('int') ||
    dataType.includes('numeric') ||
    dataType.includes('decimal') ||
    dataType.includes('real') ||
    dataType.includes('double') ||
    dataType.includes('float') ||
    dataType.includes('money') ||
    dataType.includes('serial')
  );
}

function isDateLikeDataType(dataType: string): boolean {
  return dataType.includes('date') || dataType.includes('timestamp');
}

function parseNumericAdvancedFilter(rawFilterValue: string): AdvancedFilterExpression | undefined {
  const value = String(rawFilterValue || '').trim();
  const operatorMatch = value.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (operatorMatch) {
    const [, operator, rawOperand] = operatorMatch;
    const operand = Number(rawOperand);
    if (!Number.isFinite(operand)) {
      return undefined;
    }

    return {
      valueType: 'number',
      kind: 'comparison',
      operator: operator as AdvancedComparisonOperator,
      operand,
    };
  }

  const rangeMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
  if (!rangeMatch) {
    return undefined;
  }

  const start = Number(rangeMatch[1]);
  const end = Number(rangeMatch[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }

  return {
    valueType: 'number',
    kind: 'between',
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function parseDateAdvancedFilter(rawFilterValue: string): AdvancedFilterExpression | undefined {
  const value = String(rawFilterValue || '').trim();
  const operatorMatch = value.match(/^(>=|<=|>|<)\s*(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)$/);
  if (operatorMatch) {
    const [, operator, rawOperand] = operatorMatch;
    const operandRange = expandDateToken(rawOperand);
    if (!operandRange) {
      return undefined;
    }

    const useStartBoundary = operator === '>=' || operator === '<';
    return {
      valueType: 'date',
      kind: 'comparison',
      operator: operator as AdvancedComparisonOperator,
      operand: useStartBoundary ? operandRange.start : operandRange.end,
    };
  }

  let rangeMatch = value.match(
    /^(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)\s+-\s+(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)$/
  );

  if (!rangeMatch) {
    rangeMatch = value.match(/^(\d{4})\s*-\s*(\d{4})$/);
  }

  if (!rangeMatch) {
    return undefined;
  }

  const startRange = expandDateToken(rangeMatch[1]);
  const endRange = expandDateToken(rangeMatch[2]);
  if (!startRange || !endRange) {
    return undefined;
  }

  const startDate = startRange.start <= endRange.end ? startRange.start : endRange.start;
  const endDate = startRange.end <= endRange.end ? endRange.end : startRange.end;

  return {
    valueType: 'date',
    kind: 'between',
    start: startDate,
    end: endDate,
  };
}

function expandDateToken(token: string): { start: string; end: string } | undefined {
  const raw = String(token || '').trim();

  const yearMatch = raw.match(/^(\d{4})$/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    return {
      start: formatDateYmd(year, 1, 1),
      end: formatDateYmd(year, 12, 31),
    };
  }

  const yearMonthMatch = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonthMatch) {
    const year = Number(yearMonthMatch[1]);
    const month = Number(yearMonthMatch[2]);
    if (!isValidYearMonthDay(year, month, 1)) {
      return undefined;
    }
    const lastDay = getDaysInMonth(year, month);
    return {
      start: formatDateYmd(year, month, 1),
      end: formatDateYmd(year, month, lastDay),
    };
  }

  const fullDateMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!fullDateMatch) {
    return undefined;
  }

  const year = Number(fullDateMatch[1]);
  const month = Number(fullDateMatch[2]);
  const day = Number(fullDateMatch[3]);
  if (!isValidYearMonthDay(year, month, day)) {
    return undefined;
  }

  const date = formatDateYmd(year, month, day);
  return { start: date, end: date };
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidYearMonthDay(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return false;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return false;
  }
  if (!Number.isInteger(day) || day < 1 || day > getDaysInMonth(year, month)) {
    return false;
  }
  return true;
}

function formatDateYmd(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
