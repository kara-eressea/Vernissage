/**
 * Shared dynamic-column patch helper.
 *
 * `setGuildConfig` and `updateRaffleFields` both write a caller-supplied subset
 * of a row's columns. The column names are interpolated into the SQL, so both
 * must gate every key through a runtime allowlist — the TypeScript key types are
 * erased at runtime and cannot guard against a stray key. This centralises that
 * one guarded UPDATE so the pattern (and its injection guard) lives in a single
 * place.
 */

import type { Database } from "better-sqlite3";

/** A column patch: present keys are written; a present `null` clears the column. */
export type ColumnPatch = Record<string, string | number | null | undefined>;

/**
 * UPDATE `table`, setting each patch key whose value is defined and whose name
 * is on `allowlist`, for the row identified by `idColumn = idValue`. Keys absent
 * from the patch are left untouched; a present `null` is written as NULL. Only
 * allowlisted column names are ever interpolated into the SQL. A patch with no
 * writable keys is a no-op.
 */
export function applyColumnPatch(
  db: Database,
  table: string,
  idColumn: string,
  idValue: string | number,
  patch: ColumnPatch,
  allowlist: ReadonlySet<string>,
): void {
  const keys = Object.keys(patch).filter(
    (key) => patch[key] !== undefined && allowlist.has(key),
  );
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
  const params: Record<string, string | number | null> = { [idColumn]: idValue };
  for (const key of keys) {
    params[key] = patch[key] ?? null;
  }
  db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${idColumn} = @${idColumn}`).run(
    params,
  );
}
