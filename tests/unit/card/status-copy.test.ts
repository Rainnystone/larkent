import { describe, expect, it } from 'vitest';
import {
  formatLarkCliStatus,
  formatLocalDateTime,
  formatStatusRuntimeAccess,
} from '../../../src/card/templates';

describe('status card user-facing copy', () => {
  it('hides CLI flags and uses Chinese permission wording', () => {
    expect(formatStatusRuntimeAccess({
      label: 'permission',
      value: 'force (cursor --force)',
    })).toEqual({ label: '权限', value: '自动批准' });
    expect(formatStatusRuntimeAccess({
      label: 'permission',
      value: 'bypassPermissions (grok --always-approve)',
    })).toEqual({ label: '权限', value: '自动批准' });
    expect(formatStatusRuntimeAccess({
      label: 'permission',
      value: 'always-proceed (agy --dangerously-skip-permissions)',
    })).toEqual({ label: '权限', value: '自动批准' });
    expect(formatStatusRuntimeAccess({
      label: 'permission',
      value: 'auto (kimi -p)',
    })).toEqual({ label: '权限', value: '自动批准' });
    expect(formatStatusRuntimeAccess({
      label: 'permission',
      value: 'plan',
    })).toEqual({ label: '权限', value: '计划模式' });
    expect(formatStatusRuntimeAccess({
      label: 'sandbox',
      value: 'danger-full-access/danger-full-access',
    })).toEqual({ label: '沙箱', value: 'danger-full-access/danger-full-access' });
  });

  it('maps lark-cli internals to Chinese', () => {
    expect(formatLarkCliStatus('app')).toBe('应用身份');
    expect(formatLarkCliStatus('user-ready')).toBe('用户身份已就绪');
    expect(formatLarkCliStatus('user-missing')).toBe('用户身份未配置');
    expect(formatLarkCliStatus('check-failed')).toBe('检查失败');
  });

  it('formats owner refresh time in local wall clock, not UTC ISO', () => {
    const stamp = Date.UTC(2023, 10, 14, 22, 13, 20);
    const text = formatLocalDateTime(stamp);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(text).not.toContain('T');
    expect(text).not.toContain('Z');
    expect(text).not.toBe('2023-11-14T22:13:20.000Z');
  });
});
