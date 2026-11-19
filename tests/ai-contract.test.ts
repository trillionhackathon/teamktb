import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  fromAiOrderId, isStoreState, moveReasonLabels, parseDecideResult, parseDurationSeconds, parseIntentResult, toStoreState,
} from '../app/ai/contract.ts';
import { appendDemoOrder, initialOrders, initialTime, type Order } from '../app/demo-data.ts';

const now = new Date('2026-11-19T05:32:00.000Z');
const cafeDb = JSON.parse(readFileSync(new URL('../data/cafe_db.json', import.meta.url), 'utf8'));

function demoQueue(size: number): Order[] {
  let orders = initialOrders;
  while (orders.length < size) orders = appendDemoOrder(orders);
  return orders;
}

describe('toStoreState', () => {
  it('maps dashboard orders to the aiserver StoreState schema', () => {
    const state = toStoreState(initialOrders, { clock: initialTime, now, riderArrivedIds: [105] });
    assert.ok(isStoreState(state));
    assert.deepEqual(state.orders.map(({ id }) => id), ['#104', '#105', '#106', '#107']);
    assert.deepEqual(state.orders.map(({ channel }) => channel), ['store', 'delivery', 'store', 'store']);
    assert.equal(state.orders[1].rider_status, 'arrived');
    assert.equal(state.orders[0].rider_status, 'none');
    assert.equal(state.orders[0].prep_seconds, 150);
    assert.equal(state.orders[0].created_at, '2026-11-19T05:24:00.000Z');
    assert.match(state.orders[0].items, /따뜻한 카페라테 1잔, 카페라테 1잔\(미지근하게\)/);
  });

  it('sends orders oldest first regardless of dashboard ranking', () => {
    const shuffled = [...initialOrders].reverse();
    const state = toStoreState(shuffled, { clock: initialTime, now });
    assert.deepEqual(state.orders.map(({ id }) => id), ['#104', '#105', '#106', '#107']);
  });
});

describe('parseDurationSeconds', () => {
  it('reads the Korean duration labels used on tickets', () => {
    assert.equal(parseDurationSeconds('2분 30초'), 150);
    assert.equal(parseDurationSeconds('5분'), 300);
    assert.equal(parseDurationSeconds('45초'), 45);
  });
});

describe('parseDecideResult', () => {
  it('accepts the output_example in data/cafe_db.json', () => {
    const result = parseDecideResult(cafeDb.output_example);
    assert.ok(result);
    assert.equal(result.locked_count, 5);
    assert.equal(result.moves[0].order_id, '#108');
    for (const move of result.moves) assert.ok(moveReasonLabels[move.reason], `missing label for ${move.reason}`);
  });

  it('rejects responses outside the contract', () => {
    assert.equal(parseDecideResult({ orders: '#101', locked_count: 5 }), undefined);
    assert.equal(parseDecideResult({ orders: ['#101'], locked_count: 5, moves: [{ order_id: '#101' }] }), undefined);
    assert.equal(parseDecideResult({ orders: ['#101'], locked_count: 5, tips: [{ id: 'x', text: 'y', confidence: 1, source: 'gpt' }] }), undefined);
  });

  it('reads order ids in the #NNN format only', () => {
    assert.equal(fromAiOrderId('#108'), 108);
    assert.equal(fromAiOrderId('108'), undefined);
  });
});

describe('parseIntentResult', () => {
  it('accepts the aiserver IntentResult shape', () => {
    assert.deepEqual(parseIntentResult({ intent: 'needs_review', confidence: 0, source: 'rule' }), { intent: 'needs_review', confidence: 0, source: 'rule' });
    assert.equal(parseIntentResult({ intent: 'x', confidence: '1', source: 'rule' }), undefined);
  });
});

// AISERVER_URL이 있으면 실제 aiserver에 요청해 계약을 확인한다. CI에서는 Zoro 없이 규칙 폴백으로 실행된다.
describe('aiserver integration', { skip: !process.env.AISERVER_URL && 'AISERVER_URL not set' }, () => {
  const baseUrl = process.env.AISERVER_URL!;

  it('returns a DecideResult for the dashboard queue and moves an arrived rider ahead in slots 6-10', async () => {
    const queue = demoQueue(9);
    const rider = queue.slice(5).find(({ channel }) => channel === '배달');
    assert.ok(rider, 'demo queue needs a delivery order in slots 6-10');
    const state = toStoreState(queue, { clock: initialTime + queue.length - initialOrders.length, now: new Date(), riderArrivedIds: [rider.id] });

    const response = await fetch(new URL('/ai/decide', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = parseDecideResult(await response.json());
    assert.ok(result, 'response must match the DecideResult contract');

    const sent = state.orders.map(({ id }) => id);
    assert.deepEqual(result.orders.slice(0, result.locked_count), sent.slice(0, result.locked_count), 'slots 1-5 stay FIFO');
    assert.deepEqual([...result.orders].sort(), [...sent].sort(), 'no orders added or dropped');
    assert.equal(result.orders[result.locked_count], `#${rider.id}`, 'arrived rider goes to slot 6');
    assert.ok(result.moves.every(({ reason }) => moveReasonLabels[reason]), 'every move reason has a dashboard label');
  });

  it('rejects channels outside the contract', async () => {
    const state = toStoreState(initialOrders, { clock: initialTime, now: new Date() });
    const invalid = { ...state, orders: [{ ...state.orders[0], channel: 'takeout' }] };
    const response = await fetch(new URL('/ai/decide', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalid) });
    assert.equal(response.status, 422);
  });

  it('classifies operator input', async () => {
    const response = await fetch(new URL('/ai/operator-input', baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '105번 라이더가 도착했어요' }) });
    assert.equal(response.status, 200);
    assert.ok(parseIntentResult(await response.json()));
  });
});
