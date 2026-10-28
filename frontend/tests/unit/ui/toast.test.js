import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pausableTimer, TOAST_MS } from '../../../src/ui/toast.js';

describe('pausable toast timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the duration (3 s by default for toasts)', () => {
    expect(TOAST_MS).toBe(3000);
    const onDone = vi.fn();
    pausableTimer({ ms: TOAST_MS, onDone });
    vi.advanceTimersByTime(2999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('pauses while hovered and keeps only the time that was left', () => {
    const onDone = vi.fn();
    const timer = pausableTimer({ ms: 3000, onDone });
    vi.advanceTimersByTime(1000);
    timer.pause();
    vi.advanceTimersByTime(60_000); // hovered for a minute
    expect(onDone).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(1999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ignores repeated pause/resume, and cancel stops it for good', () => {
    const onDone = vi.fn();
    const timer = pausableTimer({ ms: 3000, onDone });
    timer.resume(); // already running: no second timeout
    timer.pause();
    timer.pause();
    timer.resume();
    timer.resume();
    vi.advanceTimersByTime(3000);
    expect(onDone).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const other = pausableTimer({ ms: 3000, onDone: cancelled });
    other.cancel();
    other.resume();
    vi.advanceTimersByTime(10_000);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
