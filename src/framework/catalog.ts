import type { MqttClient } from 'mqtt';
import type { Automation } from '../types/automation.js';
import type { Outcome } from '../types/reasons.js';
import type { AutomationRegistry } from './registry.js';
import { CATALOG_SCHEMA_ID, assertValidCatalog } from './schemas.js';
import { namespace } from './namespace.js';

export interface CatalogReason {
  outcome: Outcome;
  facts: string[];
}

export interface CatalogEntry {
  automation_id: string;
  location: string;
  subsystem: string;
  reasons: Record<string, CatalogReason>;
}

export interface Catalog {
  schema: typeof CATALOG_SCHEMA_ID;
  automations: CatalogEntry[];
}

export function catalogReasons(automation: Automation<unknown>): Record<string, CatalogReason> | undefined {
  if (!automation.reasons) return undefined;
  return Object.fromEntries(
    Object.entries(automation.reasons).map(([reason, spec]) => [
      reason,
      { outcome: spec.outcome, facts: [...(spec.facts ?? [])] },
    ]),
  );
}

// Only automations that declare reasons appear (so a consumer with none gets an empty list): the catalogue answers "what can this
// automation say about itself", and an undeclared automation says nothing. Sorted so the same
// registry always serialises identically, which is what lets the publisher skip no-op republishes.
export function buildCatalog(automations: readonly Automation<unknown>[]): Catalog {
  const entries: CatalogEntry[] = [];
  for (const a of automations) {
    const reasons = catalogReasons(a);
    if (reasons) entries.push({ automation_id: a.id, location: a.location, subsystem: a.subsystem, reasons });
  }
  entries.sort((x, y) => x.automation_id.localeCompare(y.automation_id));
  return { schema: CATALOG_SCHEMA_ID, automations: entries };
}

export class CatalogPublisher {
  private lastPublished: string | undefined;
  private pending: NodeJS.Timeout | undefined;

  constructor(
    private readonly mqtt: MqttClient,
    private readonly registry: AutomationRegistry,
    private readonly dryRun: boolean,
  ) {}

  // Publishes at startup and again after registry changes (a hot reload unregisters and
  // re-registers the changed files). Changes are debounced so a rescan retains one settled
  // catalogue rather than a flicker of partial ones, and an identical catalogue sends nothing.
  start(debounceMs = 500): void {
    this.publish();
    this.registry.onChange(() => {
      clearTimeout(this.pending);
      this.pending = setTimeout(() => this.publish(), debounceMs);
      this.pending.unref();
    });
  }

  // Always sends on the first call, even an empty catalogue: after a restart that dropped the
  // last declaration, a stale retained copy would otherwise outlive it. `lastPublished` is set
  // only once the broker accepted the message, so a failure is retried by the next trigger.
  publish(): void {
    try {
      const catalog = buildCatalog(this.registry.getAll());
      assertValidCatalog(catalog);
      const payload = JSON.stringify(catalog);
      if (payload === this.lastPublished) return;
      const topic = `${namespace(this.dryRun)}/catalog`;
      this.mqtt.publishAsync(topic, payload, { retain: true }).then(() => {
        this.lastPublished = payload;
      }).catch((err: unknown) => {
        console.error(`[CatalogPublisher] MQTT publish failed on ${topic}:`, err);
      });
    } catch (err) {
      console.error('[CatalogPublisher] catalogue not published:', err);
    }
  }
}
