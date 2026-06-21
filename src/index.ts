import 'dotenv/config';
import { HAClient } from './framework/ha-client.js';

process.on('uncaughtException', (err) => {
  console.error('[homerun] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[homerun] unhandledRejection:', reason);
});

const client = new HAClient();

client.on('ready', () => {
  console.log(`[ha-client] ready — ${client.entityCount} entities cached`);
});

client.on('reconnected', () => {
  console.log(`[ha-client] reconnected — ${client.entityCount} entities refreshed`);
});

client.on('state_changed', ({ entity_id, old_state, new_state }) => {
  console.log(`[state] ${entity_id}: ${old_state?.state ?? '(new)'} → ${new_state.state}`);
});

await client.connect(process.env.HA_URL!, process.env.HA_TOKEN!);
