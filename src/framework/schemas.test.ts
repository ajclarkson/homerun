import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  SCHEMA_FILES, assertValidCatalog, assertValidHistory, CATALOG_SCHEMA_ID, HISTORY_SCHEMA_ID,
} from './schemas.js';

const schemasDir = path.resolve(import.meta.dirname, '../../schemas');

// Tests validate against the committed files, the way a consumer would, not against the
// in-memory objects.
function loadSchemaFile(name: keyof typeof SCHEMA_FILES): z.ZodType {
  return z.fromJSONSchema(JSON.parse(readFileSync(path.join(schemasDir, name), 'utf8')));
}

describe('schemas/*.json', () => {
  it.each(Object.keys(SCHEMA_FILES) as Array<keyof typeof SCHEMA_FILES>)(
    '%s matches src/framework/schemas.ts (run npm run generate:schemas)', (name) => {
      const onDisk = readFileSync(path.join(schemasDir, name), 'utf8');
      expect(onDisk).toBe(`${JSON.stringify(SCHEMA_FILES[name], null, 2)}\n`);
    });
});

const goodEntry = {
  ts: '2026-11-02T10:00:00.000Z', location: 'room', automation_id: 'room:lighting', subsystem: 'lighting',
  kind: 'decision', decision: 'no_action', reason: 'lux_high', outcome: 'declined',
  facts: { lux: 85, threshold: 40 }, trigger: { type: 'on_start' },
};

describe('home.history.v1', () => {
  const file = loadSchemaFile('home.history.v1.json');
  const wrap = (entry: unknown) => ({ schema: HISTORY_SCHEMA_ID, entries: [entry] });

  it('accepts a well-formed payload in both the file and the runtime validator', () => {
    expect(file.safeParse(wrap(goodEntry)).success).toBe(true);
    expect(() => assertValidHistory(wrap(goodEntry))).not.toThrow();
  });

  it.each([
    ['a wrong schema id', { schema: 'home.history.v2', entries: [] }],
    ['a missing entries list', { schema: HISTORY_SCHEMA_ID }],
    ['an unknown entry field', wrap({ ...goodEntry, message: 'free text' })],
    ['an unknown kind', wrap({ ...goodEntry, kind: 'note' })],
    ['an ignored outcome', wrap({ ...goodEntry, outcome: 'ignored' })],
    ['a non-ISO timestamp', wrap({ ...goodEntry, ts: 'yesterday' })],
    ['a nested fact', wrap({ ...goodEntry, facts: { lux: { a: 1 } } })],
    ['more than 8 facts', wrap({ ...goodEntry, facts: Object.fromEntries('abcdefghi'.split('').map((k) => [k, 1])) })],
    ['a missing location', wrap({ ...goodEntry, location: undefined })],
    ['more than 200 entries', { schema: HISTORY_SCHEMA_ID, entries: Array.from({ length: 201 }, () => goodEntry) }],
  ])('rejects %s in both validators', (_name, payload) => {
    expect(file.safeParse(payload).success).toBe(false);
    expect(() => assertValidHistory(payload)).toThrow(/home\.history\.v1/);
  });
});

describe('home.catalog.v1', () => {
  const file = loadSchemaFile('home.catalog.v1.json');
  const good = {
    schema: CATALOG_SCHEMA_ID,
    automations: [{
      automation_id: 'room:lighting', location: 'room', subsystem: 'lighting',
      reasons: { lux_high: { outcome: 'declined', facts: ['lux'] }, on: { outcome: 'acted', facts: [] } },
    }],
  };

  it('accepts a well-formed payload', () => {
    expect(file.safeParse(good).success).toBe(true);
    expect(() => assertValidCatalog(good)).not.toThrow();
  });

  it.each([
    ['a wrong schema id', { ...good, schema: 'x' }],
    ['an empty reasons map', { ...good, automations: [{ ...good.automations[0], reasons: {} }] }],
    ['a bad outcome', { ...good, automations: [{ ...good.automations[0], reasons: { r: { outcome: 'maybe', facts: [] } } }] }],
    ['a missing facts list', { ...good, automations: [{ ...good.automations[0], reasons: { r: { outcome: 'acted' } } }] }],
    ['a reason name with free text', { ...good, automations: [{ ...good.automations[0], reasons: { 'a b': { outcome: 'acted', facts: [] } } }] }],
  ])('rejects %s in both validators', (_name, payload) => {
    expect(file.safeParse(payload).success).toBe(false);
    expect(() => assertValidCatalog(payload)).toThrow(/home\.catalog\.v1/);
  });
});
