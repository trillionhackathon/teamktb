import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { parseDecideResult, parseIntentResult, parsePickResult, parseGroupResult, toAiRiderStatus, toAiStoreState, toPickRequest, type AiPickRequest } from '../app/ai/contract.ts';
import { moveReasonLabels } from '../app/domain/board.ts';
import { boardConfig, menuCatalog, ownerRules } from '../app/domain/catalog-data.ts';
import type { Fact } from '../app/domain/facts.ts';
import { createAiClient } from '../app/server/aiserver.ts';
import { OrderStore } from '../app/server/order-store.ts';

const cafeDb = JSON.parse(readFileSync(new URL('../data/cafe_db.json', import.meta.url), 'utf8'));
const config = { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount };

// docs/pick-next-implementation.md 11단계 예시(12:37:20, #103 완료 직후)
const pickRequest: AiPickRequest = {
  now: '2026-11-19T03:37:20.000Z',
  baristas: 1,
  owner_rules: ownerRules.sentences,
  locked: [
    { id: '#104', facts: '딸기 스무디 1잔 · 매장 · 재료 준비됨' },
    { id: '#106', facts: '아이스 아메리카노 2잔 · 배달 · 다 만듦 · 라이더 1분 10초 뒤' },
    { id: '#107', facts: '딸기 스무디 1잔 · 매장 · 재료 준비됨' },
  ],
  candidates: [
    { id: '#105', facts: '아이스 아메리카노 1잔 · 포장 · 2분 기다림' },
    { id: '#108', facts: '카페 라떼 2잔 · 포장 · 7분 20초 기다림 · 4번에 안 넣으면 11분 10초에 나가 기준 10분을 넘김 (4번이면 9분 30초)' },
    { id: '#109', facts: '아이스 아메리카노 2잔 · 배달 · 라이더 8분 40초 뒤 · 4번에 안 넣어도 라이더보다 먼저 나옴' },
    { id: '#110', facts: '카페 라떼 1잔 · 배달 · 라이더 3분 40초 뒤 · 4번에 안 넣으면 라이더보다 1분 30초 늦지만 기준 2분 안' },
  ],
  rule_pick: '#110',
  examples: [],
};

// 테스트용 aiserver. handler가 응답 본문을 정하고, delayMs만큼 늦게 답한다.
async function withServer(handler: (body: unknown) => { status?: number; body: unknown; delayMs?: number }, run: (baseUrl: string, received: unknown[]) => Promise<void>) {
  const received: unknown[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      const body = JSON.parse(text);
      received.push(body);
      const reply = handler(body);
      setTimeout(() => {
        response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('aiserver request mapping', () => {
  it('maps cafe_db channels and rider states to aiserver values', () => {
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'arrived' }), 'arrived');
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'dispatched' }), 'assigned');
    assert.equal(toAiRiderStatus({ channel: 'delivery', rider_status: 'not_dispatched' }), 'none');
    assert.equal(toAiRiderStatus({ channel: 'takeout' }), 'none');
  });

  it('sends the board in slot order with prep time, overtaken count, and store signals', () => {
    const state = toAiStoreState([
      { order_id: '#108', channel: 'delivery', source: 'scenario', menu_items: [{ menu: 'strawberry_smoothie', qty: 2, size: 'R', options: [] }], received_at: '2026-11-19T05:00:00.000Z', status: 'waiting', rider_status: 'arrived', remaining_work_seconds: 199, price_krw: 13000, overtaken: 2 },
    ], {
      inventory: { coffee_beans_shots_left: 12, strawberry_servings_left: 8 },
      store: { equipment_status: { blender: 'broken' }, staff_count: 2 },
      delivery: { weather: '비' },
    }, { describe: () => '딸기 스무디 2잔', remainingSeconds: (order) => order.remaining_work_seconds });
    assert.deepEqual(state.orders[0], { id: '#108', items: '딸기 스무디 2잔', channel: 'delivery', created_at: '2026-11-19T05:00:00.000Z', prep_seconds: 199, rider_status: 'arrived', overtaken: 2, remake: false });
    assert.deepEqual(state.store, { 블렌더: '고장' });
    assert.deepEqual(state.inventory, { 원두: '약 12샷', 딸기: '8인분' });
    assert.deepEqual(state.external, { 날씨: '비' });
  });

  it('builds the pick-next request from the fact lines, candidates in arrival order', () => {
    const facts = new Map<string, Fact>(pickRequest.candidates.map(({ id, facts: line }) => [id, { line, receivedAt: 0, slackSec: 0 }]));
    const request = toPickRequest({
      now: Date.parse(pickRequest.now), baristas: 0, ownerRules: ownerRules.sentences, locked: pickRequest.locked,
      candidates: pickRequest.candidates.map(({ id }) => id), facts, rulePick: '#110',
    });
    assert.deepEqual(request, { ...pickRequest, baristas: 1 });
  });
});

