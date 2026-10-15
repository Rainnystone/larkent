import { describe, expect, it } from 'vitest';
import { renderCard } from '../../src/card/run-renderer';
import { renderText } from '../../src/card/text-renderer';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  markRunnerTimeout,
  reduce,
} from '../../src/card/run-state';

describe('run outcome card copy', () => {
  it('renders different copy for runner timeout and idle watchdog', () => {
    const idle = markIdleTimeout(initialState, 15);
    const runner = markRunnerTimeout(initialState);
    const idleCard = JSON.stringify(renderCard(idle));
    const runnerCard = JSON.stringify(renderCard(runner));

    expect(idleCard).toContain('15 分钟无响应');
    expect(idleCard).not.toContain('运行超时');
    expect(runnerCard).toContain('运行超时');
    expect(runnerCard).not.toContain('分钟无响应');
    expect(renderText(idle)).toContain('15 分钟无响应');
    expect(renderText(runner)).toContain('运行超时');
    expect(idleCard).not.toEqual(runnerCard);
  });

  it('keeps interrupted and completed card copy unchanged', () => {
    expect(JSON.stringify(renderCard(markInterrupted(initialState)))).toContain('已被中断');
    expect(JSON.stringify(renderCard(reduce(initialState, { type: 'done', terminationReason: 'normal' })))).toContain(
      '未返回内容',
    );
  });
});
