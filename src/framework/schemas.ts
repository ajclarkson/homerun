import { z } from 'zod';
import { MAX_FACTS } from '../types/reasons.js';

// The JSON Schemas are the contract. They are authored here, written to `schemas/*.json` by
// `npm run generate:schemas` (a test fails when the files drift), and the very same objects
// validate payloads at run time. One source means the published file cannot disagree with
// what the publisher actually checks.

export const CATALOG_SCHEMA_ID = 'home.catalog.v1';
export const HISTORY_SCHEMA_ID = 'home.history.v1';

// Retained payloads are re-sent on every stored entry, so the size is bounded in the schema,
// not just in config.
export const MAX_HISTORY_ENTRIES = 200;

const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const factValue = { type: ['string', 'number', 'boolean', 'null'] } as const;

const flatRecord = {
  type: 'object',
  propertyNames: { pattern: IDENTIFIER_PATTERN },
  additionalProperties: factValue,
  maxProperties: MAX_FACTS,
} as const;

const catalogReason = {
  type: 'object',
  required: ['outcome', 'facts'],
  additionalProperties: false,
  properties: {
    outcome: { enum: ['acted', 'declined', 'ignored'] },
    facts: {
      type: 'array',
      items: { type: 'string', pattern: IDENTIFIER_PATTERN },
      maxItems: MAX_FACTS,
      uniqueItems: true,
    },
  },
} as const;

export const catalogJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: CATALOG_SCHEMA_ID,
  description: 'Reasons each automation declares, with their outcome and fact keys. Published retained on <ns>/catalog.',
  type: 'object',
  required: ['schema', 'automations'],
  additionalProperties: false,
  properties: {
    schema: { const: CATALOG_SCHEMA_ID },
    automations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['automation_id', 'location', 'subsystem', 'reasons'],
        additionalProperties: false,
        properties: {
          automation_id: nonEmptyString,
          location: nonEmptyString,
          subsystem: nonEmptyString,
          reasons: {
            type: 'object',
            minProperties: 1,
            propertyNames: { pattern: IDENTIFIER_PATTERN },
            additionalProperties: catalogReason,
          },
        },
      },
    },
  },
} as const;

const triggerSummary = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { enum: ['state_changed', 'schedule', 'on_start', 'timer_expired', 'button', 'mqtt_in'] },
    entity_id: { type: 'string' },
    to: { type: 'string' },
    from: { type: 'string' },
    cron: { type: 'string' },
    timerKey: { type: 'string' },
    gesture: { enum: ['single_press', 'double_press', 'hold'] },
    button: { type: 'string' },
    topic: { type: 'string' },
  },
} as const;

const historyEntry = {
  type: 'object',
  required: ['ts', 'location', 'automation_id', 'subsystem', 'kind'],
  additionalProperties: false,
  properties: {
    ts: { type: 'string', format: 'date-time' },
    location: nonEmptyString,
    automation_id: nonEmptyString,
    subsystem: nonEmptyString,
    kind: { enum: ['decision', 'abort', 'action_failed'] },
    decision: { type: 'string' },
    reason: { type: 'string' },
    // `ignored` decisions are never stored, so a consumer never has to render one.
    outcome: { enum: ['acted', 'declined'] },
    facts: flatRecord,
    trigger: triggerSummary,
    // Structured, never prose: abort_kind and entity for an abort; failure, action and entity
    // for a failed action.
    detail: flatRecord,
  },
} as const;

export const historyJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: HISTORY_SCHEMA_ID,
  description: 'Newest-first meaningful events for one location or the whole house. Published retained on <ns>/{location}/history and <ns>/history.',
  type: 'object',
  required: ['schema', 'entries'],
  additionalProperties: false,
  properties: {
    schema: { const: HISTORY_SCHEMA_ID },
    entries: { type: 'array', maxItems: MAX_HISTORY_ENTRIES, items: historyEntry },
  },
} as const;

export const SCHEMA_FILES = {
  'home.catalog.v1.json': catalogJsonSchema,
  'home.history.v1.json': historyJsonSchema,
} as const;

const catalogValidator = z.fromJSONSchema(catalogJsonSchema as never);
const historyValidator = z.fromJSONSchema(historyJsonSchema as never);

function check(validator: z.ZodType, payload: unknown, name: string): void {
  const result = validator.safeParse(payload);
  if (result.success) return;
  const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new Error(`payload violates ${name}: ${detail}`);
}

// Both throw: callers publish a payload only after these pass, so a bug in the builders
// surfaces as a logged error instead of a retained payload consumers must second-guess.
export function assertValidCatalog(payload: unknown): void {
  check(catalogValidator, payload, CATALOG_SCHEMA_ID);
}

export function assertValidHistory(payload: unknown): void {
  check(historyValidator, payload, HISTORY_SCHEMA_ID);
}
