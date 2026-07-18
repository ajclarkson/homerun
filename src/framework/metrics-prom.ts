import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import type { MetricsBackend } from './metrics.js';

export class PromMetricsBackend implements MetricsBackend {
  readonly registry = new Registry();

  private readonly haEventsTotal: Counter;
  private readonly pipelineRunsTotal: Counter;
  private readonly actionsDispatchedTotal: Counter;
  private readonly actionsSucceededTotal: Counter;
  private readonly actionsFailedTotal: Counter;
  private readonly actionDurationSeconds: Histogram;
  private readonly automationsLoaded: Gauge;

  constructor(collectDefaults = false) {
    if (collectDefaults) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.haEventsTotal = new Counter({
      name: 'homerun_ha_events_received_total',
      help: 'Total HA and MQTT events received by homerun',
      labelNames: ['event_type'],
      registers: [this.registry],
    });

    this.pipelineRunsTotal = new Counter({
      name: 'homerun_pipeline_runs_total',
      help: 'Total automation pipeline runs',
      labelNames: ['location', 'trigger_type'],
      registers: [this.registry],
    });

    this.actionsDispatchedTotal = new Counter({
      name: 'homerun_actions_dispatched_total',
      help: 'Total actions dispatched by the action runtime',
      labelNames: ['location', 'action_type'],
      registers: [this.registry],
    });

    this.actionsSucceededTotal = new Counter({
      name: 'homerun_actions_succeeded_total',
      help: 'Total actions that completed successfully',
      labelNames: ['location', 'action_type'],
      registers: [this.registry],
    });

    this.actionsFailedTotal = new Counter({
      name: 'homerun_actions_failed_total',
      help: 'Total actions that failed with an error',
      labelNames: ['location', 'action_type'],
      registers: [this.registry],
    });

    this.actionDurationSeconds = new Histogram({
      name: 'homerun_action_duration_seconds',
      help: 'Duration of action execution in seconds',
      labelNames: ['location', 'action_type'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.automationsLoaded = new Gauge({
      name: 'homerun_automations_loaded',
      help: 'Number of automations currently loaded',
      registers: [this.registry],
    });
  }

  incrementCounter(name: string, labels: Record<string, string> = {}): void {
    switch (name) {
      case 'homerun_ha_events_received_total': this.haEventsTotal.inc(labels); break;
      case 'homerun_pipeline_runs_total': this.pipelineRunsTotal.inc(labels); break;
      case 'homerun_actions_dispatched_total': this.actionsDispatchedTotal.inc(labels); break;
      case 'homerun_actions_succeeded_total': this.actionsSucceededTotal.inc(labels); break;
      case 'homerun_actions_failed_total': this.actionsFailedTotal.inc(labels); break;
    }
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    if (name === 'homerun_action_duration_seconds') {
      this.actionDurationSeconds.observe(labels, value);
    }
  }

  setGauge(name: string, value: number): void {
    if (name === 'homerun_automations_loaded') {
      this.automationsLoaded.set(value);
    }
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
