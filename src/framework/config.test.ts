import { describe, it, expect } from 'vitest';
import { parseConfig } from './config.js';

// ---------- Fixtures ----------

const MINIMAL = `
homeassistant:
  url: http://homeassistant.local:8123
  token: test-token
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;

// ---------- Valid config ----------

describe('parseConfig — valid configuration', () => {
  it('parses required fields correctly', () => {
    const config = parseConfig(MINIMAL);
    expect(config.homeassistant.url).toBe('http://homeassistant.local:8123');
    expect(config.homeassistant.token).toBe('test-token');
    expect(config.mqtt.url).toBe('mqtt://localhost:1883');
    expect(config.automations.dir).toBe('./automations');
  });

  it('defaults server.port to 7070', () => {
    expect(parseConfig(MINIMAL).server.port).toBe(7070);
  });

  it('defaults options.dry_run to false', () => {
    expect(parseConfig(MINIMAL).options.dry_run).toBe(false);
  });

  it('respects explicit server.port', () => {
    const config = parseConfig(MINIMAL + '\nserver:\n  port: 8080');
    expect(config.server.port).toBe(8080);
  });

  it('respects explicit options.dry_run: true', () => {
    const config = parseConfig(MINIMAL + '\noptions:\n  dry_run: true');
    expect(config.options.dry_run).toBe(true);
  });
});

// ---------- !secret resolution ----------

describe('parseConfig — !secret resolution', () => {
  it('resolves !secret references from secrets content', () => {
    const configContent = `
homeassistant:
  url: http://homeassistant.local:8123
  token: !secret ha_token
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    const config = parseConfig(configContent, 'ha_token: my-secret-token\n', {});
    expect(config.homeassistant.token).toBe('my-secret-token');
  });

  it('throws when a !secret key is absent from secrets.yaml', () => {
    const configContent = `
homeassistant:
  url: http://homeassistant.local:8123
  token: !secret missing_key
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    expect(() => parseConfig(configContent, 'ha_token: value\n', {})).toThrow("!secret 'missing_key' not found");
  });

  it('works without secrets content when no !secret tags are present', () => {
    expect(() => parseConfig(MINIMAL, undefined, {})).not.toThrow();
  });
});

// ---------- Env var overrides ----------

describe('parseConfig — HOMERUN_* env var overrides', () => {
  it('HOMERUN_HA_URL overrides homeassistant.url', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_HA_URL: 'http://override:8123' });
    expect(config.homeassistant.url).toBe('http://override:8123');
  });

  it('HOMERUN_HA_TOKEN overrides homeassistant.token', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_HA_TOKEN: 'override-token' });
    expect(config.homeassistant.token).toBe('override-token');
  });

  it('HOMERUN_MQTT_URL overrides mqtt.url', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_MQTT_URL: 'mqtt://other:1883' });
    expect(config.mqtt.url).toBe('mqtt://other:1883');
  });

  it('HOMERUN_AUTOMATIONS_DIR overrides automations.dir', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_AUTOMATIONS_DIR: '/custom/path' });
    expect(config.automations.dir).toBe('/custom/path');
  });

  it('HOMERUN_SERVER_PORT is coerced to integer', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_SERVER_PORT: '9000' });
    expect(config.server.port).toBe(9000);
  });

  it('HOMERUN_DRY_RUN=true is coerced to boolean true', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_DRY_RUN: 'true' });
    expect(config.options.dry_run).toBe(true);
  });

  it('HOMERUN_DRY_RUN=false is coerced to boolean false', () => {
    const content = MINIMAL + '\noptions:\n  dry_run: true';
    const config = parseConfig(content, undefined, { HOMERUN_DRY_RUN: 'false' });
    expect(config.options.dry_run).toBe(false);
  });

  it('env overrides work when optional config sections are absent', () => {
    const config = parseConfig(MINIMAL, undefined, { HOMERUN_SERVER_PORT: '9999', HOMERUN_DRY_RUN: 'true' });
    expect(config.server.port).toBe(9999);
    expect(config.options.dry_run).toBe(true);
  });

  it('env overrides take precedence over config file values', () => {
    const content = MINIMAL + '\nserver:\n  port: 8080';
    const config = parseConfig(content, undefined, { HOMERUN_SERVER_PORT: '9999' });
    expect(config.server.port).toBe(9999);
  });
});

// ---------- Validation errors ----------

describe('parseConfig — validation errors', () => {
  it('throws when homeassistant section is missing', () => {
    const content = `
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('Invalid configuration');
  });

  it('throws when homeassistant.url is missing', () => {
    const content = `
homeassistant:
  token: test-token
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('Invalid configuration');
  });

  it('throws when homeassistant.token is missing', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('Invalid configuration');
  });

  it('error message includes the failing field path', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
mqtt:
  url: mqtt://localhost:1883
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('homeassistant.token');
  });

  it('throws when mqtt.url is missing', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
  token: test-token
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('Invalid configuration');
  });

  it('throws when automations.dir is missing', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
  token: test-token
mqtt:
  url: mqtt://localhost:1883
`;
    expect(() => parseConfig(content, undefined, {})).toThrow('Invalid configuration');
  });
});
