import type { MqttClient } from 'mqtt';
import type { Automation } from '../types/automation.js';
import type { Trigger, TriggerEvent } from '../types/triggers.js';
import type { HAClient, StateChangedEvent } from './ha-client.js';
import type { AutomationRegistry } from './registry.js';

const DOUBLE_PRESS_WINDOW_MS = 250;

// ---------- Button gesture handler ----------

type GestureState = 'idle' | 'resolving';

class ButtonGestureHandler {
  private gestureState: GestureState = 'idle';
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly entityId: string,
    private readonly dispatch: (event: TriggerEvent) => void,
    private readonly supportsDoublePress: boolean,
  ) {}

  handle(actionState: string, correlationId: string): void {
    const parsed = parseButtonAction(actionState);
    if (!parsed) return;

    const { button, pressType } = parsed;

    if (this.gestureState === 'idle') {
      if (pressType === 'short') {
        if (!this.supportsDoublePress) {
          this.dispatch({ type: 'button', entity_id: this.entityId, gesture: 'single_press', button, correlation_id: correlationId });
        } else {
          this.gestureState = 'resolving';
          this.resolveTimer = setTimeout(() => {
            this.resolveTimer = null;
            this.gestureState = 'idle';
            this.dispatch({ type: 'button', entity_id: this.entityId, gesture: 'single_press', button, correlation_id: correlationId });
          }, DOUBLE_PRESS_WINDOW_MS);
        }
      } else {
        this.dispatch({ type: 'button', entity_id: this.entityId, gesture: 'hold', button, correlation_id: correlationId });
      }
    } else {
      // resolving — waiting for double press
      clearTimeout(this.resolveTimer!);
      this.resolveTimer = null;
      this.gestureState = 'idle';
      if (pressType === 'short') {
        this.dispatch({ type: 'button', entity_id: this.entityId, gesture: 'double_press', button, correlation_id: correlationId });
      } else {
        this.dispatch({ type: 'button', entity_id: this.entityId, gesture: 'hold', button, correlation_id: correlationId });
      }
    }
  }
}

// Classifies a Z2M action state string.
// Numeric button prefix ("1_short_release") is separated out and returned as `button`.
// Recognises common Z2M short/hold conventions; returns null for unrecognised values.
export function parseButtonAction(
  state: string,
): { button?: string; pressType: 'short' | 'hold' } | null {
  const s = state.toLowerCase();
  const prefixed = s.match(/^(\d+)[_-](.+)$/);
  const button = prefixed?.[1];
  const action = prefixed ? prefixed[2] : s;

  if (/long|hold/.test(action)) return { button, pressType: 'hold' };
  if (/short|click|single/.test(action) || action === 'press' || action === 'on' || action === 'toggle') {
    return { button, pressType: 'short' };
  }
  return null;
}

// ---------- Trigger Engine ----------

