import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function cronCallbackFor(callIndex = 0): () => void {
  return (mockCronSchedule.mock.calls[callIndex] as [string, () => void])[1];
}

// ---------- Tests ----------

describe('Scheduler', () => {
  beforeEach(() => mockCronSchedule.mockClear());

  it('registers a cron job for each schedule trigger on start()', () => {
    const automation = makeAutomation('a', '0 8 * * *');
    const scheduler = new Scheduler([automation], vi.fn());
    scheduler.start();

    expect(mockCronSchedule).toHaveBeenCalledOnce();
    expect(mockCronSchedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
  });

  it('registers separate cron jobs for different expressions', () => {
    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], vi.fn());
    scheduler.start();

    expect(mockCronSchedule).toHaveBeenCalledTimes(2);
  });

  it('dispatches a schedule event with the correct cron expression when the job fires', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const automation = makeAutomation('a', '0 8 * * *');
    const scheduler = new Scheduler([automation], dispatch);
    scheduler.start();

    cronCallbackFor()();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'schedule', cron: '0 8 * * *' });
  });

  it('dispatches to the correct expression when multiple jobs are registered', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], dispatch);
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
    const scheduler = new Scheduler([automation], vi.fn());
    scheduler.start();

    expect(mockCronSchedule).not.toHaveBeenCalled();
  });

  it('stop() calls stop on all registered cron tasks', () => {
    const mockStop = vi.fn();
    mockCronSchedule.mockReturnValue({ stop: mockStop });

    const a1 = makeAutomation('a1', '0 8 * * *');
    const a2 = makeAutomation('a2', '0 22 * * *');
    const scheduler = new Scheduler([a1, a2], vi.fn());
    scheduler.start();
    scheduler.stop();

    expect(mockStop).toHaveBeenCalledTimes(2);
  });

});
