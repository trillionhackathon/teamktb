import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiPickRequest, AiPickResult, AiGroupRequest, AiGroupResult, AiStoreState, DecideResult } from '../app/ai/contract.ts';
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

describe('OrderStore quick menu pull (kds_board quick_menu_sec / quick_slots)', () => {
  const quickStore = () => new OrderStore({ catalog: menuCatalog, config: { ...config, quickMenuSec: 90, quickSlots: 2 } });
  const iceCream = (id: string) => ({ request_id: id, channel: 'dine-in' as const, source: 'kiosk' as const, menu_items: [{ menu: 'ice_cream_vanilla', qty: 1 }] });

  it('reads the setting from data/cafe_db.json', () => {
    assert.equal(boardConfig.quickMenuSec, 90);
    assert.equal(boardConfig.quickSlots, 2);
  });

  it('pulls quick orders (waiting, ≤ quick_menu_sec) to the front of the waiting slots, never into the locked 1-4', () => {
    const plainStore = storeWithoutAi();
    const plain = boardIds(plainStore);
    const quick = plainStore.snapshot().board.slice(4).filter((o) => o.status === 'waiting' && o.remaining_work_seconds <= 90).map((o) => o.order_id).slice(0, 2);
    const store = quickStore();
    assert.ok(quick.length > 0);
    const after = boardIds(store);
    assert.deepEqual(after.slice(0, 4), plain.slice(0, 4));
    assert.deepEqual(after.slice(4, 4 + quick.length), quick);
    assert.deepEqual(after.slice(4 + quick.length), plain.slice(4).filter((id) => !quick.includes(id)));
  });

  it('pulls a new quick order out of the queue when a quick slot is free, in arrival order', () => {
    const store = new OrderStore({ catalog: menuCatalog, config: { ...config, quickMenuSec: 90, quickSlots: 3 } });
    const quickBefore = boardIds(store).slice(4, 6);
    const first = store.createOrder(iceCream('q-1'));
    const second = store.createOrder(iceCream('q-2'));
    assert.ok('order' in first && 'order' in second);
    assert.ok(first.order.remaining_work_seconds <= 90);
    const after = boardIds(store);
    assert.deepEqual(after.slice(4, 7), [...quickBefore, first.order.order_id]);
    assert.equal(after.at(-1), second.order.order_id);
  });

  it('shows each item with its menu group', () => {
    const store = quickStore();
    const result = store.createOrder(iceCream('q-1'));
    assert.ok('order' in result);
    const card = store.snapshot().board.find((o) => o.order_id === result.order.order_id)!;
    assert.equal(card.items[0].group?.id, 'g5');
    assert.equal(card.items[0].group?.name_kr, '아이스크림');
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
    groupOrders?: (request: AiGroupRequest) => Promise<AiResult<AiGroupResult>>;
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
      groupOrders: handlers.groupOrders ?? (async () => ({ ok: false, error: 'AI 서버에 연결하지 못했어요.' })),
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
  describe('FIFO board with Zoro grouping of the top 4 and the note cards below', () => {
    const fifoConfig = { ...config, fifo: true };
    const group = (groups: Record<string, number>, scores: Record<string, number> = {}, matched_menus: Record<string, string[]> = {}): AiResult<AiGroupResult> => ({ ok: true, data: { groups, scores, matched_menus, fallback: false } });
    const fifoStore = (groupOrders?: (request: AiGroupRequest) => Promise<AiResult<AiGroupResult>>, pickNext = async (): Promise<AiResult<AiPickResult>> => { throw new Error('Zoro must not pick slot 4 in FIFO'); }) =>
      new OrderStore({ catalog: menuCatalog, config: fifoConfig, decideDelayMs: 0, ai: { ...fakeAi({ groupOrders }), pickNext } });

    it('keeps strict arrival order: slot 4 is the oldest waiting order and Zoro is not asked to pick it', async () => {
      const store = fifoStore();
      await store.settle();
      store.updateOrderStatus('#101', 'complete');
      await store.settle();
      assert.deepEqual(boardIds(store), ['#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
      assert.equal(store.snapshot().slot4?.source, 'rule');
    });

    it('asks Zoro only about #1 (anchor) against 2-4 with their recipes, and colours #1 and its companions', async () => {
      const requests: AiGroupRequest[] = [];
      const store = fifoStore(async (request) => { requests.push(request); return group({ '#101': 1, '#103': 1, '#102': 2 }, { '#102': 0.2, '#103': 0.91, '#104': 0.1 }); });
      await store.settle();
      assert.equal(requests[0].anchor, '#101');
      assert.deepEqual(requests[0].orders.map(({ id }) => id), ['#101', '#102', '#103', '#104']);
      assert.ok(requests[0].orders.every(({ menus }) => menus.length > 0 && menus.every(({ steps }) => steps.length > 0)), 'Zoro reads the recipe steps');
      const { review } = store.snapshot();
      assert.equal(review.status, 'ready');
      assert.equal(review.anchor, '#101');
      assert.deepEqual(Object.keys(review.groups).sort(), ['#101', '#103'], 'only #1 and its companions; a group without #1 is ignored');
      assert.equal(review.groups['#101'].role, 'anchor');
      assert.deepEqual({ role: review.groups['#103'].role, score: review.groups['#103'].score }, { role: 'companion', score: 0.91 });
      assert.equal(review.groups['#101'].color, review.groups['#103'].color);
      const head = store.snapshot().notes.find(({ kind }) => kind === 'head')!;
      assert.match(head.zoro!, /#103 0\.91/, 'the card shows the Zoro scores in small print');
      assert.equal(head.reason, '#102 아이스 아메리카노는 만드는 방법이 달라서, #104 카페 라떼는 만드는 방법이 달라서 따로 만들어요.');
    });

    it('leaves decaf and oat-milk lines out before asking Zoro (code rule) and says why', async () => {
      const requests: AiGroupRequest[] = [];
      const store = fifoStore(async (request) => { requests.push(request); return group({}); });
      store.loadScenario('SC-Q');
      await store.settle();
      const request = requests.at(-1)!;
      assert.deepEqual(request.orders.map(({ id }) => id), ['#101', '#102', '#103'], '#104 (decaf latte) is not sent');
      assert.equal(store.snapshot().review.excluded['#104'], '디카페인이라 원두를 바꿔야 해서');
      assert.equal(store.snapshot().notes.find(({ kind }) => kind === 'head')!.reason, '#104 카페 라떼는 디카페인이라 원두를 바꿔야 해서 따로 만들어요.');
    });

    it('marks only the matched menu lines when a task is completed', async () => {
      const store = fifoStore(async () => group({ '#101': 1, '#104': 1 }, {}, { '#104': ['latte'] }));
      await store.settle();
      const task = store.snapshot().notes.find(({ kind }) => kind === 'task')!;
      assert.equal(task.text, '카페 라떼 3잔 만들기');
      assert.deepEqual(task.parts?.map(({ order_id, qty }) => [order_id, qty]), [['#101', 1], ['#104', 2]]);
      assert.deepEqual(store.handleNote(task.id), { ok: true });
      assert.equal(find(store, '#101').items[0].made, true);
      assert.equal(find(store, '#104').items[0].made, true);
      assert.equal(find(store, '#104').status, 'waiting');
      assert.equal(store.snapshot().notes.find(({ id }) => id === task.id)?.done, true);
      assert.equal('error' in store.handleNote(task.id), true, 'double completion is rejected');
    });

    it('SC-W shows only Zoro-matched menus and lets one menu finish independently', async () => {
      const store = fifoStore(async () => group(
        { '#126': 1, '#128': 1, '#129': 1 },
        { '#130': 0.1, '#128': 1, '#129': 0.9 },
        { '#128': ['latte'], '#129': ['iced_americano'] },
      ));
      store.loadScenario('SC-W');
      await store.settle();
      const tasks = store.snapshot().notes.filter(({ kind }) => kind === 'task');
      assert.deepEqual(tasks.map(({ text }) => text), ['카페 라떼 2잔 만들기', '아이스 아메리카노 1잔 만들기']);
      assert.ok(tasks.every(({ color, parts }) => color && parts?.length), 'every manufacturing task has one color for all of its parts');
      assert.equal(new Set(tasks.map(({ color }) => color)).size, tasks.length, 'different manufacturing tasks have different colors');
      assert.equal(tasks[0].detail, '샷 추출 · 우유 스팀');
      assert.equal(tasks[1].detail, '샷 추출 · 얼음 준비');
      assert.deepEqual(tasks[0].order_ids, ['#126', '#128']);
      assert.deepEqual(tasks[1].order_ids, ['#129']);
      assert.deepEqual(store.handleNote(tasks[0].id), { ok: true });
      assert.equal(find(store, '#126').items[0].made, true);
      assert.equal(find(store, '#128').items[0].made, true);
      assert.equal(find(store, '#129').items[0].made, false);
      assert.equal(find(store, '#129').items[1].made, false);
      assert.equal(find(store, '#128').status, 'waiting');
      assert.equal(store.snapshot().notes.find(({ id }) => id === tasks[1].id)?.done, false);
    });

    it('SC-W leaves only #128 latte unfinished when the first order completes first', async () => {
      const store = fifoStore(async () => group({ '#126': 1, '#128': 1 }, {}, { '#128': ['latte'] }));
      store.loadScenario('SC-W');
      await store.settle();
      store.updateOrderStatus('#126', 'complete');
      await store.settle();
      const task = store.snapshot().notes.find(({ kind }) => kind === 'task')!;
      assert.equal(task.text, '카페 라떼 1잔 만들기');
      assert.deepEqual(task.parts, [{ order_id: '#128', line_index: 0, qty: 1 }]);
      assert.equal(task.done, false);
      assert.equal(find(store, '#128').items[0].made, false);
    });

    it('writes the #1 card: #1\'s menus first, then which of 2-4 are made together', async () => {
      const store = fifoStore(async () => group({ '#101': 1, '#104': 1, '#102': 2, '#103': 2 }));
      await store.settle();
      const notes = store.snapshot().notes;
      const head = notes.find(({ kind }) => kind === 'head')!;
      assert.equal(head.text, '#101 카페 라떼 1잔을 만들 때 #104 카페 라떼 2잔도 같이 만드세요.');
      assert.equal(head.detail, '같은 메뉴라 한 번에 만들면 돼요.', 'why they are made together, in plain words');
      assert.ok(![head.text, head.detail, head.reason, head.zoro].some((text) => text?.includes('·')), 'legacy head note remains readable');
      assert.deepEqual(head.order_ids, ['#101', '#104']);
      assert.deepEqual(Object.keys(store.snapshot().review.groups).sort(), ['#101', '#104'], 'a group of 2-4 without #1 is not shown');
    });

    it('says Zoro is still looking while the answer is pending, not that nothing matches', async () => {
      let release: () => void = () => {};
      const store = fifoStore(async () => { await new Promise<void>((resolve) => { release = resolve; }); return group({}); });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(store.snapshot().notes.find(({ kind }) => kind === 'head')!.detail, 'Zoro가 같이 만들 주문을 찾고 있어요.');
      release();
      await store.settle();
      assert.equal(store.snapshot().notes.find(({ kind }) => kind === 'head')!.detail, '같이 만들 주문은 없어요.');
    });

    it('says there is nothing to make together when #1 is alone', async () => {
      const store = fifoStore(async () => group({}));
      await store.settle();
      assert.equal(store.snapshot().notes.find(({ kind }) => kind === 'head')!.detail, '같이 만들 주문은 없어요.');
    });

    it('recalculates an unfinished task when an order is completed first', async () => {
      const store = fifoStore(async () => group({ '#101': 1, '#104': 1 }, {}, { '#104': ['latte'] }));
      await store.settle();
      store.updateOrderStatus('#104', 'complete');
      await store.settle();
      const task = store.snapshot().notes.find(({ kind }) => kind === 'task')!;
      assert.equal(task.text, '카페 라떼 1잔 만들기');
      assert.equal(task.done, false);
      assert.deepEqual(task.order_ids, ['#101']);
    });

    it('does not strike anything when a non-#1 order is completed first', async () => {
      const store = fifoStore(async () => group({ '#101': 1, '#104': 1 }));
      await store.settle();
      store.updateOrderStatus('#104', 'complete');
      assert.equal(find(store, '#101').made, false);
    });

    it('does not mark orders made when #1 completes (the old window logic is off in FIFO)', async () => {
      const store = fifoStore();
      await store.settle();
      store.updateOrderStatus('#101', 'complete');
      assert.ok(store.snapshot().board.every(({ made }) => !made));
    });

    describe('slot 8 quick lane (desserts served during hands-free steps)', () => {
      const laneStore = (groupOrders?: (request: AiGroupRequest) => Promise<AiResult<AiGroupResult>>) =>
        new OrderStore({ catalog: menuCatalog, config: { ...fifoConfig, quickLane: true }, decideDelayMs: 0, ai: { ...fakeAi({ groupOrders }), pickNext: async () => { throw new Error('no slot 4 pick in FIFO'); } } });
      const zones = (store: OrderStore) => store.snapshot().board.map(({ order_id: id, slot, zone }) => `${slot}:${id}:${zone}`);

      it('keeps FIFO in slots 1-7 and leaves slot 8 for quick orders only', async () => {
        const store = laneStore();
        await store.settle();
        assert.deepEqual(zones(store), ['1:#101:locked', '2:#102:locked', '3:#103:locked', '4:#104:locked', '5:#105:flexible', '6:#106:flexible', '7:#107:flexible', '8:#108:queue', '9:#109:queue', '10:#110:queue']);
        const lane = store.snapshot().quick_lane;
        assert.deepEqual({ enabled: lane.enabled, order_id: lane.order_id }, { enabled: true, order_id: undefined }, 'no dessert → slot 8 stays empty');
      });

      it('pulls the first dine-in/takeout dessert from beyond the visible board into slot 8 and shows it as ready during #1\'s shot extraction', async () => {
        const store = laneStore();
        store.loadScenario('SC-Q');
        await store.settle();
        const snapshot = store.snapshot();
        const lane = snapshot.board.find(({ zone }) => zone === 'quick')!;
        assert.deepEqual({ id: lane.order_id, slot: lane.slot }, { id: '#110', slot: 8 }, '#110 tiramisu was 10th (off screen); #108 ice cream is delivery and skipped');
        assert.deepEqual(snapshot.board.filter(({ zone }) => zone === 'queue').map(({ order_id: id, slot }) => `${slot}:${id}`), ['9:#108', '10:#109'], 'off-screen numbers start after slot 8');
        assert.deepEqual(snapshot.board.filter(({ zone }) => zone === 'flexible').map(({ order_id: id }) => id), ['#105', '#106', '#107']);
        assert.deepEqual({ ready: snapshot.quick_lane.ready, position: snapshot.quick_lane.fifo_position, hands: snapshot.quick_lane.hands_sec, idle: snapshot.quick_lane.idle },
          { ready: true, position: 10, hands: 18, idle: { order_id: '#101', sec: 30, label: '샷 추출' } });
        const note = snapshot.notes.find(({ kind }) => kind === 'quick')!;
        assert.equal(note.text, '#101 샷이 내려가는 30초 동안 손이 비어요.');
        assert.equal(note.detail, '그동안 #110 티라미수 1개를 먼저 내주세요.');
        assert.equal(note.reason, '원래 순서는 10번째라 화면에 안 보이지만 18초면 끝나서 먼저 내요.');
        assert.ok(lane.eta_seconds! < find(store, '#105').eta_seconds!, 'the customer sees a short wait instead of a FIFO wait');
      });

      it('waits when the current #1 job has no hands-free step long enough', async () => {
        const store = laneStore();
        store.loadScenario('empty');
        store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'cold_brew', qty: 1 }] });
        for (let i = 0; i < 4; i += 1) store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'lemon_ade', qty: 1 }] });
        store.createOrder({ channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'ice_cream_vanilla', qty: 1 }] });
        await store.settle();
        const lane = store.snapshot().quick_lane;
        assert.equal(lane.order_id, '#106');
        assert.equal(lane.ready, false, 'cold brew has no machine step');
        const note = store.snapshot().notes.find(({ kind }) => kind === 'quick')!;
        assert.equal(note.text, '#106 바닐라 아이스크림 1개는 손이 빌 때 먼저 내주세요.');
        assert.equal(note.detail, '지금 만드는 주문에는 기다리는 단계가 없어요.');
      });

      it('serves the quick order early, records it, and brings up the next dessert', async () => {
        const store = laneStore();
        store.loadScenario('SC-Q');
        await store.settle();
        await store.runTrigger('SC-Q', 0);
        assert.deepEqual(store.handleNote('quick:#111'), { error: '이미 처리된 알림이에요.', status: 404 }, 'only the order in slot 8 can be served from the card');
        assert.deepEqual(store.handleNote('quick:#110'), { ok: true });
        assert.ok('error' in store.handleNote('head:#101'), 'the #1 card has no separate button; it uses the order complete call');
        const snapshot = store.snapshot();
        const served = snapshot.history.find(({ order_id: id }) => id === '#110')!;
        assert.deepEqual({ status: served.status, early: served.served_early }, { status: 'done', early: true });
        assert.deepEqual(snapshot.quick_lane.served.map(({ order_id: id, text }) => `${id} ${text}`), ['#110 #110 티라미수 1개']);
        assert.equal(snapshot.quick_lane.order_id, '#111', 'the takeout ice cream comes up next');
        assert.deepEqual(boardIds(store).slice(0, 4), ['#101', '#102', '#103', '#104'], 'FIFO slots did not move');
      });

      it('is off without quickLane: slot 8 is a normal FIFO slot', async () => {
        const store = fifoStore();
        store.loadScenario('SC-Q');
        await store.settle();
        assert.equal(store.snapshot().quick_lane.enabled, false);
        assert.ok(!store.snapshot().board.some(({ zone }) => zone === 'quick'));
        assert.deepEqual(store.snapshot().notes.filter(({ kind }) => kind === 'quick'), []);
      });
    });

    it('stays connected when a Zoro grouping answer lands while /ai/decide is still running', async () => {
      const slowDecide = async (state: AiStoreState) => { await new Promise((resolve) => setTimeout(resolve, 20)); return noTips(state); };
      const store = new OrderStore({ catalog: menuCatalog, config: fifoConfig, decideDelayMs: 0, ai: { ...fakeAi({ decide: slowDecide, groupOrders: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return group({}); } }) } });
      await store.settle();
      assert.equal(store.snapshot().decision.ai_status, 'connected', 'the stale decide is asked again instead of leaving the badge on unavailable');
    });

    it('reports unavailable when aiserver cannot answer and off when there is none', async () => {
      const failing = fifoStore();
      await failing.settle();
      assert.equal(failing.snapshot().review.status, 'unavailable');
      assert.deepEqual(failing.snapshot().review.groups, {});
      assert.equal(storeWithoutAi().snapshot().review.status, 'off');
    });
  });
});
