import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentAlerts, applyAiRanking, buildPlan, emptyQuestState, preparedKey, rankCandidates, reconcile, withObjectParticle, MAX_OVERTAKES, type AiQuestHint } from '../app/client/quest-board.ts';
import { demoOrder } from '../app/server/demo-feed.ts';
import type { OrderItemView, OrderView } from '../app/domain/views.ts';
import type { StoreEvent } from '../app/domain/types.ts';

const americano = (qty: number): OrderItemView => ({ name: '아이스 아메리카노', qty, options: [] });
const vanilla = (qty: number): OrderItemView => ({ name: '바닐라 라떼', qty, options: [] });
const smoothie = (qty: number): OrderItemView => ({ name: '딸기 스무디', qty, options: [] });

function order(number: number, items: OrderItemView[], patch: Partial<OrderView> = {}): OrderView {
  return {
    order_id: `#${number}`, channel: 'dine-in', channel_label: '매장', source: 'kiosk', source_label: '키오스크', status: 'waiting', items,
    received_at: new Date(Date.UTC(2026, 10, 19, 5, 0, number)).toISOString(), remaining_work_seconds: 200, price_krw: 4500, ...patch,
  };
}

it('shows inventory and store incidents even when newer delivery events fill the event feed', () => {
  const spill: StoreEvent = {
    event_id: 'spill', category: 'spill_cleanup', raw_text: '바닥에 커피를 쏟았어요',
    summary: '바닥 청소 필요', needs_confirmation: false, received_at: '2026-11-19T05:00:00Z',
  };
  const events = [1, 2, 3].map((number): StoreEvent => ({
    ...spill, event_id: `rider-${number}`, category: 'rider_arrived', order_id: `#${number}`,
  }));
  const alerts = agentAlerts({
    signals: {
      inventory: { coffee_beans_shots_left: 8, strawberry_servings_left: 20 },
      store: { equipment_status: { blender: 'broken' }, staff_count: 2 },
      delivery: { weather: 'clear' },
    },
    events: [...events, spill],
  });
  assert.deepEqual(alerts.map(({ id }) => id), ['equipment-blender', 'beans', 'event-spill']);
});

