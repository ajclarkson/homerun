export type Action =
  | { type: 'ha.call_service'; domain: string; service: string; target?: { entity_id: string }; data?: Record<string, unknown> }
  | { type: 'mqtt.publish'; topic: string; payload: string; retain?: boolean }
  | { type: 'timer.start'; timerKey: string; delayMs: number }
  | { type: 'timer.cancel'; timerKey: string };
