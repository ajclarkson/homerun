import type { EntityState } from '../framework/ha-client.js';

// ---------- Trigger declarations ----------
// Declared on an Automation to describe what events activate it.

// Mirrors the conditional in HAState: accepts only known entity IDs when HAEntities
// is populated by codegen, falls back to string when it is empty.
type _HAEntityKey = keyof HAEntities extends never ? string : keyof HAEntities;

export type Trigger =
  | { type: 'state_changed'; entity: _HAEntityKey | RegExp; to?: string | string[]; duration?: number }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity: _HAEntityKey | RegExp; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string };

// ---------- Trigger events ----------
// Runtime events produced by the Trigger Engine and consumed by the Pipeline Runner.
// Distinct from Trigger declarations — these carry the live values at the moment of firing.
//
// correlation_id is minted at each event source (HAClient, Scheduler, TimerManager) — not here.
// parent_correlation_id is set when one pipeline run causally produces another (e.g. via HA feedback loops).
// root_correlation_id is constant across an entire causal tree (equal to correlation_id at the root) so
// "everything caused by X" is a single equality filter regardless of chain depth. Optional here so existing
// hand-built events don't need updating — consumers should fall back to correlation_id when absent.
// parent_automation_id names the automation whose write produced this event, alongside parent_correlation_id's run.

type TriggerEventBase = {
  correlation_id: string;
  parent_correlation_id?: string;
  root_correlation_id?: string;
  parent_automation_id?: string;
};

export type TriggerEvent = TriggerEventBase & (
  | { type: 'state_changed'; entity_id: string; old_state: EntityState | undefined; new_state: EntityState }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity_id: string; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string; payload: string }
);