describe('aiserver response parsing', () => {
  it('accepts the output_example in data/cafe_db.json (/ai/decide, tips only)', () => {
    const result = parseDecideResult(cafeDb.output_example);
    assert.ok(result);
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

  it('parses PickResult and rejects malformed ones', () => {
    const valid = { pick: '#108', source: 'zoro', confidence: 0.78, scores: { '#108': 0.78, '#110': 0.17, '#109': 0.03, '#105': 0.02 }, fallback: false };
    assert.deepEqual(parsePickResult(valid), valid);
    assert.deepEqual(parsePickResult({ pick: '#110', source: 'rule', confidence: 1, scores: {}, fallback: true }), { pick: '#110', source: 'rule', confidence: 1, scores: {}, fallback: true });
    assert.equal(parsePickResult({ ...valid, pick: 108 }), undefined);
    assert.equal(parsePickResult({ ...valid, source: 'gpt' }), undefined);
    assert.equal(parsePickResult({ ...valid, confidence: '0.78' }), undefined);
    assert.equal(parsePickResult({ ...valid, scores: { '#108': 'high' } }), undefined);
    assert.equal(parsePickResult({ ...valid, fallback: 'no' }), undefined);
  });
});

describe('aiserver client: POST /ai/pick-next', () => {
  it('sends the request and returns a valid answer', async () => {
    const answer = { pick: '#108', source: 'zoro', confidence: 0.78, scores: { '#108': 0.78, '#110': 0.17 }, fallback: false };
    await withServer(() => ({ body: answer }), async (baseUrl, received) => {
      const result = await createAiClient(baseUrl).pickNext(pickRequest);
      assert.deepEqual(result, { ok: true, data: answer });
      assert.deepEqual(received, [pickRequest]);
    });
  });

  it('reports a response outside the contract as an error', async () => {
    await withServer(() => ({ body: { pick: '#108' } }), async (baseUrl) => {
      const result = await createAiClient(baseUrl).pickNext(pickRequest);
      assert.deepEqual(result, { ok: false, error: 'AI 서버 응답이 계약 형식과 달라요.' });
    });
  });

  it('gives up after the timeout so the rule pick stays in slot 4', async () => {
    await withServer(() => ({ body: { pick: '#108', source: 'zoro', confidence: 0.9, scores: {}, fallback: false }, delayMs: 300 }), async (baseUrl) => {
      const result = await createAiClient(baseUrl, 50).pickNext(pickRequest);
      assert.deepEqual(result, { ok: false, error: 'AI 서버가 50ms 안에 응답하지 않았어요.' });
    });
  });
});

// AISERVER_URL이 있으면 실제 aiserver로 저장소를 돌린다. CI에서는 Zoro 없이 규칙 폴백(fallback: true)으로 응답한다.
describe('aiserver integration', { skip: !process.env.AISERVER_URL && 'AISERVER_URL not set' }, () => {
  const baseUrl = process.env.AISERVER_URL!;

  it('runs SC-B through the real aiserver: #108 goes to slot 4 at the next completion', async () => {
    const store = new OrderStore({ catalog: menuCatalog, config, ai: createAiClient(baseUrl, 6000), decideDelayMs: 0 });
    store.loadScenario('SC-B');
    await store.runTrigger('SC-B', 0);
    await store.settle();
    assert.equal(store.snapshot().decision.ai_status, 'connected', store.snapshot().decision.ai_error);
    store.updateOrderStatus('#101', 'complete');
    await store.settle();
    const snapshot = store.snapshot();
    const board = snapshot.board.map(({ order_id: id }) => id);
    assert.deepEqual(board.slice(0, 3), ['#102', '#103', '#104']);
    assert.ok(['#105', '#106', '#107', '#108'].includes(board[3]));
    assert.equal(snapshot.slot4?.status, 'final');
    assert.equal(snapshot.slot4?.rule_pick, '#108');
  });

  it('accepts kiosk orders beyond 8 and returns a DecideResult that passes validation', async () => {
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

  it('answers pick-next with a candidate, the rule pick when Zoro is down', async () => {
    const result = await createAiClient(baseUrl, 6000).pickNext(pickRequest);
    assert.ok(result.ok, result.ok ? '' : result.error);
    assert.ok(pickRequest.candidates.some(({ id }) => id === result.data.pick));
    if (result.data.fallback) assert.deepEqual([result.data.pick, result.data.source], ['#110', 'rule']);
    const bad = await fetch(new URL('/ai/pick-next', baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...pickRequest, rule_pick: '#999' }),
    });
    assert.equal(bad.status, 422);
  });
});

describe('group contract', () => {
  it('accepts the aiserver GroupResult and rejects malformed values', () => {
    assert.deepEqual(parseGroupResult({ groups: { '#101': 1 }, fallback: false }), { groups: { '#101': 1 }, scores: {}, fallback: false });
    assert.deepEqual(parseGroupResult({}), { groups: {}, scores: {}, fallback: false });
    assert.deepEqual(parseGroupResult({ groups: { '#101': 1, '#103': 1 }, scores: { '#102': 0.12, '#103': 0.91 } }), { groups: { '#101': 1, '#103': 1 }, scores: { '#102': 0.12, '#103': 0.91 }, fallback: false });
    assert.equal(parseGroupResult({ groups: { '#101': 'a' } }), undefined);
    assert.equal(parseGroupResult({ groups: {}, fallback: 'no' }), undefined);
    assert.equal(parseGroupResult({ groups: {}, scores: { '#102': 1.4 } }), undefined, 'scores are probabilities');
  });
});
