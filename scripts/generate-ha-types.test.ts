import { describe, it, expect } from 'vitest';
import { inferStateType, generateFileContent } from './generate-ha-types.js';

// ---------- inferStateType ----------

describe('inferStateType', () => {
  it('binary_sensor produces "on" | "off" | unavailable/unknown', () => {
    expect(inferStateType({ entity_id: 'binary_sensor.parlour_sensor_motion', state: 'off', attributes: {} }))
      .toBe("'on' | 'off' | 'unavailable' | 'unknown'");
  });

  it('input_boolean produces "on" | "off" | unavailable/unknown', () => {
    expect(inferStateType({ entity_id: 'input_boolean.house_heating_enabled', state: 'on', attributes: {} }))
      .toBe("'on' | 'off' | 'unavailable' | 'unknown'");
  });

  it('switch produces "on" | "off" | unavailable/unknown', () => {
    expect(inferStateType({ entity_id: 'switch.kitchen_plug', state: 'off', attributes: {} }))
      .toBe("'on' | 'off' | 'unavailable' | 'unknown'");
  });

  it('input_select uses union of attributes.options with unavailable/unknown', () => {
    expect(inferStateType({
      entity_id: 'input_select.house_active_mode_modifier',
      state: 'none',
      attributes: { options: ['none', 'guest', 'sitter'] },
    })).toBe("'none' | 'guest' | 'sitter' | 'unavailable' | 'unknown'");
  });

  it('input_select falls back to string when options attribute is missing', () => {
    expect(inferStateType({ entity_id: 'input_select.broken', state: 'x', attributes: {} }))
      .toBe('string');
  });

  it('person produces string (state is a transient snapshot, not an exhaustive vocabulary)', () => {
    expect(inferStateType({ entity_id: 'person.adam', state: 'home', attributes: {} }, ['home', 'not_home']))
      .toBe('string');
  });

  it('unknown domain produces string', () => {
    expect(inferStateType({ entity_id: 'sensor.parlour_sensor_climate_temperature', state: '18.5', attributes: {} }))
      .toBe('string');
  });

  it('light produces string', () => {
    expect(inferStateType({ entity_id: 'light.kitchen_light_ceiling', state: 'on', attributes: {} }))
      .toBe('string');
  });
});

// ---------- generateFileContent ----------

describe('generateFileContent', () => {
  const states = [
    { entity_id: 'input_boolean.house_heating_enabled', state: 'on', attributes: {} },
    { entity_id: 'input_select.house_active_mode_modifier', state: 'none', attributes: { options: ['none', 'guest'] } },
    { entity_id: 'sensor.parlour_temperature', state: '18.5', attributes: {} },
  ];

  it('includes the do-not-edit header with run command', () => {
    const content = generateFileContent(states);
    expect(content).toContain('// generated — do not edit');
    expect(content).toContain('generate:ha-types');
  });

  it('emits an entry for each entity', () => {
    const content = generateFileContent(states);
    expect(content).toContain("'input_boolean.house_heating_enabled'");
    expect(content).toContain("'input_select.house_active_mode_modifier'");
    expect(content).toContain("'sensor.parlour_temperature'");
  });

  it('applies correct types per domain', () => {
    const content = generateFileContent(states);
    expect(content).toContain("'input_boolean.house_heating_enabled': { state: 'on' | 'off' | 'unavailable' | 'unknown' }");
    expect(content).toContain("'input_select.house_active_mode_modifier': { state: 'none' | 'guest' | 'unavailable' | 'unknown' }");
    expect(content).toContain("'sensor.parlour_temperature': { state: string }");
  });

  it('declares HAEntities as a global ambient interface (no export)', () => {
    const content = generateFileContent(states);
    expect(content).toContain('interface HAEntities');
    expect(content).not.toContain('export interface HAEntities');
    expect(content).not.toContain('export type HAState');
  });

  it('has no top-level import or export so the file is ambient', () => {
    const content = generateFileContent(states);
    expect(content).not.toMatch(/^import /m);
    expect(content).not.toMatch(/^export /m);
  });
});
