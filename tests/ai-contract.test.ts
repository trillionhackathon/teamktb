import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseDecideResult, parseIntentResult, toAiRiderStatus, toAiStoreState } from '../app/ai/contract.ts';
import { moveReasonLabels } from '../app/domain/board.ts';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';
import { createAiClient } from '../app/server/aiserver.ts';
import { OrderStore } from '../app/server/order-store.ts';

const cafeDb = JSON.parse(readFileSync(new URL('../data/cafe_db.json', import.meta.url), 'utf8'));
const config = { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount };

describe('aiserver request mapping', () => {
  it('maps cafe_db channels and rider states to aiserver values', () => {
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'arrived' }), 'arrived');
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'dispatched' }), 'assigned');
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'not_dispatched' }), 'none');
    assert.equal(toAiRiderStatus({ channel: 'takeout' }), 'none');
  });

  it('sends the board in slot order with prep time and store signals', () => {
    const state = toAiStoreState([
      { order_id: '#108', channel: 'delivery', source: 'scenario', menu_items: [{ menu: 'strawberry_smoothie', qty: 2, size: 'R', options: [] }], received_at: '2026-11-19T05:00:00.000Z', status: 'waiting', rider_status: 'arrived', remaining_work_seconds: 199, price_krw: 13000 },
    ], {
      inventory: { coffee_beans_shots_left: 12, strawberry_servings_left: 8 },
      store: { equipment_status: { blender: 'broken' }, staff_count: 2 },
      delivery: { weather: '비' },
    }, { describe: () => '딸기 스무디 2잔', remainingSeconds: (order) => order.remaining_work_seconds });
    assert.deepEqual(state.orders[0], { id: '#108', items: '딸기 스무디 2잔', channel: 'delivery', created_at: '2026-11-19T05:00:00.000Z', prep_seconds: 199, rider_status: 'arrived', overtaken: 0, remake: false });
    assert.deepEqual(state.store, { 블렌더: '고장' });
    assert.deepEqual(state.inventory, { 원두: '약 12샷', 딸기: '8인분' });
    assert.deepEqual(state.external, { 날씨: '비' });
  });
});

describe('aiserver response parsing', () => {
  it('accepts the output_example in data/cafe_db.json', () => {
    const result = parseDecideResult(cafeDb.output_example);
    assert.ok(result);
    assert.equal(result.locked_count, cafeDb.kds_board.locked_count);
    for (const move of result.moves) assert.ok(moveReasonLabels[move.reason], `missing label for ${move.reason}`);
  });

  it('accepts the aiserver main README draft (feed, moves without confidence)', () => {
    const result = parseDecideResult({
      orders: ['#101', '#102', '#103', '#104', '#105', '#108', '#106', '#107', '#109', '#110'],
      locked_count: 5,
      moves: [{ order_id: '#108', from: 8, to: 6, reason: 'rider_waiting', source: 'rule' }],
      eta: { '#108': '2026-11-19T15:42:10+09:00' },
      customer: { '#108': { wait_minutes: 4, ahead: 5, reason: '배달 기사가 도착한 주문이 먼저 나가요' } },
      feed: [{ category: 'tip', text: '원두 재고 확인 필수', origin: 'inventory', confidence: 0.63, source: 'zoro' }],
      stock_policy: { strawberry: { policy: 'save', confidence: 0.74, source: 'zoro' } },
      fallback: false,
    });
    assert.ok(result);
    assert.equal(result.feed[0].text, '원두 재고 확인 필수');
  });

  it('rejects responses outside the contract', () => {
    assert.equal(parseDecideResult({ orders: '#101', locked_count: 5 }), undefined);
    assert.equal(parseDecideResult({ orders: ['#101'], locked_count: 5, moves: [{ order_id: '#101' }] }), undefined);
    assert.equal(parseDecideResult({ orders: ['#101'], locked_count: 5, tips: [{ id: 'x', text: 'y', confidence: 1, source: 'gpt' }] }), undefined);
    assert.equal(parseIntentResult({ intent: 'x', confidence: '1', source: 'rule' }), undefined);
  });
});

// AISERVER_URL이 있으면 실제 aiserver로 저장소를 돌린다. CI에서는 Zoro 없이 규칙 폴백(fallback: true)으로 응답한다.
describe('aiserver integration', { skip: !process.env.AISERVER_URL && 'AISERVER_URL not set' }, () => {
  const baseUrl = process.env.AISERVER_URL!;

  it('runs SC-B through the real aiserver: #108 moves to slot 6, slots 1-5 stay', async () => {
    const store = new OrderStore({ catalog: menuCatalog, config, ai: createAiClient(baseUrl, 3000), decideDelayMs: 0 });
    store.loadScenario('SC-B');
    await store.runTrigger('SC-B', 0);
    await store.settle();
    const snapshot = store.snapshot();
    assert.equal(snapshot.decision.ai_status, 'connected', snapshot.decision.ai_error);
    const board = snapshot.board.map(({ order_id: id }) => id);
    assert.deepEqual(board.slice(0, 6), ['#101', '#102', '#103', '#104', '#105', '#108']);
    assert.deepEqual([...board.slice(6)].sort(), ['#106', '#107', '#109', '#110'], 'aiserver rule orders the rest (short jobs first)');
  });

  it('accepts kiosk orders beyond 10 and returns a DecideResult that passes validation', async () => {
    const store = new OrderStore({ catalog: menuCatalog, config, ai: createAiClient(baseUrl, 3000), decideDelayMs: 0 });
    store.createOrder({ channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'iced_americano', qty: 3 }] });
    await store.settle();
    const snapshot = store.snapshot();
    assert.equal(snapshot.decision.ai_status, 'connected', snapshot.decision.ai_error);
    assert.equal(snapshot.board.length, 11);
  });

  it('rejects channels outside the aiserver contract', async () => {
    const response = await fetch(new URL('/ai/decide', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orders: [{ id: '#1', items: 'x', channel: 'takeout', created_at: '2026-11-19T05:00:00Z' }] }),
    });
    assert.equal(response.status, 422);
  });

  it('classifies operator input', async () => {
    const result = await createAiClient(baseUrl).classify('108번 라이더가 도착했어요');
    assert.ok(result.ok);
  });
});
