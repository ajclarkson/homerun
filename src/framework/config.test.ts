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
    const config = parseConfig(configContent, 'ha_token: my-secret-token\n');
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
    expect(() => parseConfig(configContent, 'ha_token: value\n')).toThrow("!secret 'missing_key' not found");
  });

  it('works without secrets content when no !secret tags are present', () => {
    expect(() => parseConfig(MINIMAL)).not.toThrow();
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
    expect(() => parseConfig(content)).toThrow('Invalid configuration');
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
    expect(() => parseConfig(content)).toThrow('Invalid configuration');
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
    expect(() => parseConfig(content)).toThrow('Invalid configuration');
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
    expect(() => parseConfig(content)).toThrow('homeassistant.token');
  });

  it('throws when mqtt.url is missing', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
  token: test-token
automations:
  dir: ./automations
`;
    expect(() => parseConfig(content)).toThrow('Invalid configuration');
  });

  it('throws when automations.dir is missing', () => {
    const content = `
homeassistant:
  url: http://homeassistant.local:8123
  token: test-token
mqtt:
  url: mqtt://localhost:1883
`;
    expect(() => parseConfig(content)).toThrow('Invalid configuration');
  });
});
