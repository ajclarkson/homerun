import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA_FILES } from '../src/framework/schemas.js';

// Writes the published JSON Schema files. Run after editing src/framework/schemas.ts; a test
// fails when the committed files differ from what this would write.
const dir = path.resolve(import.meta.dirname, '../schemas');
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(SCHEMA_FILES)) {
  writeFileSync(path.join(dir, name), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${name}`);
}
