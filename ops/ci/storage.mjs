import assert from 'node:assert/strict';
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @typedef {{type:string, model?:string, [key:string]:unknown}} LedgerRow */
/** @param {string} path @param {unknown} value */
export function createPrivate(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(
      fd,
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** @param {string} path @param {unknown} value */
export function replacePrivate(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  createPrivate(temp, value);
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}
/** @param {string} root @param {LedgerRow} value */
export function append(root, value) {
  const fd = openSync(join(root, 'attempts.jsonl'), 'a', 0o600);
  try {
    writeSync(
      fd,
      JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n',
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** @param {string} root @returns {LedgerRow[]} */
export function ledger(root) {
  return readFileSync(join(root, 'attempts.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      assert(row && typeof row.type === 'string');
      return row;
    });
}
/** @param {string} root @param {string} model */
export const resultPath = (root, model) => join(root, `${model}.json`);
