import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MqttClient } from 'mqtt';
import { buildCatalog, CatalogPublisher } from './catalog.js';
import { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

const validator = z.fromJSONSchema(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../schemas/home.catalog.v1.json'), 'utf8')));

function auto(id: string, extra: Partial<Automation<unknown>> = {}): Automation<unknown> {
  const [location, subsystem] = id.split(':');
  return { id, location, subsystem, triggers: [], context: () => ({}), reduce: () => ({ decision: 'x', actions: [] }), ...extra };
}
const declared = (id: string) => auto(id, { reasons: { lux_high: { outcome: 'declined', facts: ['lux'] }, on: { outcome: 'acted' } } });

describe('buildCatalog', () => {
  it('lists only declaring automations, sorted, with facts always an array', () => {
    const catalog = buildCatalog([declared('hall:lighting'), auto('x:heating'), declared('attic:lighting')]);
    expect(catalog.automations.map((a) => a.automation_id)).toEqual(['attic:lighting', 'hall:lighting']);
    expect(catalog.automations[0].reasons).toEqual({
      lux_high: { outcome: 'declined', facts: ['lux'] },
      on: { outcome: 'acted', facts: [] },
    });
  });

  it('validates against the published schema file', () => {
    expect(validator.safeParse(buildCatalog([declared('hall:lighting')])).success).toBe(true);
  });

  it('does not alias the automation\'s own fact list', () => {
    const a = declared('hall:lighting');
    buildCatalog([a]).automations[0].reasons.lux_high.facts.push('mutated');
    expect(a.reasons?.lux_high.facts).toEqual(['lux']);
  });
});

describe('CatalogPublisher', () => {
  let mqtt: { publishAsync: ReturnType<typeof vi.fn> };
  let registry: AutomationRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    mqtt = { publishAsync: vi.fn().mockResolvedValue(undefined) };
    registry = new AutomationRegistry();
  });
  afterEach(() => vi.useRealTimers());

  const make = (dryRun = false) => new CatalogPublisher(mqtt as unknown as MqttClient, registry, dryRun);

  it('publishes the catalogue retained on homerun/catalog, valid against the schema', () => {
    registry.register(declared('hall:lighting'));
    make().start();
    const [topic, payload, opts] = mqtt.publishAsync.mock.calls[0];
    expect(topic).toBe('homerun/catalog');
    expect(opts).toEqual({ retain: true });
    expect(validator.safeParse(JSON.parse(payload)).success).toBe(true);
  });

  it('uses homerun/dev/catalog in a dry run', () => {
    registry.register(declared('hall:lighting'));
    make(true).start();
    expect(mqtt.publishAsync.mock.calls[0][0]).toBe('homerun/dev/catalog');
  });

  it('publishes an empty catalogue at startup, so a stale retained copy is replaced', () => {
    registry.register(auto('x:heating'));
    make().start();
    expect(JSON.parse(mqtt.publishAsync.mock.calls[0][1]).automations).toEqual([]);
    expect(validator.safeParse(JSON.parse(mqtt.publishAsync.mock.calls[0][1])).success).toBe(true);
  });

  it('republishes once, debounced, after a reload that changes the catalogue', async () => {
    registry.register(declared('hall:lighting'));
    make().start();
    registry.unregister('hall:lighting');
    registry.register(declared('hall:lighting'));
    registry.register(declared('attic:lighting'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqtt.publishAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mqtt.publishAsync.mock.calls[1][1]).automations).toHaveLength(2);
  });

  it('sends nothing for a reload that leaves the catalogue identical', async () => {
    registry.register(declared('hall:lighting'));
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    registry.register(declared('hall:lighting'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mqtt.publishAsync).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed publish instead of remembering it as sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mqtt.publishAsync.mockRejectedValueOnce(new Error('down'));
    registry.register(declared('hall:lighting'));
    const publisher = make();
    publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    publisher.publish();
    expect(mqtt.publishAsync).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('publishes an emptied catalogue after one has been published', async () => {
    registry.register(declared('hall:lighting'));
    make().start();
    await vi.advanceTimersByTimeAsync(0);
    registry.unregister('hall:lighting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(mqtt.publishAsync.mock.calls[1][1]).automations).toEqual([]);
  });

  it('logs and carries on when the publish fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mqtt.publishAsync.mockRejectedValue(new Error('down'));
    registry.register(declared('hall:lighting'));
    expect(() => make().start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
