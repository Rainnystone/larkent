import { describe, expect, it } from 'vitest';
import { commandClearsPending } from '../../../src/commands';

describe('commandClearsPending', () => {
  it('clears only semantic cancel commands', () => {
    expect(commandClearsPending('/stop')).toBe(true);
    expect(commandClearsPending('/new')).toBe(true);
    expect(commandClearsPending('/reset')).toBe(true);
    expect(commandClearsPending('/cd /tmp/work')).toBe(true);
    expect(commandClearsPending('/ws use prod')).toBe(true);
    expect(commandClearsPending('/resume use abc')).toBe(true);
    expect(commandClearsPending('/resume')).toBe(false);
    expect(commandClearsPending('/exit')).toBe(true);
  });

  it('leaves read-only and inspect commands queued', () => {
    expect(commandClearsPending('/status')).toBe(false);
    expect(commandClearsPending('/doctor')).toBe(false);
    expect(commandClearsPending('/ps')).toBe(false);
    expect(commandClearsPending('/help')).toBe(false);
    expect(commandClearsPending('/resume')).toBe(false);
    expect(commandClearsPending('/ws list')).toBe(false);
    expect(commandClearsPending('/ws save prod')).toBe(false);
    expect(commandClearsPending('/reconnect')).toBe(false);
  });
});
