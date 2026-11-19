import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiPickRequest, AiPickResult, AiStoreState, DecideResult } from '../app/ai/contract.ts';
import { boardConfig, menuCatalog, ownerRules } from '../app/domain/catalog-data.ts';
import type { AiClient, AiResult } from '../app/server/aiserver.ts';
import { demoOrder } from '../app/server/demo-feed.ts';
import { OrderStore } from '../app/server/order-store.ts';

const config = { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount };
const boardIds = (store: OrderStore) => store.snapshot().board.map(({ order_id: id }) => id);
const steps = (store: OrderStore) => store.snapshot().work_window.map(({ kind, text }) => `${kind}: ${text}`);
const find = (store: OrderStore, id: string) => store.snapshot().board.find(({ order_id: orderId }) => orderId === id)!;
const overtaken = (store: OrderStore) => Object.fromEntries(store.snapshot().board.map(({ order_id: id, overtaken: count }) => [id, count]));

function storeWithoutAi() {
  return new OrderStore({ catalog: menuCatalog, config });
}

describe('OrderStore board (8 slots, 1-4 locked, rule only)', () => {
  it('starts with the shared board, shows 4 locked + 4 waiting slots, and appends new orders at the end (SC-01)', () => {
    const store = storeWithoutAi();
    assert.deepEqual(config, { lockedCount: 4, visibleCount: 8 });
    assert.deepEqual(boardIds(store), ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    assert.deepEqual(store.snapshot().board.map(({ zone }) => zone), ['locked', 'locked', 'locked', 'locked', 'flexible', 'flexible', 'flexible', 'flexible', 'queue', 'queue']);
    const result = store.createOrder({ request_id: 'k-1', channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'iced_americano', qty: 3 }] });
    assert.ok('order' in result);
    assert.equal(result.order.order_id, '#111');
    assert.equal(result.order.remaining_work_seconds, 153);
    const snapshot = store.snapshot();
    const queued = snapshot.board.at(-1)!;
    assert.equal(queued.order_id, '#111');
    assert.equal(queued.zone, 'queue');
    assert.equal(queued.eta_seconds, result.wait_seconds);
    assert.equal(snapshot.decision.ai_status, 'disabled');
  });

  it('returns the same order for a retried request_id', () => {
    const store = storeWithoutAi();
    const first = store.createOrder({ request_id: 'k-2', channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    const retry = store.createOrder({ request_id: 'k-2', channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    assert.ok('order' in first && 'order' in retry);
    assert.equal(retry.order.order_id, first.order.order_id);
    assert.equal(retry.duplicate, true);
    assert.equal(store.snapshot().board.length, 11);
  });

  it('validates input at the boundary', () => {
    const store = storeWithoutAi();
    const bad = store.createOrder({ channel: 'pickup' as never, source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    assert.ok('error' in bad && bad.status === 400);
    const unknown = store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'bubble_tea', qty: 1 }] });
    assert.ok('error' in unknown && unknown.status === 400);
  });

  it('pulls 2-4 up when 1 completes and puts the rule pick from old 5-8 in slot 4, keeping the rest in arrival order', () => {
    const store = storeWithoutAi();
    store.updateOrderStatus('#101', 'complete');
    const snapshot = store.snapshot();
    assert.deepEqual(boardIds(store), ['#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    assert.equal(snapshot.slot4?.order_id, '#105');
    assert.equal(snapshot.slot4?.source, 'rule');
    assert.equal(snapshot.slot4?.status, 'final');
    assert.deepEqual(Object.keys(snapshot.slot4?.facts ?? {}), ['#105', '#106', '#107', '#108']);
    assert.equal(snapshot.counts.done, 1);
  });

  it('does not reorder on events: a rider arrival waits for the next completion, then rule ② puts the late delivery in slot 4 (SC-B)', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-B');
    assert.equal(await store.runTrigger('SC-B', 0), undefined);
    assert.deepEqual(boardIds(store), ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    assert.ok(find(store, '#108').rider_eta_at, 'rider arrival is stored as a time');

    store.updateOrderStatus('#101', 'complete');
    assert.deepEqual(boardIds(store), ['#102', '#103', '#104', '#108', '#105', '#106', '#107', '#109', '#110']);
    assert.equal(store.snapshot().slot4?.rule_pick, '#108');
    assert.match(store.snapshot().slot4!.facts['#108'], /라이더 도착함/);
    // 밀린 횟수: #108보다 먼저 접수된 후보만 +1
    assert.deepEqual(overtaken(store), { '#102': 0, '#103': 0, '#104': 0, '#108': 0, '#105': 1, '#106': 1, '#107': 1, '#109': 0, '#110': 0 });
  });

  it('refills slot 4 when a locked order other than 1 completes first, but not when a waiting order completes', () => {
    const store = storeWithoutAi();
    store.updateOrderStatus('#103', 'complete');
    assert.deepEqual(boardIds(store), ['#101', '#102', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    assert.equal(store.snapshot().slot4?.order_id, '#105');
    assert.equal(steps(store).at(-1), 'done: 주문 #101 완료');

    const other = storeWithoutAi();
    other.updateOrderStatus('#106', 'complete');
    assert.deepEqual(boardIds(other), ['#101', '#102', '#103', '#104', '#105', '#107', '#108', '#109', '#110']);
    assert.equal(other.snapshot().slot4, undefined);
  });

  it('skips blocked orders as slot 4 candidates (SC-05)', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-05');
    await store.runTrigger('SC-05', 0);
    store.applySignal({ rider_status: { '#108': 'arrived' } });
    store.updateOrderStatus('#101', 'complete');
    assert.equal(store.snapshot().slot4?.order_id, '#105');
    assert.ok(!Object.keys(store.snapshot().slot4!.facts).includes('#108'));
  });
});

describe('OrderStore work window', () => {
  it('writes what to do until 1 completes, then marks made and prepped orders on completion', () => {
    const store = storeWithoutAi();
    assert.deepEqual(steps(store), [
      'make: 카페 라떼 3잔 만들기 → #101 1잔 · #104 2잔',
      'make: 아이스 아메리카노 2잔 만들기 → #102 2잔',
      'prep: 딸기 스무디 1잔 재료만 준비 → #103 1잔',
      'pack: #101 내기',
      'done: 주문 #101 완료',
    ]);

    store.updateOrderStatus('#101', 'complete');
    assert.equal(find(store, '#102').made, true);
    assert.equal(find(store, '#104').made, true);
    assert.equal(find(store, '#103').prepped, true);
    assert.equal(find(store, '#103').made, false);
    assert.deepEqual(steps(store), [
      'prep: 샷 추출 시작 (2샷, 자동으로 멈춤) · 그동안 아래 포장',
      'pack: #102 포장',
      'make: 딸기 스무디 1잔 갈기 → #103 1잔',
      'make: 아이스 아메리카노 1잔 만들기 → #105 1잔',
      'done: 주문 #102 완료',
    ]);
  });

  it('rewrites the window for events that touch slots 1-4 and only changes the card for slots 5-8', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-05');
    await store.runTrigger('SC-05', 0);
    assert.ok(steps(store).includes('prep: #103 보류 · 블렌더 고장으로 보류'));

    const sca = storeWithoutAi();
    sca.loadScenario('SC-A');
    const before = steps(sca);
    await sca.runTrigger('SC-A', 0);
    await sca.runTrigger('SC-A', 1);
    assert.deepEqual(steps(sca), before, '#108 is in slot 8, so the window stays');
    const order108 = find(sca, '#108');
    assert.equal(order108.pickup_eta_seconds, 300);
    assert.ok(Math.abs(Date.parse(order108.rider_eta_at!) - Date.now() - 300_000) < 5_000, 'rider ETA is stored as now + 300s');
  });
});

describe('OrderStore events and stock', () => {
  it('records the SC-A delivery message flow without inventing a number', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-A');
    await store.runTrigger('SC-A', 0);
    let order = find(store, '#108');
    assert.equal(order.needs_confirmation, true);
    assert.equal(order.pickup_eta_seconds, null);
    assert.equal(order.rider_eta_at, undefined);
    await store.runTrigger('SC-A', 0);
    assert.equal(store.snapshot().events.length, 1, 'INV-03: same event id is processed once');
    await store.runTrigger('SC-A', 1);
    order = find(store, '#108');
    assert.equal(order.pickup_eta_seconds, 300);
    assert.equal(order.eta_confirmed, true);
    assert.equal(order.needs_confirmation, false);
  });

  it('holds blender orders, blocks new smoothies, and restores them on recovery (SC-05)', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-05');
    await store.runTrigger('SC-05', 0);
    let snapshot = store.snapshot();
    assert.ok(snapshot.board.find(({ order_id: id }) => id === '#108')?.blocked_reason);
    assert.ok(snapshot.tips.some(({ id }) => id === 'blender'));
    assert.equal(snapshot.availability.strawberry_smoothie, '블렌더 점검 중');
    const rejected = store.createOrder({ channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'strawberry_smoothie', qty: 1 }] });
    assert.ok('error' in rejected && rejected.status === 409);
    await store.runTrigger('SC-05', 1);
    snapshot = store.snapshot();
    assert.equal(snapshot.board.find(({ order_id: id }) => id === '#108')?.blocked_reason, undefined);
    assert.ok(!snapshot.tips.some(({ id }) => id === 'blender'));
  });

  it('decrements inventory and rejects orders beyond stock (SC-D)', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-D');
    await store.runTrigger('SC-D', 0);
    assert.equal(store.snapshot().signals.inventory.strawberry_servings_left, 8);
    const ok = store.createOrder({ channel: 'delivery', source: 'delivery_app', menu_items: [{ menu: 'strawberry_smoothie', qty: 8 }] });
    assert.ok('order' in ok);
    assert.equal(store.snapshot().signals.inventory.strawberry_servings_left, 0);
    assert.equal(store.snapshot().availability.strawberry_smoothie, '딸기 재고 소진');
  });

  it('pushes a snapshot to subscribers on every change', () => {
    const store = storeWithoutAi();
    const versions: number[] = [];
    const unsubscribe = store.subscribe((snapshot) => versions.push(snapshot.state_version));
    store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    store.addEvent({ event_id: 'e-1', raw_text: '손님이 통행로에 커피를 쏟았어요' });
    unsubscribe();
    assert.equal(versions.length, 2);
    assert.ok(versions[1] > versions[0]);
  });

  it('accepts the demo feed orders', () => {
    const store = new OrderStore({ catalog: menuCatalog, config });
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let index = 0; index < 30; index += 1) {
      const result = store.createOrder({ ...demoOrder(random), source: 'demo', request_id: `test-${index}` });
      assert.ok(!('error' in result), 'error' in result ? result.error : '');
    }
  });
});

