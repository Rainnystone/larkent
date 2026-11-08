import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { STDOUT_CAPTURE_ENV } from '../../../src/agent/runner/stdout-capture';
import {
  testBridgeStdoutCaptureDir,
  testBridgeStdoutCaptureEnv,
} from '../../../e2e/test-bridge/driver';

describe('test-bridge --stdout-capture', () => {
  it('is off unless the flag is set and never points at the live root', () => {
    const dataRoot = '/tmp/lark-channel-e2e/t1';
    expect(testBridgeStdoutCaptureEnv({ stdoutCapture: false, dataRoot })).toEqual({});
    expect(testBridgeStdoutCaptureEnv({ stdoutCapture: true, dataRoot })).toEqual({
      [STDOUT_CAPTURE_ENV]: join(dataRoot, 'stdout-captures'),
    });
    expect(testBridgeStdoutCaptureDir(dataRoot)).toBe(join(dataRoot, 'stdout-captures'));
    expect(testBridgeStdoutCaptureDir(dataRoot)).not.toContain('.lark-channel/');
  });
});