export class TriggerEngine {
  private readonly buttonHandlers = new Map<string, ButtonGestureHandler>();
  private readonly durationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly registry: AutomationRegistry,
    private readonly haClient: HAClient,
    private readonly onMatch: (automation: Automation<unknown>, event: TriggerEvent) => void,
    private readonly mqttClient?: MqttClient,
  ) {
    this.rebuildButtonHandlers();
    registry.onChange(() => this.rebuildButtonHandlers());
  }

  private rebuildButtonHandlers(): void {
    this.buttonHandlers.clear();
    const entityGestures = new Map<string, Set<string>>();
    for (const automation of this.registry.getAll()) {
      for (const trigger of automation.triggers) {
        if (trigger.type === 'button') {
          if (!entityGestures.has(trigger.entity)) {
            entityGestures.set(trigger.entity, new Set());
          }
          entityGestures.get(trigger.entity)!.add(trigger.gesture);
        }
      }
    }
    for (const [entity, gestures] of entityGestures) {
      this.buttonHandlers.set(
        entity,
        new ButtonGestureHandler(entity, (e) => this.dispatch(e), gestures.has('double_press')),
      );
    }
  }

  start(): void {
    this.haClient.ready
      .then(() => {
        this.haClient.on('state_changed', (event: StateChangedEvent) => {
          const handler = this.buttonHandlers.get(event.entity_id);
          if (handler) {
            handler.handle(event.new_state.state, event.correlation_id);
          } else {
            this.dispatch({
              type: 'state_changed',
              entity_id: event.entity_id,
              old_state: event.old_state,
              new_state: event.new_state,
              correlation_id: event.correlation_id,
            });
          }
        });
      })
      .catch((err) => {
        console.error('[trigger-engine] failed to start:', err);
      });

    if (this.mqttClient) {
      const topics = new Set<string>();
      for (const automation of this.registry.getAll()) {
        for (const trigger of automation.triggers) {
          if (trigger.type === 'mqtt_in') topics.add(trigger.topic);
        }
      }
      for (const topic of topics) {
        this.mqttClient.subscribe(topic);
      }
      this.mqttClient.subscribe('homerun/trigger/+');

      this.mqttClient.on('message', (topic: string, payload: Buffer) => {
        if (topic.startsWith('homerun/trigger/')) {
          const automationId = topic.slice('homerun/trigger/'.length);
          const automation = this.registry.getById(automationId);
          if (!automation) {
            console.warn(`[trigger-engine] manual trigger: no automation with id "${automationId}"`);
            return;
          }
          this.onMatch(automation, { type: 'on_start', correlation_id: crypto.randomUUID() });
          return;
        }
        this.dispatch({
          type: 'mqtt_in',
          topic,
          payload: payload.toString(),
          correlation_id: `mqtt-${Date.now()}`,
        });
      });
    }
  }

  // Entry point for Timer Manager loopback and resolved button gestures.
  dispatch(event: TriggerEvent): void {
    this.matchAndFire(event);
  }

  // ---------- Private ----------

  private matchAndFire(event: TriggerEvent): void {
    for (const automation of this.registry.getAll()) {
      for (const trigger of automation.triggers) {
        if (matchesTrigger(trigger, event)) {
          if (trigger.type === 'state_changed' && trigger.duration && event.type === 'state_changed') {
            const key = `${automation.id}:${event.entity_id}`;
            const existing = this.durationTimers.get(key);
            if (existing !== undefined) clearTimeout(existing);
            const timer = setTimeout(() => {
              this.durationTimers.delete(key);
              if (this.haClient.state(event.entity_id)?.state === event.new_state.state) {
                this.onMatch(automation, event);
              }
            }, trigger.duration);
            this.durationTimers.set(key, timer);
          } else {
            this.onMatch(automation, event);
          }
          break; // don't fire the same automation twice for one event
        }
      }
    }
  }
}

// ---------- Trigger matching ----------

function matchesTrigger(trigger: Trigger, event: TriggerEvent): boolean {
  if (trigger.type !== event.type) return false;

  switch (trigger.type) {
    case 'state_changed': {
      if (event.type !== 'state_changed') return false;
      return typeof trigger.entity === 'string'
        ? trigger.entity === event.entity_id
        : trigger.entity.test(event.entity_id);
    }
    case 'timer_expired': {
      if (event.type !== 'timer_expired') return false;
      return trigger.timerKey === event.timerKey;
    }
    case 'button': {
      if (event.type !== 'button') return false;
      return (
        trigger.entity === event.entity_id &&
        trigger.gesture === event.gesture &&
        (trigger.button === undefined || trigger.button === event.button)
      );
    }
    case 'schedule': {
      if (event.type !== 'schedule') return false;
      return trigger.cron === event.cron;
    }
    case 'on_start':
      return event.type === 'on_start';
    case 'mqtt_in':
      if (event.type !== 'mqtt_in') return false;
      return trigger.topic === event.topic;
    default: {
      const _exhaustive: never = trigger;
      return false;
    }
  }
}
