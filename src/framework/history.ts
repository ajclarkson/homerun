import type { Action } from '../types/actions.js';
import type { TriggerSummary } from '../types/triggers.js';
import type { FactValue } from '../types/reasons.js';
import type { ObsEvent } from './event-publisher.js';
import { HISTORY_KINDS, HISTORY_SCHEMA_ID, MAX_HISTORY_ENTRIES, assertValidHistory } from './schemas.js';

// A bounded, newest-first record of the events a person would ask "what happened here?"
// about. Entries are structured only (reason keys, outcomes, facts): wording is the
// consumer's job.

export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryEntry {
  ts: string;
  location: string;
  automation_id: string;
  subsystem: string;
  kind: HistoryKind;
  decision?: string;
  reason?: string;
  outcome?: 'acted' | 'declined';
  facts?: Record<string, FactValue>;
  trigger?: TriggerSummary;
  detail?: Record<string, FactValue>;
}

export interface HistoryConfig {
  size: number;
  houseSize: number;
}

export interface HistoryPayload {
  schema: typeof HISTORY_SCHEMA_ID;
  entries: HistoryEntry[];
}

function actionLabel(action: Action): string {
  return action.type === 'ha.call_service' ? `${action.domain}.${action.service}` : action.type;
}

function actionEntity(action: Action): string | undefined {
  return action.type === 'ha.call_service' ? action.target?.entity_id : undefined;
}

function failureEntry(event: ObsEvent, failure: 'error' | 'ack_timeout', action: Action, entity?: string): HistoryEntry {
  const target = entity ?? actionEntity(action);
  return {
    ts: event.timestamp,
    location: event.location,
    automation_id: event.automation_id,
    subsystem: event.subsystem,
    kind: 'action_failed',
    detail: { failure, action: actionLabel(action), ...(target !== undefined && { entity: target }) },
  };
}

// Which events are worth remembering. The rule for decisions is deliberate: a declaring
// automation says so itself via `outcome` (`ignored` is noise), and an automation that
// declares nothing is remembered only when it acted, so adopting this changes nothing for
// code that has not opted in.
export function classify(event: ObsEvent): HistoryEntry | undefined {
  const common = {
    ts: event.timestamp,
    location: event.location,
    automation_id: event.automation_id,
    subsystem: event.subsystem,
  };
  switch (event.event_type) {
    case 'decision': {
      const remembered = event.outcome !== undefined ? event.outcome !== 'ignored' : event.hasAction;
      if (!remembered) return undefined;
      return {
        ...common,
        kind: 'decision',
        decision: event.decision,
        ...(event.reason !== undefined && { reason: event.reason }),
        ...(event.outcome !== undefined && event.outcome !== 'ignored' && { outcome: event.outcome }),
        ...(event.facts !== undefined && { facts: event.facts }),
        trigger: event.trigger,
      };
    }
    case 'abort':
      // `disabled` is a switch the person flipped, not something that went wrong.
      if (event.abort_kind === 'disabled') return undefined;
      return {
        ...common,
        kind: 'abort',
        ...(event.reason !== undefined && { reason: event.reason }),
        trigger: event.trigger,
        detail: { abort_kind: event.abort_kind, ...(event.entity !== undefined && { entity: event.entity }) },
      };
    case 'action_result':
      return event.status === 'error' ? failureEntry(event, 'error', event.action) : undefined;
    case 'action_ack_timeout':
      return failureEntry(event, 'ack_timeout', event.action, event.entity);
    // Reported separately; a mistake in an automation is not something that happened in a room.
    case 'declaration_error':
    case 'action_started':
      return undefined;
  }
}

export class HistoryBuffer {
  private items: HistoryEntry[] = [];

  constructor(private readonly size: number) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_HISTORY_ENTRIES) {
      throw new Error(`history size must be an integer from 1 to ${MAX_HISTORY_ENTRIES} (got ${size})`);
    }
  }

  push(entry: HistoryEntry): void {
    this.items.unshift(entry);
    if (this.items.length > this.size) this.items.length = this.size;
  }

  // Replaces contents from a seed that is already newest first; trims to this buffer's size
  // so shrinking `history.size` in config takes effect on the next start.
  load(entries: readonly HistoryEntry[]): void {
    this.items = entries.slice(0, this.size);
  }

  payload(): HistoryPayload {
    return { schema: HISTORY_SCHEMA_ID, entries: [...this.items] };
  }
}

// Returns the validated seed, or undefined when the payload is malformed. Never throws: a bad
// retained message must cost the history, not the startup.
export function parseSeed(topic: string, raw: string, location?: string): HistoryPayload | undefined {
  try {
    const payload: unknown = JSON.parse(raw);
    assertValidHistory(payload);
    const parsed = payload as HistoryPayload;
    if (location !== undefined && parsed.entries.some((e) => e.location !== location)) {
      throw new Error(`entries do not all belong to location "${location}"`);
    }
    return parsed;
  } catch (err) {
    console.warn(`[history] ignoring malformed retained history on ${topic}, starting empty:`, (err as Error).message);
    return undefined;
  }
}
