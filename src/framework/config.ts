import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { load, CORE_SCHEMA, defineScalarTag } from 'js-yaml';
import { z } from 'zod';

// Internal marker for !secret references resolved at load time
interface SecretRef { __secret: string }

function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === 'object' && v !== null && '__secret' in v;
}

const secretTag = defineScalarTag<SecretRef>('!secret', {
  implicit: false,
  resolve: (source) => ({ __secret: source }),
});

const SCHEMA_WITH_SECRET = CORE_SCHEMA.withTags(secretTag);

const ConfigSchema = z.object({
  homeassistant: z.object({
    url: z.string().min(1, 'homeassistant.url is required'),
    token: z.string().min(1, 'homeassistant.token is required'),
  }),
  mqtt: z.object({
    url: z.string().min(1, 'mqtt.url is required'),
  }),
  automations: z.object({
    dir: z.string().min(1, 'automations.dir is required'),
  }),
  server: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(7070),
  }).default({ port: 7070 }),
  options: z.object({
    dry_run: z.boolean().default(false),
  }).default({ dry_run: false }),
});

export type HomerunConfig = z.infer<typeof ConfigSchema>;

// Explicit env var mapping — adding a new config key means adding a line here
const ENV_OVERRIDES: Array<{
  key: string;
  path: string[];
  parse?: (v: string) => unknown;
}> = [
  { key: 'HOMERUN_HA_URL', path: ['homeassistant', 'url'] },
  { key: 'HOMERUN_HA_TOKEN', path: ['homeassistant', 'token'] },
  { key: 'HOMERUN_MQTT_URL', path: ['mqtt', 'url'] },
  { key: 'HOMERUN_AUTOMATIONS_DIR', path: ['automations', 'dir'] },
  { key: 'HOMERUN_SERVER_PORT', path: ['server', 'port'], parse: (v) => parseInt(v, 10) },
  { key: 'HOMERUN_DRY_RUN', path: ['options', 'dry_run'], parse: (v) => v === 'true' },
];

function setDeep(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  const [head, ...rest] = keys;
  if (rest.length === 0) {
    obj[head] = value;
    return;
  }
  if (typeof obj[head] !== 'object' || obj[head] === null) {
    obj[head] = {};
  }
  setDeep(obj[head] as Record<string, unknown>, rest, value);
}

function resolveSecrets(value: unknown, secrets: Record<string, unknown>): unknown {
  if (isSecretRef(value)) {
    const key = value.__secret;
    if (!(key in secrets)) {
      throw new Error(`!secret '${key}' not found in secrets.yaml`);
    }
    return secrets[key];
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecrets(item, secrets));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveSecrets(v, secrets)]),
    );
  }
  return value;
}

export function parseConfig(
  configContent: string,
  secretsContent?: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): HomerunConfig {
  const raw = (load(configContent, { schema: SCHEMA_WITH_SECRET }) ?? {}) as Record<string, unknown>;

  const secrets = secretsContent
    ? (load(secretsContent) ?? {}) as Record<string, unknown>
    : {};

  const resolved = resolveSecrets(raw, secrets) as Record<string, unknown>;

  for (const { key, path: keyPath, parse } of ENV_OVERRIDES) {
    const val = env[key];
    if (val !== undefined) {
      setDeep(resolved, keyPath, parse ? parse(val) : val);
    }
  }

  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`[homerun] Invalid configuration:\n${errors}`);
  }

  return result.data;
}

export async function loadConfig(configPath?: string): Promise<HomerunConfig> {
  const absPath = path.resolve(
    configPath ?? process.env.HOMERUN_CONFIG ?? './configuration.yaml',
  );

  if (!existsSync(absPath)) {
    throw new Error(
      `[homerun] Config file not found: ${absPath}\n` +
      'Create configuration.yaml or set HOMERUN_CONFIG to point to your config file.\n' +
      'See configuration.yaml.example for reference.',
    );
  }

  const configContent = await readFile(absPath, 'utf8');

  const secretsPath = path.join(path.dirname(absPath), 'secrets.yaml');
  const secretsContent = existsSync(secretsPath)
    ? await readFile(secretsPath, 'utf8')
    : undefined;

  return parseConfig(configContent, secretsContent);
}
