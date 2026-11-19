import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAiOrder, boardEtas, ruleArrange } from '../app/domain/board.ts';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';
import { interpretEvent, parseEtaSeconds } from '../app/domain/events.ts';
import { normalizeLine, orderPrice, orderWorkSeconds, stockNeeded, toggleOption } from '../app/domain/menu.ts';
import { findScenario, sharedBoardOrders } from '../app/domain/scenarios.ts';
import type { Order, OrderLine } from '../app/domain/types.ts';

function line(menu: string, qty: number, options: string[] = [], size: 'R' | 'L' = 'R'): OrderLine {
  const result = normalizeLine(menuCatalog, { menu, qty, options, size });
  assert.ok('line' in result, 'error' in result ? result.error : '');
  return result.line;
}

function boardFrom(ids: string[], patch: Record<string, Partial<Order>> = {}): Map<string, Order> {
  return new Map(ids.map((id, index) => [id, {
    order_id: id, channel: 'dine-in', source: 'scenario', menu_items: [line('iced_americano', 1)], status: 'waiting',
    received_at: new Date(Date.UTC(2026, 10, 19, 5, 0, index)).toISOString(), remaining_work_seconds: 71, price_krw: 4500, ...patch[id],
  } satisfies Order]));
}

const ids = ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110', '#111'];
const config = { lockedCount: boardConfig.lockedCount, visibleCount: boardConfig.visibleCount };
const never = () => false;

describe('menu catalog (data/recipe.json + data/cafe_db.json)', () => {
  it('uses cafe_db remaining_work_formula: 아아 3잔 153초, 딸기스무디 2잔 199초', () => {
    assert.equal(orderWorkSeconds(menuCatalog, [line('iced_americano', 3)]), 71 + 41 * 2);
    assert.equal(orderWorkSeconds(menuCatalog, [line('strawberry_smoothie', 2)]), 117 + 82);
  });

  it('adds option prep_delta_sec per cup and option/size prices', () => {
    assert.equal(orderWorkSeconds(menuCatalog, [line('iced_americano', 2, ['shot_add'])]), 71 + 41 + 12 * 2);
    assert.equal(orderPrice(menuCatalog, [line('iced_americano', 2, ['shot_add'], 'L')]), (4500 + 500 + 500) * 2);
  });

  it('rejects unknown menus, unavailable options, and exclusive option pairs', () => {
    assert.ok('error' in normalizeLine(menuCatalog, { menu: 'unknown', qty: 1 }));
    assert.ok('error' in normalizeLine(menuCatalog, { menu: 'iced_americano', qty: 1, options: ['milk_oat'] }));
    assert.ok('error' in normalizeLine(menuCatalog, { menu: 'iced_americano', qty: 1, options: ['ice_less', 'ice_extra'] }));
    assert.ok('error' in normalizeLine(menuCatalog, { menu: 'iced_americano', qty: 11 }));
    assert.deepEqual(toggleOption(['ice_less'], 'ice_extra'), ['ice_extra']);
  });

  it('counts stock from consumes_stock', () => {
    assert.deepEqual(stockNeeded(menuCatalog, [line('iced_americano', 2, ['shot_add']), line('strawberry_smoothie', 1)]), { espresso_shot: 6, strawberry_servings: 1 });
  });
});

