import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiStoreState, DecideResult } from '../app/ai/contract.ts';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';
import type { AiClient } from '../app/server/aiserver.ts';
import { OrderStore } from '../app/server/order-store.ts';

const config = { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount };
const boardIds = (store: OrderStore) => store.snapshot().board.map(({ order_id: id }) => id);

function storeWithoutAi() {
  return new OrderStore({ catalog: menuCatalog, config });
}

describe('OrderStore without aiserver (rule fallback)', () => {
  it('starts with the shared board and appends kiosk orders as #111 in the queue (SC-01)', () => {
    const store = storeWithoutAi();
    assert.deepEqual(boardIds(store), ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110']);
    const result = store.createOrder({ request_id: 'k-1', channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'iced_americano', qty: 3 }] });
    assert.ok('order' in result);
    assert.equal(result.order.order_id, '#111');
    assert.equal(result.order.remaining_work_seconds, 153);
    const snapshot = store.snapshot();
    const queued = snapshot.board.at(-1)!;
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

  it('moves #108 to slot 6 when its rider arrives and promotes slot 6 when slot 5 completes (SC-B)', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-B');
    assert.equal(await store.runTrigger('SC-B', 0), undefined);
    assert.deepEqual(boardIds(store).slice(5), ['#108', '#106', '#107', '#109', '#110']);
    assert.equal(store.snapshot().board[5].move_reason, '라이더가 도착해 기다리고 있어요');

    store.updateOrderStatus('#101', 'start');
    store.updateOrderStatus('#101', 'complete');
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.board.slice(0, 5).map(({ order_id: id }) => id), ['#102', '#103', '#104', '#105', '#108']);
    assert.equal(snapshot.board[4].zone, 'locked');
    assert.equal(snapshot.counts.done, 1);
  });

  it('records the SC-A delivery message flow without inventing a number', async () => {
    const store = storeWithoutAi();
    store.loadScenario('SC-A');
    await store.runTrigger('SC-A', 0);
    let order = store.snapshot().board.find(({ order_id: id }) => id === '#108')!;
    assert.equal(order.needs_confirmation, true);
    assert.equal(order.pickup_eta_seconds, null);
    await store.runTrigger('SC-A', 0);
    assert.equal(store.snapshot().events.length, 1, 'INV-03: same event id is processed once');
    await store.runTrigger('SC-A', 1);
    order = store.snapshot().board.find(({ order_id: id }) => id === '#108')!;
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
});

describe('OrderStore with aiserver', () => {
  function fakeAi(decide: (state: AiStoreState) => Promise<DecideResult | undefined>): AiClient {
    return {
      decide: async (state) => {
        const data = await decide(state);
        return data ? { ok: true, data } : { ok: false, error: 'AI 서버에 연결하지 못했어요.' };
      },
      classify: async () => ({ ok: true, data: { intent: 'store_event', confidence: 0.99, source: 'zoro' } }),
      quest: async () => ({ ok: false, error: 'AI 서버에 연결하지 못했어요.' }),
    };
  }

  it('sends only the 10 board slots to aiserver, never the queue', async () => {
    const sizes: number[] = [];
    const store = new OrderStore({
      catalog: menuCatalog, config, decideDelayMs: 0,
      ai: fakeAi(async (state) => {
        sizes.push(state.orders.length);
        return { orders: state.orders.map(({ id }) => id), locked_count: 5, moves: [], eta: {}, tips: [], feed: [], fallback: true };
      }),
    });
    store.createOrder({ channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'iced_americano', qty: 1 }] });
    await store.settle();
    assert.deepEqual(sizes.at(-1), 10);
    assert.equal(store.snapshot().decision.ai_status, 'connected');
    assert.equal(store.snapshot().decision.ai_error, undefined);
  });

  it('applies the aiserver order and tips with source zoro', async () => {
    const store = new OrderStore({
      catalog: menuCatalog, config, decideDelayMs: 0,
      ai: fakeAi(async (state) => {
        assert.equal(state.orders[7].id, '#108');
        assert.equal(state.orders[7].channel, 'delivery');
        assert.equal(state.orders[7].prep_seconds, 199);
        const ids = state.orders.map(({ id }) => id);
        return {
          orders: [...ids.slice(0, 5), '#109', '#106', '#107', '#108', '#110'],
          locked_count: 5,
          moves: [{ order_id: '#109', from: 9, to: 6, reason: 'ai_hint', confidence: 0.91, source: 'zoro' }],
          eta: {},
          tips: [{ id: 'beans', text: '원두 재고 확인 필수', confidence: 0.8, source: 'zoro' }],
          feed: [],
          fallback: false,
        };
      }),
    });
    await store.settle();
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.board.slice(5).map(({ order_id: id }) => id), ['#109', '#106', '#107', '#108', '#110']);
    assert.equal(snapshot.decision.source, 'zoro');
    assert.equal(snapshot.decision.ai_status, 'connected');
    assert.equal(snapshot.board[5].move_reason, 'Zoro가 먼저 만들 주문으로 골랐어요');
    assert.deepEqual(snapshot.tips.map(({ id }) => id), ['beans']);
  });

  it('falls back to rules when aiserver fails (INV-07) and ignores stale responses (INV-04)', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const store = new OrderStore({
      catalog: menuCatalog, config, decideDelayMs: 0,
      ai: fakeAi(async (state) => {
        calls += 1;
        if (calls === 1) return undefined;
        if (calls === 2) {
          await new Promise<void>((resolve) => { release = resolve; });
          return { orders: [...state.orders.slice(0, 5).map(({ id }) => id), '#110', '#109', '#108', '#107', '#106'], locked_count: 5, moves: [], eta: {}, tips: [], feed: [], fallback: false };
        }
        return { orders: state.orders.slice(0, 10).map(({ id }) => id), locked_count: 5, moves: [], eta: {}, tips: [], feed: [], fallback: true };
      }),
    });
    await store.settle();
    assert.equal(store.snapshot().decision.ai_status, 'unavailable');
    assert.equal(store.snapshot().decision.source, 'rule');

    store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.createOrder({ channel: 'dine-in', source: 'kiosk', menu_items: [{ menu: 'latte', qty: 1 }] });
    release();
    await store.settle();
    assert.deepEqual(boardIds(store).slice(5, 10), ['#106', '#107', '#108', '#109', '#110'], 'late response for an old state is not applied');
    assert.equal(store.snapshot().decision.fallback, true);
  });
});
