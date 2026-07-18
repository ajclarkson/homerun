import { describe, it, expect, beforeEach } from 'vitest';
import { NoopMetricsBackend } from './metrics.js';
import { PromMetricsBackend } from './metrics-prom.js';

// ---------- NoopMetricsBackend ----------

describe('NoopMetricsBackend', () => {
  it('incrementCounter does not throw', () => {
    const m = new NoopMetricsBackend();
    expect(() => m.incrementCounter('homerun_pipeline_runs_total', { location: 'parlour', trigger_type: 'on_start' })).not.toThrow();
  });

  it('observeHistogram does not throw', () => {
    const m = new NoopMetricsBackend();
    expect(() => m.observeHistogram('homerun_action_duration_seconds', 0.1, { location: 'parlour', action_type: 'ha.call_service' })).not.toThrow();
  });
});

// ---------- PromMetricsBackend ----------

describe('PromMetricsBackend', () => {
  let backend: PromMetricsBackend;

  beforeEach(() => {
    backend = new PromMetricsBackend();
  });

  it('getMetrics() returns a non-empty string', async () => {
    const output = await backend.getMetrics();
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('contentType includes text/plain', () => {
    expect(backend.contentType).toContain('text/plain');
  });

  it('homerun_pipeline_runs_total appears in output after being incremented', async () => {
    backend.incrementCounter('homerun_pipeline_runs_total', { location: 'parlour', trigger_type: 'on_start' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_pipeline_runs_total');
    expect(output).toContain('location="parlour"');
    expect(output).toContain('trigger_type="on_start"');
  });

  it('homerun_ha_events_received_total appears in output after being incremented', async () => {
    backend.incrementCounter('homerun_ha_events_received_total', { event_type: 'state_changed' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_ha_events_received_total');
    expect(output).toContain('event_type="state_changed"');
  });

  it('homerun_actions_dispatched_total appears after increment', async () => {
    backend.incrementCounter('homerun_actions_dispatched_total', { location: 'kitchen', action_type: 'ha.call_service' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_actions_dispatched_total');
  });

  it('homerun_actions_succeeded_total appears after increment', async () => {
    backend.incrementCounter('homerun_actions_succeeded_total', { location: 'kitchen', action_type: 'ha.call_service' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_actions_succeeded_total');
  });

  it('homerun_actions_failed_total appears after increment', async () => {
    backend.incrementCounter('homerun_actions_failed_total', { location: 'kitchen', action_type: 'ha.call_service' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_actions_failed_total');
  });

  it('homerun_action_duration_seconds appears after observation', async () => {
    backend.observeHistogram('homerun_action_duration_seconds', 0.25, { location: 'parlour', action_type: 'ha.call_service' });
    const output = await backend.getMetrics();
    expect(output).toContain('homerun_action_duration_seconds');
  });

  it('unknown counter name is a no-op and does not throw', () => {
    expect(() => backend.incrementCounter('nonexistent_metric', { foo: 'bar' })).not.toThrow();
  });

  it('unknown histogram name is a no-op and does not throw', () => {
    expect(() => backend.observeHistogram('nonexistent_metric', 1.0)).not.toThrow();
  });

  it('each PromMetricsBackend instance has an independent registry', async () => {
    const a = new PromMetricsBackend();
    const b = new PromMetricsBackend();
    a.incrementCounter('homerun_pipeline_runs_total', { location: 'parlour', trigger_type: 'on_start' });
    const outputA = await a.getMetrics();
    const outputB = await b.getMetrics();
    // A has a sample; B was never incremented so the counter value should not appear in B's output
    expect(outputA).toContain('location="parlour"');
    expect(outputB).not.toContain('location="parlour"');
  });
});
