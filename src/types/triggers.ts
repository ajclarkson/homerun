import type { EntityState } from '../framework/ha-client.js';

// ---------- Trigger declarations ----------
// Declared on an Automation to describe what events activate it.

export type Trigger =
  | { type: 'state_changed'; entity: string | RegExp; duration?: number }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity: string; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string };

// ---------- Trigger events ----------
// Runtime events produced by the Trigger Engine and consumed by the Pipeline Runner.
// Distinct from Trigger declarations — these carry the live values at the moment of firing.
//
// correlation_id is minted at each event source (HAClient, Scheduler, TimerManager) — not here.
// parent_correlation_id is set when one pipeline run causally produces another (e.g. via HA feedback loops).

type TriggerEventBase = {
  correlation_id: string;
  parent_correlation_id?: string;
};

export type TriggerEvent = TriggerEventBase & (
  | { type: 'state_changed'; entity_id: string; old_state: EntityState | undefined; new_state: EntityState }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity_id: string; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string; payload: string }
);
