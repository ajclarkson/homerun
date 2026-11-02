import type { MqttClient } from 'mqtt';
import type { Automation } from '../types/automation.js';
import type { Outcome } from '../types/reasons.js';
import type { AutomationRegistry } from './registry.js';
import { CATALOG_SCHEMA_ID, assertValidCatalog } from './schemas.js';

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

// Only automations that declare reasons appear: the catalogue answers "what can this
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

  publish(): void {
    try {
      const catalog = buildCatalog(this.registry.getAll());
      // A consumer with no declarations never sees a `homerun/catalog` topic appear. Once one
      // has been published, an emptied catalogue is still sent so the retained copy is not stale.
      if (catalog.automations.length === 0 && this.lastPublished === undefined) return;
      assertValidCatalog(catalog);
      const payload = JSON.stringify(catalog);
      if (payload === this.lastPublished) return;
      this.lastPublished = payload;
      const topic = `${this.dryRun ? 'homerun/dev' : 'homerun'}/catalog`;
      this.mqtt.publishAsync(topic, payload, { retain: true }).catch((err: unknown) => {
        console.error(`[CatalogPublisher] MQTT publish failed on ${topic}:`, err);
      });
    } catch (err) {
      console.error('[CatalogPublisher] catalogue not published:', err);
    }
  }
}
