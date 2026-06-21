import 'dotenv/config';
import { createConnection, createLongLivedTokenAuth, subscribeEntities } from 'home-assistant-js-websocket';

  const auth = createLongLivedTokenAuth(process.env.HA_URL!, process.env.HA_TOKEN!);
  const connection = await createConnection({ auth });

  subscribeEntities(connection, (entities) => {
    const count = Object.keys(entities).length;
    console.log(`State cache populated: ${count} entities`);
  });