describe('OrderStore with aiserver', () => {
  type Handlers = {
    decide?: (state: AiStoreState) => Promise<DecideResult | undefined>;
    pickNext?: (request: AiPickRequest) => Promise<AiResult<AiPickResult>>;
  };
  const noTips = (state: AiStoreState): DecideResult => ({ orders: state.orders.map(({ id }) => id), locked_count: 4, moves: [], eta: {}, tips: [], feed: [], fallback: true });

  function fakeAi(handlers: Handlers): AiClient {
    return {
      decide: async (state) => {
        const data = await (handlers.decide ?? (async (s) => noTips(s)))(state);
        return data ? { ok: true, data } : { ok: false, error: 'AI 서버에 연결하지 못했어요.' };
      },
      classify: async () => ({ ok: true, data: { intent: 'store_event', confidence: 0.99, source: 'zoro' } }),
      pickNext: handlers.pickNext ?? (async () => ({ ok: false, error: 'AI 서버에 연결하지 못했어요.' })),
    };
  }
  const storeWith = (handlers: Handlers) => new OrderStore({ catalog: menuCatalog, config, decideDelayMs: 0, ai: fakeAi(handlers) });
  const zoro = (pick: string, confidence: number): AiResult<AiPickResult> => ({ ok: true, data: { pick, source: 'zoro', confidence, scores: { [pick]: confidence }, fallback: false } });

  it('leaves slot 4 empty while Zoro picks, then puts Zoro\'s pick there', async () => {
    const requests: AiPickRequest[] = [];
    const store = storeWith({ pickNext: async (request) => { requests.push(request); return zoro('#107', 0.81); } });
    await store.settle();
    store.updateOrderStatus('#101', 'complete');
    const picking = store.snapshot();
    assert.deepEqual(picking.slot4 && { order_id: picking.slot4.order_id, status: picking.slot4.status, source: picking.slot4.source }, { order_id: '', status: 'checking', source: 'zoro' });
    assert.deepEqual(picking.board.filter(({ zone }) => zone === 'locked').map(({ order_id: id }) => id), ['#102', '#103', '#104'], 'no rule pick in slot 4 while waiting');
    assert.deepEqual(picking.board.filter(({ zone }) => zone === 'flexible').map(({ order_id: id, slot }) => `${slot}:${id}`), ['5:#105', '6:#106', '7:#107', '8:#108']);
    assert.ok(!picking.work_window.some(({ orders }) => orders.includes('#105')), 'the window waits for slot 4');

    await store.settle();
    assert.deepEqual(boardIds(store), ['#102', '#103', '#104', '#107', '#105', '#106', '#108', '#109', '#110']);
    assert.deepEqual(store.snapshot().slot4 && { ...store.snapshot().slot4, facts: undefined }, {
      order_id: '#107', source: 'zoro', status: 'final', rule_pick: '#105', confidence: 0.81, scores: { '#107': 0.81 }, facts: undefined,
    });
    assert.deepEqual(overtaken(store), { '#102': 0, '#103': 0, '#104': 0, '#107': 0, '#105': 1, '#106': 1, '#108': 0, '#109': 0, '#110': 0 });
    assert.equal(steps(store).filter((step) => step.includes('#107')).length, 1, 'the window is rewritten for the new slot 4');

    const [request] = requests;
    assert.deepEqual(request.locked.map(({ id }) => id), ['#102', '#103', '#104']);
    assert.deepEqual(request.candidates.map(({ id }) => id), ['#105', '#106', '#107', '#108'], 'candidates in arrival order');
    assert.equal(request.rule_pick, '#105');
    assert.deepEqual(request.owner_rules, ownerRules.sentences);
    assert.deepEqual(request.examples, []);
    assert.equal(request.baristas, 2);
    assert.match(request.locked[0].facts, /다 만듦/);
    assert.ok(request.candidates.every(({ facts }) => facts.includes('기다림')));
  });

  it('uses the rule pick only when Zoro gives no usable answer', async () => {
    const answers: AiResult<AiPickResult>[] = [
      { ok: true, data: { pick: '#105', source: 'rule', confidence: 0.42, scores: { '#107': 0.42, '#105': 0.3 }, fallback: false } },
      { ok: false, error: 'AI 서버가 1500ms 안에 응답하지 않았어요.' },
      zoro('#999', 0.95),
    ];
    for (const answer of answers) {
      const store = storeWith({ pickNext: async () => answer });
      store.updateOrderStatus('#101', 'complete');
      await store.settle();
      assert.equal(boardIds(store)[3], '#105');
      assert.equal(store.snapshot().slot4?.source, 'rule');
      assert.equal(store.snapshot().slot4?.status, 'final');
    }
  });

  it('drops a Zoro answer that arrives after another completion', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const store = storeWith({
      pickNext: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
          return zoro('#108', 0.9);
        }
        return zoro('#109', 0.9);
      },
    });
    store.updateOrderStatus('#101', 'complete');
    // Zoro 답 전에 1번(#102)이 또 끝나면, 비어 있던 4번은 룰 선택(#105)으로 채워 당기고 다시 Zoro에 묻는다.
    store.updateOrderStatus('#102', 'complete');
    release();
    await store.settle();
    assert.deepEqual(boardIds(store), ['#103', '#104', '#105', '#109', '#106', '#107', '#108', '#110']);
    assert.equal(store.snapshot().slot4?.order_id, '#109');
  });

  it('keeps waiting for Zoro when a waiting order completes, and skips a pick that is no longer on the board', async () => {
    let release: () => void = () => {};
    const store = storeWith({
      pickNext: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return zoro('#106', 0.9);
      },
    });
    store.updateOrderStatus('#101', 'complete');
    store.updateOrderStatus('#106', 'complete');
    assert.equal(store.snapshot().slot4?.status, 'checking', 'a waiting order finishing early does not fill slot 4');
    release();
    await store.settle();
    assert.deepEqual(boardIds(store).slice(0, 4), ['#102', '#103', '#104', '#105']);
    assert.equal(store.snapshot().slot4?.source, 'rule');
  });

  it('uses /ai/decide only for tips: the board order stays', async () => {
    const sizes: number[] = [];
    const store = storeWith({
      decide: async (state) => {
        sizes.push(state.orders.length);
        return { ...noTips(state), orders: state.orders.map(({ id }) => id).reverse(), tips: [{ id: 'beans', text: '원두 재고 확인 필수', confidence: 0.8, source: 'zoro' }], fallback: false };
      },
    });
    await store.settle();
    assert.deepEqual(sizes, [8]);
    assert.deepEqual(boardIds(store), ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    assert.deepEqual(store.snapshot().tips.map(({ id }) => id), ['beans']);
    assert.equal(store.snapshot().decision.ai_status, 'connected');
    assert.equal(store.snapshot().decision.source, 'zoro');
  });

  it('marks aiserver unavailable when /ai/decide fails and ignores stale tips (INV-04)', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const store = storeWith({
      decide: async (state) => {
        calls += 1;
        if (calls === 1) return undefined;
        if (calls === 2) {
          await new Promise<void>((resolve) => { release = resolve; });
          return { ...noTips(state), tips: [{ id: 'stale', text: '늦은 팁', confidence: 0.9, source: 'zoro' }], fallback: false };
        }
        return noTips(state);
      },
    });
    await store.settle();
    assert.equal(store.snapshot().decision.ai_status, 'unavailable');

    store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    release();
    await store.settle();
    assert.deepEqual(store.snapshot().tips, [], 'late tips for an old state are not applied');
    assert.equal(store.snapshot().decision.ai_status, 'connected');
  });
});
