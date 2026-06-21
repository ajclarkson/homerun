import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';

// ---------- Mock node-cron ----------

const { mockCronSchedule } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCronSchedule: vi.fn((_expr: string, _cb: () => void): any => ({ stop: vi.fn() })),
}));
vi.mock('node-cron', () => ({ default: { schedule: mockCronSchedule } }));

// ---------- Helpers ----------

function makeAutomation(id: string, cron: string): Automation<unknown> {
  return {
    id,
    location: 'test',
    subsystem: 'test',
    triggers: [{ type: 'schedule', cron }],
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
  };
}

function makeOnStartAutomation(id: string): Automation<unknown> {
  return {
    id,
    location: 'test',
    subsystem: 'test',
    triggers: [{ type: 'on_start' }],
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
  };
}

function makeReadyPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { ready: promise, resolveReady: resolve };
}

function cronCallbackFor(callIndex = 0): () => void {
  return (mockCronSchedule.mock.calls[callIndex] as [string, () => void])[1];
}

// ---------- Tests ----------

describe('Scheduler', () => {
  beforeEach(() => mockCronSchedule.mockClear());

  it('registers a cron job for each schedule trigger on start()', () => {
    const automation = makeAutomation('a', '0 8 * * *');
    const scheduler = new Scheduler([automation], vi.fn(), Promise.resolve());
    scheduler.start();

    expect(mockCronSchedule).toHaveBeenCalledOnce();
    expect(mockCronSchedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
  });

  it('registers separate cron jobs for different expressions', () => {
    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], vi.fn(), Promise.resolve());
    scheduler.start();

    expect(mockCronSchedule).toHaveBeenCalledTimes(2);
  });

  it('dispatches a schedule event with the correct cron expression when the job fires', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const automation = makeAutomation('a', '0 8 * * *');
    const scheduler = new Scheduler([automation], dispatch, Promise.resolve());
    scheduler.start();

    cronCallbackFor()();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'schedule', cron: '0 8 * * *' });
  });

  it('dispatches to the correct expression when multiple jobs are registered', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], dispatch, Promise.resolve());
    scheduler.start();

    cronCallbackFor(1)(); // fire second job

    expect(dispatch).toHaveBeenCalledWith({ type: 'schedule', cron: '0 22 * * *' });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'schedule', cron: '0 8 * * *' });
  });

  it('does not register cron jobs for non-schedule triggers', () => {
    const automation: Automation<unknown> = {
      id: 'a',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'state_changed', entity: 'light.kitchen' }],
      context: () => ({}),
      reduce: () => ({ decision: 'ok', actions: [] }),
    };
    const scheduler = new Scheduler([automation], vi.fn(), Promise.resolve());
    scheduler.start();

    expect(mockCronSchedule).not.toHaveBeenCalled();
  });

  it('stop() calls stop on all registered cron tasks', () => {
    const mockStop = vi.fn();
    mockCronSchedule.mockReturnValue({ stop: mockStop });

    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], vi.fn(), Promise.resolve());
    scheduler.start();
    scheduler.stop();

    expect(mockStop).toHaveBeenCalledTimes(2);
  });

});

// ---------- on_start ----------

describe('Scheduler — on_start', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches on_start after the ready promise resolves', async () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const { ready, resolveReady } = makeReadyPromise();
    const scheduler = new Scheduler([], dispatch, ready);
    scheduler.start();

    expect(dispatch).not.toHaveBeenCalled();

    resolveReady();
    await vi.runAllTimersAsync();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'on_start' });
  });

  it('does not dispatch on_start before ready resolves', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const { ready } = makeReadyPromise();
    const scheduler = new Scheduler([], dispatch, ready);
    scheduler.start();

    vi.runAllTimers();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches on_start even when no automations have on_start triggers', async () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const { ready, resolveReady } = makeReadyPromise();
    const automation = makeAutomation('a', '0 8 * * *'); // schedule only
    const scheduler = new Scheduler([automation], dispatch, ready);
    scheduler.start();

    resolveReady();
    await vi.runAllTimersAsync();

    // Scheduler dispatches on_start unconditionally — TriggerEngine routes it
    // only to automations that declare an on_start trigger.
    expect(dispatch).toHaveBeenCalledWith({ type: 'on_start' });
  });
});
