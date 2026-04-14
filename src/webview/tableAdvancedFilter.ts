(function () {
  function isNumericColumn(column: { dataType?: string } | undefined): boolean {
    const dataType = String(column?.dataType || '').toLowerCase();
    if (!dataType) {
      return false;
    }

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

  function isDateColumn(column: { dataType?: string } | undefined): boolean {
    const dataType = String(column?.dataType || '').toLowerCase();
    if (!dataType) {
      return false;
    }

    return dataType.includes('date') || dataType.includes('timestamp');
  }

  function parseNumericAdvancedFilter(rawValue: string):
    | { kind: 'comparison'; operator: '>' | '>=' | '<' | '<='; operand: number }
    | { kind: 'between'; start: number; end: number }
    | null {
    const value = String(rawValue || '').trim();
    const operatorMatch = value.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
    if (operatorMatch) {
      const operand = Number(operatorMatch[2]);
      if (!Number.isFinite(operand)) {
        return null;
      }
      return { kind: 'comparison', operator: operatorMatch[1] as '>' | '>=' | '<' | '<=', operand };
    }

    const rangeMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
    if (!rangeMatch) {
      return null;
    }

    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }

    return {
      kind: 'between',
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
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
    return y + '-' + m + '-' + d;
  }

  function expandDateToken(token: string): { start: string; end: string } | null {
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
        return null;
      }
      const lastDay = getDaysInMonth(year, month);
      return {
        start: formatDateYmd(year, month, 1),
        end: formatDateYmd(year, month, lastDay),
      };
    }

    const fullDateMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!fullDateMatch) {
      return null;
    }

    const year = Number(fullDateMatch[1]);
    const month = Number(fullDateMatch[2]);
    const day = Number(fullDateMatch[3]);
    if (!isValidYearMonthDay(year, month, day)) {
      return null;
    }

    const date = formatDateYmd(year, month, day);
    return { start: date, end: date };
  }

  function parseDateAdvancedFilter(rawValue: string):
    | { kind: 'comparison'; operator: '>' | '>=' | '<' | '<='; operand: string }
    | { kind: 'between'; start: string; end: string }
    | null {
    const value = String(rawValue || '').trim();
    const operatorMatch = value.match(/^(>=|<=|>|<)\s*(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)$/);
    if (operatorMatch) {
      const range = expandDateToken(operatorMatch[2]);
      if (!range) {
        return null;
      }

      const useStartBoundary = operatorMatch[1] === '>=' || operatorMatch[1] === '<';
      return {
        kind: 'comparison',
        operator: operatorMatch[1] as '>' | '>=' | '<' | '<=',
        operand: useStartBoundary ? range.start : range.end,
      };
    }

    let rangeMatch = value.match(
      /^(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)\s+-\s+(\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?)$/
    );
    if (!rangeMatch) {
      rangeMatch = value.match(/^(\d{4})\s*-\s*(\d{4})$/);
    }
    if (!rangeMatch) {
      return null;
    }

    const left = expandDateToken(rangeMatch[1]);
    const right = expandDateToken(rangeMatch[2]);
    if (!left || !right) {
      return null;
    }

    const start = left.start <= right.end ? left.start : right.start;
    const end = left.end <= right.end ? right.end : left.end;
    return { kind: 'between', start, end };
  }

  function toDateOnlyEpochMs(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      const datePrefixMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
      if (datePrefixMatch) {
        const parsedPrefix = Date.parse(datePrefixMatch[1] + 'T00:00:00.000Z');
        return Number.isNaN(parsedPrefix) ? null : parsedPrefix;
      }
    }

    const asDate = new Date(value as string | number | Date);
    if (Number.isNaN(asDate.getTime())) {
      return null;
    }

    const year = asDate.getUTCFullYear();
    const month = asDate.getUTCMonth() + 1;
    const day = asDate.getUTCDate();
    return Date.parse(formatDateYmd(year, month, day) + 'T00:00:00.000Z');
  }

  function buildAdvancedFilterMatcher(column: { dataType?: string } | undefined, rawValue: string): ((cellValue: unknown) => boolean) | null {
    if (isNumericColumn(column)) {
      const parsedNumeric = parseNumericAdvancedFilter(rawValue);
      if (parsedNumeric) {
        return (cellValue: unknown) => {
          const numericValue = Number(String(cellValue ?? '').trim());
          if (!Number.isFinite(numericValue)) {
            return false;
          }

          if (parsedNumeric.kind === 'comparison') {
            if (parsedNumeric.operator === '>') {
              return numericValue > parsedNumeric.operand;
            }
            if (parsedNumeric.operator === '>=') {
              return numericValue >= parsedNumeric.operand;
            }
            if (parsedNumeric.operator === '<') {
              return numericValue < parsedNumeric.operand;
            }
            return numericValue <= parsedNumeric.operand;
          }

          return numericValue >= parsedNumeric.start && numericValue <= parsedNumeric.end;
        };
      }
    }

    if (isDateColumn(column)) {
      const parsedDate = parseDateAdvancedFilter(rawValue);
      if (parsedDate) {
        return (cellValue: unknown) => {
          const cellDateEpoch = toDateOnlyEpochMs(cellValue);
          if (cellDateEpoch === null) {
            return false;
          }

          if (parsedDate.kind === 'comparison') {
            const operandEpoch = Date.parse(parsedDate.operand + 'T00:00:00.000Z');
            if (Number.isNaN(operandEpoch)) {
              return false;
            }

            if (parsedDate.operator === '>') {
              return cellDateEpoch > operandEpoch;
            }
            if (parsedDate.operator === '>=') {
              return cellDateEpoch >= operandEpoch;
            }
            if (parsedDate.operator === '<') {
              return cellDateEpoch < operandEpoch;
            }
            return cellDateEpoch <= operandEpoch;
          }

          const startEpoch = Date.parse(parsedDate.start + 'T00:00:00.000Z');
          const endEpoch = Date.parse(parsedDate.end + 'T00:00:00.000Z');
          if (Number.isNaN(startEpoch) || Number.isNaN(endEpoch)) {
            return false;
          }

          return cellDateEpoch >= startEpoch && cellDateEpoch <= endEpoch;
        };
      }
    }

    return null;
  }

  const api = {
    isNumericColumn,
    isDateColumn,
    buildAdvancedFilterMatcher,
  };

  (globalThis as { DBAdminAdvancedFilter?: typeof api }).DBAdminAdvancedFilter = api;
})();
