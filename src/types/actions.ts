export type Action =
  | { type: 'ha.call_service'; domain: string; service: string; target?: { entity_id: string }; data?: Record<string, unknown> }
  | {
      type: 'mqtt.publish';
      topic: string;
      payload: string;
      retain?: boolean;
      // Set this when `topic` is the `state_topic` of a manually-configured HA MQTT entity
      // (sensor/binary_sensor domains have no service call to set their state, so publishing
      // to their state_topic is the only way to drive them). Enables write-side correlation
      // tagging (#28) for the resulting state_changed the same way ha.call_service gets it for
      // free via `target.entity_id` — without this, the causal link to whatever automation
      // reacts to that entity's change is invisible in observability events. Homerun cannot
      // detect a missing one; there's no way to infer which topics feed HA entities when HA's
      // MQTT config is manual, so this is opt-in and unenforced.
      impliesEntity?: string;
    }
  | { type: 'timer.start'; timerKey: string; delayMs: number }
  | { type: 'timer.cancel'; timerKey: string };
