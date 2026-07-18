#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ---------- Types ----------

export interface HAServicePayload {
  domain: string;
  services: Record<string, HAServiceDef>;
}

export interface HAServiceDef {
  fields: Record<string, HAServiceField>;
  target?: unknown;
}

export interface HAServiceField {
  required?: boolean;
  selector?: Record<string, unknown>;
  advanced?: boolean;
}

// ---------- Type inference ----------

export function inferFieldType(field: HAServiceField): string {
  const selector = field.selector;
  if (!selector) return 'unknown';

  const key = Object.keys(selector)[0];
  if (!key) return 'unknown';

  switch (key) {
    case 'number':
    case 'color_temp':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'color_rgb':
      return '[number, number, number]';
    case 'duration':
      return '{ hours?: number; minutes?: number; seconds?: number }';
    case 'object':
      return 'Record<string, unknown>';
    default:
      return 'string';
  }
}

// ---------- Service builder generation ----------

function generateServiceBuilder(domain: string, service: string, def: HAServiceDef): string {
  const hasTarget = !!def.target;
  const fieldEntries = Object.entries(def.fields ?? {});
  const hasFields = fieldEntries.length > 0;

  const params: string[] = [];
  if (hasTarget) params.push('target: { entity_id: string }');

  let anyRequired = false;
  if (hasFields) {
    anyRequired = fieldEntries.some(([, f]) => f.required);
    const fieldDefs = fieldEntries
      .map(([name, field]) => `${name}${field.required ? '' : '?'}: ${inferFieldType(field)}`)
      .join('; ');
    params.push(`data${anyRequired ? '' : '?'}: { ${fieldDefs} }`);
  }

  const bodyParts: string[] = [
    `type: 'ha.call_service'`,
    `domain: '${domain}'`,
    `service: '${service}'`,
  ];
  if (hasTarget) bodyParts.push('target');
  if (hasFields) {
    bodyParts.push(`data: data as Record<string, unknown>${anyRequired ? '' : ' | undefined'}`);
  }

  return `    ${service}: (${params.join(', ')}): Action => ({ ${bodyParts.join(', ')} })`;
}

// ---------- File generation ----------

export function generateFileContent(services: HAServicePayload[], domains?: string[]): string {
  const filtered = domains
    ? services.filter(({ domain }) => domains.includes(domain))
    : services;

  const domainBlocks = filtered.map(({ domain, services: svcMap }) => {
    const builders = Object.entries(svcMap)
      .map(([service, def]) => generateServiceBuilder(domain, service, def))
      .join(',\n');
    return `  ${domain}: {\n${builders},\n  }`;
  });

  const domainsNote = domains ? `\n// domains: ${domains.join(', ')}` : '';
  const blockStr = domainBlocks.length > 0 ? `\n${domainBlocks.join(',\n')},\n` : '';

  return `// generated — do not edit — run: npm run generate:ha-services${domainsNote}
import type { Action } from '@ajclarkson/homerun';

export const Services = {${blockStr}};
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

  const domainsArg = process.argv.find((a) => a.startsWith('--domains='));
  const domains = domainsArg ? domainsArg.slice('--domains='.length).split(',') : undefined;

  const res = await fetch(`${url}/api/services`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`Error: HA API returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const allServices = (await res.json()) as HAServicePayload[];
  const content = generateFileContent(allServices, domains);

  const outPath = path.join(process.cwd(), 'types', 'ha-services.ts');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, content, 'utf8');

  const filtered = domains
    ? allServices.filter(({ domain }) => domains.includes(domain))
    : allServices;
  const serviceCount = filtered.reduce((n, { services: s }) => n + Object.keys(s).length, 0);
  const domainLabel = domains ? `${domains.length} selected` : `all ${allServices.length}`;

  console.log(`Written ${serviceCount} services across ${domainLabel} domains to ${outPath}`);
}

if (
  process.argv[1]?.endsWith('generate-ha-services.ts') ||
  process.argv[1]?.endsWith('generate-ha-services.js') ||
  process.argv[1]?.endsWith('homerun-generate-ha-services')
) {
  main().catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
