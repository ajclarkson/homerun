import { describe, it, expect } from 'vitest';
import { inferFieldType, generateFileContent } from './generate-ha-services.js';
import type { HAServicePayload, HAServiceField } from './generate-ha-services.js';

// ---------- inferFieldType ----------

describe('inferFieldType', () => {
  it('number selector -> number', () => {
    const field: HAServiceField = { selector: { number: { min: 0, max: 100 } } };
    expect(inferFieldType(field)).toBe('number');
  });

  it('color_temp selector -> number', () => {
    expect(inferFieldType({ selector: { color_temp: {} } })).toBe('number');
  });

  it('boolean selector -> boolean', () => {
    expect(inferFieldType({ selector: { boolean: {} } })).toBe('boolean');
  });

  it('color_rgb selector -> [number, number, number]', () => {
    expect(inferFieldType({ selector: { color_rgb: {} } })).toBe('[number, number, number]');
  });

  it('duration selector -> duration object type', () => {
    expect(inferFieldType({ selector: { duration: {} } })).toBe('{ hours?: number; minutes?: number; seconds?: number }');
  });

  it('object selector -> Record<string, unknown>', () => {
    expect(inferFieldType({ selector: { object: {} } })).toBe('Record<string, unknown>');
  });

  it('text selector -> string', () => {
    expect(inferFieldType({ selector: { text: {} } })).toBe('string');
  });

  it('select selector -> string', () => {
    expect(inferFieldType({ selector: { select: { options: ['a', 'b'] } } })).toBe('string');
  });

  it('state selector -> string', () => {
    expect(inferFieldType({ selector: { state: {} } })).toBe('string');
  });

  it('entity selector -> string', () => {
    expect(inferFieldType({ selector: { entity: {} } })).toBe('string');
  });

  it('unknown selector -> string (fallthrough)', () => {
    expect(inferFieldType({ selector: { theme: {} } })).toBe('string');
  });

  it('no selector -> unknown', () => {
    expect(inferFieldType({})).toBe('unknown');
  });

  it('empty selector object -> unknown', () => {
    expect(inferFieldType({ selector: {} })).toBe('unknown');
  });
});

// ---------- generateFileContent ----------

const minimalServices: HAServicePayload[] = [
  {
    domain: 'input_boolean',
    services: {
      turn_on: {
        fields: {},
        target: { entity: [{ domain: ['input_boolean'] }] },
      },
      turn_off: {
        fields: {},
        target: { entity: [{ domain: ['input_boolean'] }] },
      },
      reload: {
        fields: {},
      },
    },
  },
];

const serviceWithFields: HAServicePayload[] = [
  {
    domain: 'climate',
    services: {
      set_temperature: {
        fields: {
          temperature: { selector: { number: { min: 0, max: 250 } } },
          hvac_mode: { selector: { state: {} } },
        },
        target: { entity: [{ domain: ['climate'] }] },
      },
    },
  },
];

const serviceWithRequiredField: HAServicePayload[] = [
  {
    domain: 'input_number',
    services: {
      set_value: {
        fields: {
          value: { required: true, selector: { number: { min: 0, max: 1000 } } },
        },
        target: { entity: [{ domain: ['input_number'] }] },
      },
    },
  },
];

describe('generateFileContent — header and imports', () => {
  it('includes the do-not-edit header with run command', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain('// generated — do not edit — run: npm run generate:ha-services');
  });

  it('imports Action from @ajclarkson/homerun', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain("import type { Action } from '@ajclarkson/homerun'");
  });

  it('exports a Services const', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain('export const Services = {');
  });

  it('notes selected domains in header when --domains is used', () => {
    const out = generateFileContent(minimalServices, ['input_boolean']);
    expect(out).toContain('// domains: input_boolean');
  });

  it('does not note domains when none specified', () => {
    const out = generateFileContent(minimalServices);
    expect(out).not.toContain('// domains:');
  });
});

describe('generateFileContent — target-only service (no fields)', () => {
  it('generates a builder taking only a target param', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain("turn_on: (target: { entity_id: string }): Action =>");
  });

  it('body includes type, domain, service, and target', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain("type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on', target");
  });
});

describe('generateFileContent — no-target no-fields service (e.g. reload)', () => {
  it('generates a zero-param builder', () => {
    const out = generateFileContent(minimalServices);
    expect(out).toContain("reload: (): Action =>");
  });

  it('body does not include target or data', () => {
    const out = generateFileContent(minimalServices);
    const reloadLine = out.split('\n').find((l) => l.includes("service: 'reload'"))!;
    expect(reloadLine).not.toContain('target');
    expect(reloadLine).not.toContain('data');
  });
});

describe('generateFileContent — target + optional fields', () => {
  it('generates a builder with target and optional data', () => {
    const out = generateFileContent(serviceWithFields);
    expect(out).toContain("set_temperature: (target: { entity_id: string }, data?: { temperature?: number; hvac_mode?: string }): Action =>");
  });

  it('body casts data with | undefined for optional data', () => {
    const out = generateFileContent(serviceWithFields);
    expect(out).toContain('data: data as Record<string, unknown> | undefined');
  });
});

describe('generateFileContent — required fields', () => {
  it('makes data param required when any field is required', () => {
    const out = generateFileContent(serviceWithRequiredField);
    expect(out).toContain('data: { value: number }');
    expect(out).not.toContain('data?: { value: number }');
  });

  it('casts required data without | undefined', () => {
    const out = generateFileContent(serviceWithRequiredField);
    const line = out.split('\n').find((l) => l.includes("service: 'set_value'"))!;
    expect(line).toContain('data: data as Record<string, unknown>');
    expect(line).not.toContain('| undefined');
  });
});

describe('generateFileContent — domain filtering', () => {
  const multi: HAServicePayload[] = [
    { domain: 'input_boolean', services: { turn_on: { fields: {}, target: {} } } },
    { domain: 'light', services: { turn_on: { fields: {}, target: {} } } },
    { domain: 'climate', services: { set_temperature: { fields: {}, target: {} } } },
  ];

  it('only generates specified domains when --domains is given', () => {
    const out = generateFileContent(multi, ['input_boolean', 'light']);
    expect(out).toContain('input_boolean:');
    expect(out).toContain('light:');
    expect(out).not.toContain('climate:');
  });

  it('generates all domains when no filter is given', () => {
    const out = generateFileContent(multi);
    expect(out).toContain('input_boolean:');
    expect(out).toContain('light:');
    expect(out).toContain('climate:');
  });

  it('produces an empty Services object when no domains match', () => {
    const out = generateFileContent(multi, ['notify']);
    expect(out).toContain('export const Services = {};');
  });
});