describe('board rules (kds_board + fallback_rules)', () => {
  it('keeps slots 1-5 fixed and moves an arrived rider to slot 6 (SC-B)', () => {
    const orders = boardFrom(ids, { '#108': { channel: 'delivery', rider_status: 'arrived' }, '#102': { channel: 'delivery', rider_status: 'arrived' } });
    const { board, moves } = ruleArrange(ids, orders, config, never);
    assert.deepEqual(board.slice(0, 5), ids.slice(0, 5));
    assert.deepEqual(board.slice(5, 10), ['#108', '#106', '#107', '#109', '#110']);
    assert.equal(board[10], '#111', 'queue (11th+) is not reordered');
    assert.deepEqual(moves, [{ order_id: '#108', from: 8, to: 6, reason: 'rider_waiting', confidence: 1, source: 'rule' }]);
  });

  it('keeps blocked and in-progress orders in their slot (SC-05)', () => {
    const orders = boardFrom(ids, { '#106': { menu_items: [line('strawberry_smoothie', 2)] }, '#107': { status: 'in_progress' }, '#109': { channel: 'delivery', rider_status: 'arrived' } });
    const blocked = (order: Order) => order.menu_items.some(({ menu }) => menu === 'strawberry_smoothie');
    const { board } = ruleArrange(ids, orders, config, blocked);
    assert.equal(board[5], '#106');
    assert.equal(board[6], '#107');
    assert.equal(board[7], '#109');
  });

  it('applies a valid AI order and rejects one that touches locked slots or unknown orders', () => {
    const orders = boardFrom(ids);
    const aiOrder = ['#101', '#102', '#103', '#104', '#105', '#109', '#106', '#107', '#108', '#110'];
    const applied = applyAiOrder(ids, orders, config, never, aiOrder);
    assert.ok('board' in applied);
    assert.deepEqual(applied.board, [...aiOrder, '#111']);
    assert.ok('error' in applyAiOrder(ids, orders, config, never, ['#102', '#101', ...aiOrder.slice(2)]));
    assert.ok('error' in applyAiOrder(ids, orders, config, never, [...aiOrder.slice(0, 9), '#999']));
  });

  it('sums remaining work ahead of each order for the wait estimate', () => {
    const orders = boardFrom(['#101', '#102']);
    const etas = boardEtas(['#101', '#102'], orders, Date.now());
    assert.deepEqual([...etas.values()], [71, 142]);
  });
});

describe('event interpretation (scenarios.md)', () => {
  it('SC-A: vague rider message stays unconfirmed, follow-up is converted by code', () => {
    const vague = interpretEvent('기사님 거의 다 왔어요. 스무디 안 녹게 부탁드려요.', '#108', 'rider_message');
    assert.equal(vague.category, 'quality_request');
    assert.equal(vague.needs_confirmation, true);
    assert.ok(!vague.effects.some(({ type }) => type === 'pickup_eta'), 'INV-05: no numeric ETA from vague text');
    const followup = interpretEvent('5분 뒤 도착합니다.', '#108');
    assert.equal(followup.category, 'pickup_eta_update');
    assert.deepEqual(followup.effects[0], { type: 'pickup_eta', order_id: '#108', seconds: 300 });
    assert.equal(parseEtaSeconds('세 분 후 도착'), 180);
  });

  it('SC-02: spill becomes a tip, missing location needs confirmation', () => {
    const located = interpretEvent('손님이 통행로에 커피를 쏟았어요');
    assert.equal(located.category, 'spill_cleanup');
    assert.deepEqual(located.effects, [{ type: 'tip', tip: { id: 'spill', text: '통행로 커피 쏟음 - 바닥 청소 필요', source: 'rule' } }]);
    assert.equal(interpretEvent('커피를 쏟았어요').needs_confirmation, true);
  });

  it('SC-05: blender failure and recovery', () => {
    assert.equal(interpretEvent('블렌더 고장').category, 'equipment_failure');
    assert.equal(interpretEvent('블렌더 복구됐어요').category, 'equipment_recovered');
  });

  it('rider arrival needs an order number', () => {
    assert.deepEqual(interpretEvent('108번 라이더 도착했어요').effects, [{ type: 'rider_status', order_id: '#108', status: 'arrived' }]);
    assert.equal(interpretEvent('라이더 도착했어요').needs_confirmation, true);
  });
});

describe('scenarios (data/scenarios.json)', () => {
  it('builds the shared board #101-#110 with details from board_shared_example', () => {
    assert.deepEqual(sharedBoardOrders.map(({ order_id: id }) => id), ids.slice(0, 10));
    const order108 = sharedBoardOrders.find(({ order_id: id }) => id === '#108')!;
    assert.deepEqual(order108.menu_items, [{ menu: 'strawberry_smoothie', qty: 2 }]);
    assert.equal(order108.channel, 'delivery');
    assert.equal(order108.rider_status, 'not_dispatched');
    const waits = sharedBoardOrders.map(({ waiting_seconds: seconds }) => seconds);
    assert.deepEqual([...waits].sort((a, b) => b - a), waits, 'slot order is arrival order');
  });

  it('turns SC-A..D triggers into replayable inputs', () => {
    assert.deepEqual(findScenario('SC-B')?.triggers[0], { label: '2:10 #108 라이더 도착', kind: 'signal', signal: { rider_status: { '#108': 'arrived' } } });
    assert.equal(findScenario('SC-A')?.triggers.length, 2);
    const scC = findScenario('SC-C')?.triggers[0];
    assert.ok(scC?.kind === 'event' && scC.signal?.inventory?.coffee_beans_shots_left === 12);
  });
});
