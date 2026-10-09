/**
 * Pure planning for the customer fields restore — no I/O in this module.
 *
 * Given a customer as GET returns it and that customer's row from a Customers
 * export, decides which API fields to write. The rule is fill-the-blank: a
 * field is written only when production holds nothing and the export holds
 * something. A production value that differs from the export is kept and
 * reported, never overwritten, because it may have been typed since the
 * export was taken.
 */
import {
  CUSTOMER_EXPORT_CODE_COLUMN,
  CUSTOMER_RESTORE_COLUMNS,
  CUSTOMER_RESTORE_KIND,
  PERCENT_DIVISOR,
  SALESPERSON_EXPORT_SEPARATOR,
  TAX_RATE_BY_CODE,
  TAX_RATE_FIELD,
} from '../constants/index.js';

/** A minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body
    .filter((cells) => cells.some((value) => value.trim() !== ''))
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

/** Export rows keyed by customer code. */
export function indexExport(rows) {
  const byCode = new Map();
  for (const row of rows) {
    const code = String(row[CUSTOMER_EXPORT_CODE_COLUMN] ?? '').trim();
    if (code) byCode.set(code.toLowerCase(), row);
  }
  return byCode;
}

/**
 * Lookups the API needs that the export does not carry: a salesperson is
 * written by Guid and a warehouse by code, both taken from how they appear on
 * other production customers.
 */
export function buildLookups(customers) {
  const salesPeopleByEmail = new Map();
  const warehousesByCode = new Map();
  for (const customer of customers) {
    const person = customer?.SalesPerson;
    if (person?.Guid && person?.Email) salesPeopleByEmail.set(String(person.Email).toLowerCase(), person);
    const warehouse = customer?.DefaultWarehouse;
    if (warehouse?.Guid && warehouse?.WarehouseCode) {
      warehousesByCode.set(String(warehouse.WarehouseCode).toLowerCase(), warehouse);
    }
  }
  return { salesPeopleByEmail, warehousesByCode };
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'object') return !value.Guid;
  return false;
}

function same(kind, current, desired) {
  if (kind === CUSTOMER_RESTORE_KIND.SALESPERSON || kind === CUSTOMER_RESTORE_KIND.WAREHOUSE) {
    return String(current?.Guid ?? '').toLowerCase() === String(desired?.Guid ?? '').toLowerCase();
  }
  if (typeof desired === 'number') return Number(current) === desired;
  if (typeof desired === 'boolean') return Boolean(current) === desired;
  return String(current ?? '').trim() === String(desired ?? '').trim();
}

/**
 * The API value for one export cell, or `{ error }` when the cell cannot be
 * turned into one (an unknown salesperson or warehouse).
 */
export function exportValue(kind, text, lookups) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { value: null };
  switch (kind) {
    case CUSTOMER_RESTORE_KIND.TEXT:
    case CUSTOMER_RESTORE_KIND.TAX_CODE:
      return { value: raw };
    case CUSTOMER_RESTORE_KIND.BOOL:
      return { value: raw.toLowerCase() === 'true' };
    case CUSTOMER_RESTORE_KIND.NUMBER:
      return Number.isFinite(Number(raw)) ? { value: Number(raw) } : { error: `'${raw}' is not a number` };
    case CUSTOMER_RESTORE_KIND.PERCENT:
      return Number.isFinite(Number(raw))
        ? { value: Number(raw) / PERCENT_DIVISOR }
        : { error: `'${raw}' is not a percentage` };
    case CUSTOMER_RESTORE_KIND.SALESPERSON: {
      const at = raw.lastIndexOf(SALESPERSON_EXPORT_SEPARATOR);
      const email = (at >= 0 ? raw.slice(at + SALESPERSON_EXPORT_SEPARATOR.length) : raw).trim().toLowerCase();
      const person = lookups.salesPeopleByEmail.get(email);
      return person
        ? { value: { Guid: person.Guid, Email: person.Email, FullName: person.FullName } }
        : { error: `no salesperson with email '${email}' on any production customer` };
    }
    case CUSTOMER_RESTORE_KIND.WAREHOUSE: {
      const warehouse = lookups.warehousesByCode.get(raw.toLowerCase());
      return warehouse
        ? { value: { Guid: warehouse.Guid, WarehouseCode: warehouse.WarehouseCode } }
        : { error: `no warehouse with code '${raw}' on any production customer` };
    }
    default:
      return { error: `unknown kind ${kind}` };
  }
}

/**
 * What to write for one customer.
 *
 * @returns {{ changes: Record<string, unknown>, kept: Array<{ field: string, current: unknown, exported: unknown }>, problems: string[] }}
 */
export function planRestore(customer, row, lookups) {
  const changes = {};
  const kept = [];
  const problems = [];

  for (const [field, column, kind] of CUSTOMER_RESTORE_COLUMNS) {
    const { value: desired, error } = exportValue(kind, row?.[column], lookups);
    if (error) {
      problems.push(`${field}: ${error}`);
      continue;
    }
    if (desired === null || isBlank(desired)) continue;

    const current = customer?.[field];
    if (same(kind, current, desired)) continue;
    if (!isBlank(current)) {
      kept.push({ field, current, exported: desired });
      continue;
    }
    changes[field] = desired;
    if (kind === CUSTOMER_RESTORE_KIND.TAX_CODE) {
      const rate = TAX_RATE_BY_CODE[desired];
      if (rate === undefined) problems.push(`${field}: no tax rate known for code '${desired}'`);
      else if (isBlank(customer?.[TAX_RATE_FIELD])) changes[TAX_RATE_FIELD] = rate;
    }
  }

  return { changes, kept, problems };
}

/** True when, after a write, every planned field reads back as planned. */
export function changesLanded(changes, after) {
  return Object.entries(changes).every(([field, desired]) => {
    const kind = CUSTOMER_RESTORE_COLUMNS.find(([name]) => name === field)?.[2];
    return same(kind, after?.[field], desired);
  });
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return value.WarehouseCode ?? value.FullName ?? JSON.stringify(value);
  return String(value);
}

/** One CSV row per field that was, or would be, written — plus kept values and problems. */
export function buildRestoreCsv(report) {
  const lines = ['customer_code,field,before,after,outcome,note'];
  const push = (cells) => lines.push(cells.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','));
  for (const result of report.results) {
    for (const [field, value] of Object.entries(result.changes ?? {})) {
      push([result.customerCode, field, cellText(result.before?.[field]), cellText(value), result.outcome, result.error ?? '']);
    }
    for (const item of result.kept ?? []) {
      push([result.customerCode, item.field, cellText(item.current), cellText(item.exported), 'kept', 'production already holds a different value']);
    }
    for (const problem of result.problems ?? []) {
      push([result.customerCode, problem.split(':')[0], '', '', 'problem', problem]);
    }
    if (!Object.keys(result.changes ?? {}).length && !(result.kept ?? []).length && !(result.problems ?? []).length) {
      push([result.customerCode, '', '', '', result.outcome, result.error ?? '']);
    }
  }
  return lines.join('\n');
}
