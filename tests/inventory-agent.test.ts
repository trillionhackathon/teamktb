import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoreEvent } from '../app/domain/types.ts';
import type { OrderItemView, OrderView } from '../app/domain/views.ts';
import { agentMessages, formatAmount, inventoryViews, withSubjectParticle, type AgentContext } from '../app/server/agent.ts';
import { InventoryStore, lineUsage } from '../app/server/inventory.ts';
import { attachInventory } from '../app/server/inventory-instance.ts';
import { OrderStore } from '../app/server/order-store.ts';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';

const line = (name: string, qty: number, options: string[] = []): OrderItemView => ({ name, qty, unit: '잔', options });

function order(number: number, items: OrderItemView[]): OrderView {
  return {
    order_id: `#${number}`, channel: 'dine-in', channel_label: '매장', source: 'kiosk', source_label: '키오스크', status: 'waiting', items,
    received_at: new Date(Date.UTC(2026, 10, 19, 5, 0, number)).toISOString(), remaining_work_seconds: 120, price_krw: 4500,
  };
}

function context(store: InventoryStore, orders: OrderView[], patch: Partial<AgentContext> = {}): AgentContext {
  return { items: store.items(), usage: store.usage, orders, recent: store.recentUse(), events: [], equipment: {}, ...patch };
}

describe('inventory store (SQLite, data/inventory.json)', () => {
  it('seeds every item from inventory.json and reads recipe usage', () => {
    const store = new InventoryStore(':memory:');
    assert.equal(store.items().length, 32, 'inventory.json items including tiramisu');
    assert.equal(store.items().find(({ id }) => id === 'beans')?.on_hand, 3600);
    assert.equal(lineUsage(line('아이스 아메리카노', 2), store.usage).get('beans'), 72);
  });

  it('applies size scale and milk/shot options', () => {
    const store = new InventoryStore(':memory:');
    const plain = lineUsage(line('카페 라떼', 1), store.usage);
    const large = lineUsage(line('카페 라떼 라지', 1), store.usage);
    assert.ok(plain.get('milk')! > 0);
    assert.equal(large.get('milk'), plain.get('milk')! * 1.35);
    const oat = lineUsage(line('카페 라떼', 1, ['오트밀크 변경', '샷 추가']), store.usage);
    assert.equal(oat.get('milk'), undefined);
    assert.equal(oat.get('oat_milk'), plain.get('milk'));
    assert.equal(oat.get('beans'), plain.get('beans')! + 18);
  });

  it('records order source and splits today usage into real and demo orders', () => {
    const store = new InventoryStore(':memory:');
    store.consumeOrder({ ...order(1, [line('아이스 아메리카노', 1)]), source: 'kiosk' });
    store.consumeOrder({ ...order(2, [line('아이스 아메리카노', 2)]), source: 'demo' });
    assert.deepEqual(store.usageSummary().get('beans'), { recent: 108, today: 108, todayReal: 36 });
    const views = inventoryViews(context(store, []), store.usageSummary());
    const beans = views.find(({ id }) => id === 'beans')!;
    assert.deepEqual([beans.used_today, beans.used_today_real], ['108g', '36g']);
    assert.deepEqual(store.liveStock(), { espresso_shot: (3600 - 108) / 18, strawberry_servings: 5400 / 180 });
  });

  it('consumes a completed order once and restocks up to full', () => {
    let now = Date.UTC(2026, 10, 19, 5, 0);
    const store = new InventoryStore(':memory:', () => now);
    const done = order(1, [line('아이스 아메리카노', 3)]);
    assert.equal(store.consumeOrder(done), true);
    assert.equal(store.consumeOrder(done), false);
    const beans = store.items().find(({ id }) => id === 'beans')!;
    assert.equal(beans.on_hand, 3600 - 108);
    assert.equal(store.recentUse().cups, 3);
    now += 20 * 60_000;
    assert.equal(store.recentUse().cups, 0);
    assert.equal(store.restock('beans')?.on_hand, 5000);
    assert.equal(store.restock('nope'), undefined);
  });
});

