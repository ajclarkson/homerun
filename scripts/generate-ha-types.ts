#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ---------- Types ----------

export interface HAStatePayload {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

// ---------- Inference ----------

export function inferStateType(
  entity: HAStatePayload,
  allObservedStates?: string[],
): string {
  const domain = entity.entity_id.split('.')[0];

  switch (domain) {
    case 'binary_sensor':
    case 'input_boolean':
    case 'switch':
      return "'on' | 'off'";

    case 'input_select': {
      const options = entity.attributes.options;
      if (Array.isArray(options) && options.length > 0) {
        return options.map((o: unknown) => `'${o}'`).join(' | ');
      }
      return 'string';
    }

    case 'person': {
      const states = allObservedStates ?? [entity.state];
      return [...new Set(states)].map((s) => `'${s}'`).join(' | ');
    }

    default:
      return 'string';
  }
}

// ---------- File generation ----------

export function generateFileContent(states: HAStatePayload[]): string {
  const personStates = new Map<string, string[]>();
  for (const s of states) {
    if (s.entity_id.startsWith('person.')) {
      const existing = personStates.get(s.entity_id) ?? [];
      existing.push(s.state);
      personStates.set(s.entity_id, existing);
    }
  }

  const entries = states
    .map((s) => {
      const stateType = inferStateType(s, personStates.get(s.entity_id));
      return `  '${s.entity_id}': { state: ${stateType} };`;
    })
    .join('\n');

  return `// generated — do not edit — run: npm run generate:ha-types
export interface HAEntities {
${entries}
}

export type HAState = {
  <E extends keyof HAEntities>(entity: E): HAEntities[E]['state'];
  <E extends string>(entity: E): string | undefined;
};
`;
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;

  if (!url || !token) {
    console.error('Error: HA_URL and HA_TOKEN must be set');
    process.exit(1);
  }

  const res = await fetch(`${url}/api/states`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`Error: HA API returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const states = (await res.json()) as HAStatePayload[];
  const content = generateFileContent(states);

  const outPath = path.join(process.cwd(), 'types', 'ha-entities.ts');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, content, 'utf8');

  console.log(`Written ${states.length} entities to ${outPath}`);
}

if (process.argv[1]?.endsWith('generate-ha-types.ts') || process.argv[1]?.endsWith('generate-ha-types.js')) {
  main().catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
