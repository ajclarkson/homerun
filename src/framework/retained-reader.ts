import type { MqttClient } from 'mqtt';

// MQTT has no "read this topic once" call. The broker delivers retained messages right after
// the SUBACK, with no end-of-batch marker, so the only honest way to know the batch is done is
// to wait for a quiet period. `settleMs` is that period: too short and a seed is missed (the
// history then starts empty and overwrites the retained copy), so keep it generous; it is only
// paid once, at startup.
export async function readRetained(
  mqtt: MqttClient,
  filters: string[],
  accept: (topic: string) => boolean,
  settleMs: number,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // Only retained packets count: a live message on a matching topic is not a stored seed.
  const onMessage = (topic: string, payload: Buffer, packet: { retain?: boolean }): void => {
    if (packet.retain && accept(topic)) found.set(topic, payload.toString('utf8'));
  };
  mqtt.on('message', onMessage);
  try {
    await mqtt.subscribeAsync(filters);
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  } finally {
    mqtt.off('message', onMessage);
    await mqtt.unsubscribeAsync(filters).catch((err: unknown) => {
      console.warn('[retained-reader] unsubscribe failed:', err);
    });
  }
  return found;
}