describe('quest board (mock Zoro)', () => {
  it('batches the same menu across fixed orders, then the head-only menu, then completion', () => {
    const fixed = [order(1, [americano(3), vanilla(1)]), order(2, [smoothie(1)]), order(3, [vanilla(2)]), order(4, [americano(4)])];
    const plan = buildPlan(fixed, {})!;
    assert.deepEqual(plan.lines.map((line) => line.kind === 'make' ? `${line.label} ${line.qty}` : `complete ${line.order_id}`), [
      '아이스 아메리카노 7', '바닐라 라떼 3', 'complete #1',
    ]);
  });

  it('marks batched partner items as prepared when the head completes', () => {
    const board = [order(1, [americano(3), vanilla(1)], { status: 'in_progress' }), order(2, [smoothie(1)]), order(3, [smoothie(1)]), order(4, [americano(4)])];
    const started = reconcile(emptyQuestState, board);
    // 처음 채운 4칸은 접수순으로 놓인다.
    assert.deepEqual(started.fixed, ['#1', '#2', '#3', '#4']);
    assert.equal(started.plan?.frozen, true);

    const afterHead = reconcile(started, board.slice(1));
    assert.deepEqual(afterHead.prepared['#4'], { '아이스 아메리카노': 4 });
    // 같은 보드로 다시 맞춰도 미리 만든 잔 수가 두 번 더해지지 않는다.
    assert.deepEqual(reconcile(afterHead, board.slice(1)).prepared, afterHead.prepared);

    const fourAsHead = reconcile(afterHead, [board[3]]);
    assert.equal(fourAsHead.plan?.head, '#4');
    assert.deepEqual(fourAsHead.plan?.lines, [{ kind: 'complete', order_id: '#4', preparedQty: 4 }]);
  });

  it('keeps the quest while the head is pending, but rebuilds it when a batched order leaves first', () => {
    const board = [order(1, [americano(3)]), order(2, [americano(2)]), order(3, [smoothie(1)]), order(4, [smoothie(1)])];
    const state = reconcile(emptyQuestState, board);
    assert.equal(state.plan?.frozen, true);
    const withNewOrder = reconcile(state, [...board, order(5, [americano(5)])]);
    assert.equal(withNewOrder.plan, state.plan);
    const partnerDone = reconcile(state, [board[0], board[2], board[3]]);
    assert.deepEqual(partnerDone.plan?.lines[0], { kind: 'make', key: '아이스 아메리카노', label: '아이스 아메리카노', qty: 3, parts: [{ order_id: '#1', qty: 3 }] });
  });

  it('promotes the candidate that shares menus with fixed orders, but never skips an order more than the limit', () => {
    const fixed = [order(1, [americano(2)])];
    const candidates = [order(5, [smoothie(1)]), order(6, [americano(1)])];
    assert.equal(rankCandidates(candidates, fixed, {}, {})[0].order.order_id, '#6');
    assert.equal(rankCandidates(candidates, fixed, {}, { '#5': MAX_OVERTAKES })[0].order.order_id, '#5');
  });

  it('fills the four fixed slots and counts overtakes for skipped older orders', () => {
    const board = [order(1, [americano(1)]), order(2, [vanilla(1)]), order(3, [vanilla(1)]), order(4, [smoothie(1)]), order(5, [vanilla(1)]), order(6, [americano(1)])];
    const state = reconcile({ ...emptyQuestState, fixed: ['#1', '#2', '#3'] }, board);
    assert.deepEqual(state.fixed, ['#1', '#2', '#3', '#5']);
    assert.equal(state.overtakes['#4'], 1);
  });

  it('picks the right Korean object particle', () => {
    assert.equal(withObjectParticle('바닐라 라떼'), '바닐라 라떼를');
    assert.equal(withObjectParticle('딸기 스무디(샷 추가)'), '딸기 스무디를');
    assert.equal(withObjectParticle('아이스 아메리카노'), '아이스 아메리카노를');
    assert.equal(withObjectParticle('콜드브루'), '콜드브루를');
    assert.equal(withObjectParticle('녹차 라떼 샷'), '녹차 라떼 샷을');
  });

  it('builds valid demo orders that the order store accepts', async () => {
    const { OrderStore } = await import('../app/server/order-store.ts');
    const { boardConfig, menuCatalog } = await import('../app/domain/catalog-data.ts');
    const store = new OrderStore({ catalog: menuCatalog, config: boardConfig });
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let index = 0; index < 30; index += 1) {
      const result = store.createOrder({ ...demoOrder(random), source: 'demo', request_id: `test-${index}` });
      assert.ok(!('error' in result), 'error' in result ? result.error : '');
    }
  });

  it('uses the aiserver ranking and plan only when they match the current board', () => {
    const board = [order(1, [americano(1)]), order(2, [vanilla(1)]), order(3, [vanilla(1)]), order(4, [vanilla(1)]), order(5, [smoothie(1)]), order(6, [americano(1)])];
    const base = reconcile(emptyQuestState, board);
    const ai: AiQuestHint = {
      fixed: base.fixed, candidates: ['#5', '#6'], preparedKey: preparedKey({}, base.fixed),
      ranking: [{ order_id: '#5', reason: 'Zoro가 골랐어요', source: 'zoro' }, { order_id: '#6', reason: '먼저 접수된 주문이에요', source: 'rule' }],
      plan: { head: '#1', source: 'rule', lines: [{ kind: 'complete', order_id: '#1', preparedQty: 0 }] },
    };
    const local = rankCandidates([board[4], board[5]], board.slice(0, 4), {}, {});
    assert.equal(local[0].order.order_id, '#6');
    const ranked = applyAiRanking(local, ai, base.fixed);
    assert.deepEqual(ranked.map(({ order, source }) => [order.order_id, source]), [['#5', 'zoro'], ['#6', 'rule']]);
    // 후보가 달라졌으면 aiserver 순위를 버린다.
    assert.equal(applyAiRanking(local, { ...ai, candidates: ['#5', '#7'] }, base.fixed), local);

    const withAi = reconcile(base, board, ai);
    assert.equal(withAi.plan?.source, 'rule');
    // 1번이 끝나 빈 칸이 생기면 aiserver가 고른 #5가 올라간다.
    const promoted = reconcile(withAi, board.slice(1), ai);
    assert.deepEqual(promoted.fixed, ['#2', '#3', '#4', '#5']);
    assert.equal(promoted.plan?.source, 'local');
  });
});