describe('wizard agent messages', () => {
  it('names the first board order that runs short, in the shown order', () => {
    const store = new InventoryStore(':memory:');
    // 오트밀크 700ml: 오트 라떼를 차례로 쌓으면 어느 주문에서 모자라는지 알려 준다.
    const oat = (number: number) => order(number, [line('카페 라떼', 2, ['오트밀크 변경'])]);
    const messages = agentMessages(context(store, [oat(1), order(2, [line('아이스 아메리카노', 1)]), oat(3), oat(4)]));
    const message = messages.find(({ id }) => id === 'stock-oat_milk')!;
    assert.equal(message.level, 'danger');
    // 짧은 알림: 굵은 줄은 "오트밀크 1L 팩 6개", 작은 줄은 "남은 양 · 어느 주문부터 부족"
    assert.equal(message.title, '오트밀크');
    assert.equal(message.reorder, '1L 팩 6개');
    assert.match(message.text, /^\d+ml 남음 · #\d부터 부족$/);
    assert.equal(message.action?.item_id, 'oat_milk');
    assert.equal(message.action!.label, '채웠어요');
    assert.equal(messages[0].id, 'summary');
    assert.ok(messages.length <= 5);
  });

  it('warns about burn rate from recent completions', () => {
    let now = Date.UTC(2026, 10, 19, 5, 0);
    const store = new InventoryStore(':memory:', () => now);
    for (let index = 0; index < 40; index += 1) store.consumeOrder(order(100 + index, [line('카페 라떼', 2)]));
    now += 60_000;
    const milk = agentMessages(context(store, []), Infinity).find(({ id }) => id === 'stock-milk');
    assert.ok(milk, 'milk message');
    assert.match(milk.text, /^\S+ 남음 · (약 \d+분 뒤 위험|주의|위험)$/);
  });

  it('shows equipment and store incidents but not rider events', () => {
    const store = new InventoryStore(':memory:');
    const spill: StoreEvent = { event_id: 'spill', category: 'spill_cleanup', raw_text: '바닥에 커피를 쏟았어요', summary: '바닥 청소 필요', needs_confirmation: false, received_at: '2026-11-19T05:00:00Z' };
    const rider: StoreEvent = { ...spill, event_id: 'rider', category: 'rider_arrived', summary: '라이더 도착' };
    const ids = agentMessages(context(store, [], { events: [rider, spill], equipment: { blender: 'broken' } }), Infinity).map(({ id }) => id);
    assert.deepEqual(ids.slice(0, 2), ['summary', 'equipment-blender']);
    assert.ok(ids.includes('event-spill'));
    assert.ok(!ids.includes('event-rider'));
  });

  it('formats amounts and particles for Korean messages', () => {
    assert.equal(formatAmount(3600, 'g'), '3.6kg');
    assert.equal(formatAmount(700, 'ml'), '700ml');
    assert.equal(formatAmount(80, 'ea'), '80개');
    assert.equal(withSubjectParticle('우유'), '우유가');
    assert.equal(withSubjectParticle('원두'), '원두가');
    assert.equal(withSubjectParticle('딸기 과육'), '딸기 과육이');
  });

  it('lists every stock item, most urgent first, with the order that runs short', () => {
    const store = new InventoryStore(':memory:');
    const coldBrew = (number: number) => order(number, [line('콜드브루', 5)]);
    const views = inventoryViews(context(store, [coldBrew(1), coldBrew(2), coldBrew(3)]));
    assert.equal(views.length, 32);
    assert.deepEqual([views[0].id, views[0].status], ['cold_brew', 'short']);
    assert.match(views[0].left, /^[\d.]+m?l?L? 남음$/);
    assert.match(views[0].note, /^\d번 주문 #\d부터 모자람, 콜드브루 기준 \d+잔 분량$/);
    assert.ok(views[0].menus.includes('콜드브루'));
    const ranks = views.map(({ status }) => ['short', 'danger', 'board_danger', 'soon', 'warn', 'ok'].indexOf(status));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });
});

describe('order store stock from SQLite', () => {
  it('takes beans and strawberry from SQLite, reserves for board orders, and consumes on completion', () => {
    const inventory = new InventoryStore(':memory:');
    const store = new OrderStore({ catalog: menuCatalog, config: { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount } });
    attachInventory(store, inventory);
    // SQLite 원두 3600g = 200샷에서, 처음 보드에 있는 주문이 쓸 샷을 미리 뺀다.
    const reserved = store.snapshot().board.reduce((sum, view) => sum + view.items.filter(({ name }) => name.includes('아메리카노') || name.includes('라떼')).reduce((total, { qty }) => total + qty * 2, 0), 0);
    const before = store.snapshot().signals.inventory.coffee_beans_shots_left;
    assert.equal(before, 3600 / 18 - reserved);
    const created = store.createOrder({ channel: 'takeout', source: 'kiosk', menu_items: [{ menu: 'iced_americano', qty: 2 }] });
    assert.ok('order' in created);
    const afterCreate = store.snapshot().signals.inventory.coffee_beans_shots_left;
    assert.equal(afterCreate, before - 4);
    store.updateOrderStatus(created.order.order_id, 'complete');
    // 완료하면 SQLite에서 4샷(72g)이 빠지고 예약도 풀려서, 주문 받을 수 있는 샷 수는 그대로다.
    assert.equal(inventory.items().find(({ id }) => id === 'beans')?.on_hand, 3600 - 72);
    assert.equal(store.snapshot().signals.inventory.coffee_beans_shots_left, afterCreate);
  });
});
