import { describe, it, expect } from 'vitest';
import { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

// ---------- Helpers ----------

function makeAutomation(id: string): Automation<unknown> {
  return {
    id,
    location: 'test',
    subsystem: 'test',
    triggers: [],
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
  };
}

// ---------- Tests ----------

describe('AutomationRegistry', () => {
  it('register makes an automation available via getById', () => {
    const reg = new AutomationRegistry();
    const auto = makeAutomation('parlour:lighting');
    reg.register(auto);
    expect(reg.getById('parlour:lighting')).toBe(auto);
  });

  it('register makes an automation available via getAll', () => {
    const reg = new AutomationRegistry();
    const auto = makeAutomation('parlour:lighting');
    reg.register(auto);
    expect(reg.getAll()).toContain(auto);
  });

  it('re-registering the same id replaces the previous entry', () => {
    const reg = new AutomationRegistry();
    const v1 = makeAutomation('parlour:lighting');
    const v2 = makeAutomation('parlour:lighting');
    reg.register(v1);
    reg.register(v2);
    expect(reg.getById('parlour:lighting')).toBe(v2);
    expect(reg.getAll()).toHaveLength(1);
  });

  it('unregister removes the automation', () => {
    const reg = new AutomationRegistry();
    reg.register(makeAutomation('parlour:lighting'));
    reg.unregister('parlour:lighting');
    expect(reg.getById('parlour:lighting')).toBeUndefined();
    expect(reg.getAll()).toHaveLength(0);
  });

  it('unregister on an unknown id is a no-op and does not throw', () => {
    const reg = new AutomationRegistry();
    expect(() => reg.unregister('does:not:exist')).not.toThrow();
  });

  it('getAll returns a snapshot — mutations after the call do not affect it', () => {
    const reg = new AutomationRegistry();
    reg.register(makeAutomation('parlour:lighting'));
    const snapshot = reg.getAll();
    reg.register(makeAutomation('bedroom:lighting'));
    expect(snapshot).toHaveLength(1);
  });

  it('getAll returns all registered automations', () => {
    const reg = new AutomationRegistry();
    reg.register(makeAutomation('parlour:lighting'));
    reg.register(makeAutomation('kitchen:lighting'));
    reg.register(makeAutomation('bedroom:heating'));
    expect(reg.getAll()).toHaveLength(3);
  });

  it('getById returns undefined for an unknown id', () => {
    const reg = new AutomationRegistry();
    expect(reg.getById('unknown:thing')).toBeUndefined();
  });
});
