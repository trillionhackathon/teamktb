import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boardEtas, rulePickNext } from '../app/domain/board.ts';
import { menuCatalog, ownerRules } from '../app/domain/catalog-data.ts';
import { interpretEvent, parseEtaSeconds } from '../app/domain/events.ts';
import { buildFacts, lockedLine } from '../app/domain/facts.ts';
import { normalizeLine, orderPrice, orderWorkSeconds, stockNeeded, toggleOption } from '../app/domain/menu.ts';
import { taskLineColors } from '../app/domain/review.ts';
import { findScenario, sharedBoardOrders } from '../app/domain/scenarios.ts';
import type { Order, OrderLine } from '../app/domain/types.ts';
import { buildWorkWindow } from '../app/domain/work-window.ts';

function line(menu: string, qty: number, options: string[] = [], size: 'R' | 'L' = 'R'): OrderLine {
  const result = normalizeLine(menuCatalog, { menu, qty, options, size });
  assert.ok('line' in result, 'error' in result ? result.error : '');
  return result.line;
}

const ids = ['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#108', '#109', '#110'];
const now = Date.UTC(2026, 10, 19, 3, 37, 20);
const limits = ownerRules.limits;

// remaining_work_seconds를 직접 정해 사실 계산 숫자를 맞춘다.
function order(id: string, patch: Partial<Order> = {}, agoSeconds = 60): Order {
  return {
    order_id: id, channel: 'dine-in', source: 'scenario', menu_items: [line('iced_americano', 1)], status: 'waiting',
    received_at: new Date(now - agoSeconds * 1000).toISOString(), remaining_work_seconds: 60, price_krw: 4500, ...patch,
  };
}

const ctx = (orders: Order[]) => ({ orders: new Map(orders.map((o) => [o.order_id, o])), catalog: menuCatalog, limits, now });

describe('manufacturing task colors', () => {
  it('maps each task color only to its included order menu lines', () => {
    assert.deepEqual(taskLineColors([
      { id: 'task:latte', kind: 'task', text: '라떼 2잔', order_ids: ['#126', '#128'], color: '#2563eb', parts: [{ order_id: '#126', line_index: 0, qty: 1 }, { order_id: '#128', line_index: 0, qty: 1 }] },
      { id: 'task:americano', kind: 'task', text: '아메리카노 1잔', order_ids: ['#129'], color: '#d97706', parts: [{ order_id: '#129', line_index: 0, qty: 1 }] },
      { id: 'quick:#130', kind: 'quick', text: '먼저 내기', order_ids: ['#130'], color: '#000', parts: [{ order_id: '#130', line_index: 0, qty: 1 }] },
    ]), { '#126:0': '#2563eb', '#128:0': '#2563eb', '#129:0': '#d97706' });
  });
});

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

describe('owner rules (data/owner_rules.json)', () => {
  it('keeps the sentences and the numbers saying the same thing', () => {
    assert.deepEqual(limits, { max_wait_sec: 600, delivery_late_ok_sec: 120, max_overtaken: 3 });
    assert.ok(ownerRules.sentences.some((sentence) => sentence.includes('10분')));
    assert.ok(ownerRules.sentences.some((sentence) => sentence.includes('2분')));
  });
});

describe('facts for picking slot 4 (app/domain/facts.ts)', () => {
  // 1~3번 각 60초 → 4번은 지금부터 3분 뒤에 시작한다.
  const locked = [order('#102', {}, 400), order('#103', {}, 380), order('#104', {}, 360)];
  const lockedIds = locked.map(({ order_id: id }) => id);

  it('says when a store order goes out in slot 4 and when pushed one slot, against the 10 minute rule', () => {
    const late = order('#105', { channel: 'takeout' }, 330);
    const ok = order('#106', { channel: 'takeout', request_note: '하나는 연하게요', overtaken: 2 }, 100);
    const facts = buildFacts(lockedIds, ['#105', '#106'], ctx([...locked, late, ok]));
    const f105 = facts.get('#105')!;
    assert.equal(f105.waitPushedSec, 630);
    assert.equal(f105.latePushedSec, undefined);
    assert.equal(f105.line, '아이스 아메리카노 1잔 · 포장 · 5분 30초 기다림 · 4번에 안 넣으면 10분 30초에 나가 기준 10분을 넘김 (4번이면 9분 30초)'
      + ' · 1번 #102 주문과 아이스 아메리카노 같이 만들기 가능 · 2번 #103 주문과 아이스 아메리카노 같이 만들기 가능 · 3번 #104 주문과 아이스 아메리카노 같이 만들기 가능');
    assert.match(facts.get('#106')!.line, /4번에 안 넣어도 6분 40초에 나가 기준 10분 안 · .* · 메모 "하나는 연하게요" · 2번 밀림$/);
  });

  it('says how late a delivery is against the rider when it is not slot 4', () => {
    const delivery = order('#110', { channel: 'delivery', rider_status: 'dispatched', rider_eta_at: new Date(now + 250_000).toISOString(), menu_items: [line('latte', 1)] }, 50);
    const other = order('#109', { channel: 'takeout' }, 90);
    const facts = buildFacts(lockedIds, ['#109', '#110'], ctx([...locked, other, delivery]));
    const f110 = facts.get('#110')!;
    assert.equal(f110.latePushedSec, 50);
    assert.equal(f110.slackSec, 10);
    assert.equal(f110.line, '카페 라떼 1잔 · 배달 · 50초 기다림 · 라이더 4분 10초 뒤 · 4번에 안 넣으면 라이더보다 50초 늦지만 기준 2분 안');
  });

  it('does not offer batching with orders that are already made or that use batch blocking options', () => {
    const others = [order('#102', { made: true }, 400), order('#103', { menu_items: [line('iced_americano', 1, ['decaf'])] }, 380), order('#104', { menu_items: [line('latte', 1)] }, 360)];
    const facts = buildFacts(others.map(({ order_id: id }) => id), ['#105'], ctx([...others, order('#105')]));
    assert.doesNotMatch(facts.get('#105')!.line, /같이 만들기/);
  });

  it('writes the locked line with made and rider facts', () => {
    const rider = order('#106', { channel: 'delivery', made: true, rider_eta_at: new Date(now + 70_000).toISOString(), menu_items: [line('iced_americano', 2)] });
    assert.equal(lockedLine(rider, { catalog: menuCatalog, now }), '아이스 아메리카노 2잔 · 배달 · 다 만듦 · 라이더 1분 10초 뒤');
  });
});

describe('rule pick for slot 4 (board.ts rulePickNext)', () => {
  const locked = ['#102', '#103', '#104'].map((id, index) => order(id, {}, 400 - index * 10));
  const pick = (cands: Order[]) => {
    const all = [...locked, ...cands];
    const candidateIds = cands.map(({ order_id: id }) => id);
    const facts = buildFacts(locked.map(({ order_id: id }) => id), candidateIds, ctx(all));
    return rulePickNext(candidateIds, new Map(all.map((o) => [o.order_id, o])), facts, limits);
  };
  const oldest = order('#105', {}, 300);
  const lateDelivery = order('#108', { channel: 'delivery', rider_status: 'arrived', rider_eta_at: new Date(now).toISOString() }, 100);
  const starving = order('#107', { overtaken: 3 }, 200);

  it('③ picks the order that waited longest', () => {
    assert.equal(pick([order('#106', {}, 250), oldest]), '#105');
  });

  it('② picks a delivery that would be later than the rider limit when pushed', () => {
    assert.equal(pick([oldest, lateDelivery]), '#108');
  });

  it('① picks an order skipped max_overtaken times before anything else', () => {
    assert.equal(pick([oldest, starving, lateDelivery]), '#107');
  });

  it('sums remaining work ahead of each order for the wait estimate, made orders only need packing', () => {
    const orders = new Map([order('#101'), order('#102', { made: true })].map((o) => [o.order_id, o]));
    assert.deepEqual([...boardEtas(['#101', '#102'], orders, now).values()], [60, 75]);
  });
});

describe('work window (app/domain/work-window.ts)', () => {
  const steps = (orders: Order[]) => buildWorkWindow(orders, menuCatalog).map(({ text, kind }) => `${kind}: ${text}`);

  it('batches the same menu, makes batch blocking options separately, only preps smoothies in slots 3-4, and ends with completion', () => {
    assert.deepEqual(steps([
      order('#101'),
      order('#102', { channel: 'takeout', menu_items: [line('iced_americano', 2, ['ice_less', 'no_straw'])] }),
      order('#103', { menu_items: [line('iced_americano', 1, ['decaf'])] }),
      order('#104', { menu_items: [line('strawberry_smoothie', 1), line('iced_americano', 1)] }),
    ]), [
      'make: 아이스 아메리카노 3잔 만들기 → #101 1잔 · #102 2잔(얼음 적게)',
      'make: 아이스 아메리카노 1잔 따로 만들기 (디카페인) → #103',
      'prep: 딸기 스무디 1잔 재료만 준비 → #104 1잔',
      'pack: #101 내기',
      'done: 주문 #101 완료',
    ]);
  });

  it('blends smoothies in slots 1-2 and puts the earliest rider first', () => {
    assert.deepEqual(steps([
      order('#101', { menu_items: [line('latte', 1)] }),
      order('#102', { channel: 'delivery', rider_eta_at: new Date(now + 60_000).toISOString(), menu_items: [line('strawberry_smoothie', 1)] }),
    ]), [
      'make: 딸기 스무디 1잔 갈기 → #102 1잔',
      'make: 카페 라떼 1잔 만들기 → #101 1잔',
      'pack: #101 내기',
      'done: 주문 #101 완료',
    ]);
  });

  it('only packs a made head, starting the self-stopping shot extraction first', () => {
    assert.deepEqual(steps([
      order('#101', { made: true, channel: 'takeout', request_note: '캐리어에 담아 주세요' }),
      order('#102', { made: true }),
      order('#103', { menu_items: [line('latte', 2)] }),
    ]), [
      'prep: 샷 추출 시작 (4샷, 자동으로 멈춤) · 그동안 아래 포장',
      'pack: #101 포장 · 메모 "캐리어에 담아 주세요"',
      'make: 카페 라떼 2잔 만들기 → #103 2잔',
      'done: 주문 #101 완료',
    ]);
  });

  it('holds blocked orders instead of listing their drinks', () => {
    const blocked = buildWorkWindow([order('#101'), order('#102', { menu_items: [line('strawberry_smoothie', 1)] })], menuCatalog, (o) => (o.order_id === '#102' ? '블렌더 고장으로 보류' : undefined));
    assert.deepEqual(blocked.map(({ text }) => text), ['#102 보류 · 블렌더 고장으로 보류', '아이스 아메리카노 1잔 만들기 → #101 1잔', '#101 내기', '주문 #101 완료']);
    assert.deepEqual(blocked[0].orders, []);
  });

  it('makes drinks of the same group (data/menu_groups.json) back to back and tags each step with its group', () => {
    const window = buildWorkWindow([order('#101'), order('#102', { menu_items: [line('lemon_ade', 1)] }), order('#103', { menu_items: [line('latte', 1)] })], menuCatalog);
    assert.deepEqual(window.map(({ text, group }) => `${text} [${group?.id ?? '-'}]`), [
      '아이스 아메리카노 1잔 만들기 → #101 1잔 [g1]',
      '카페 라떼 1잔 만들기 → #103 1잔 [g1]',
      '레몬에이드 1잔 만들기 → #102 1잔 [g2]',
      '#101 내기 [-]',
      '주문 #101 완료 [-]',
    ]);
  });

  it('does not chain a group ahead of a step with an earlier rider', () => {
    assert.deepEqual(steps([
      order('#101'),
      order('#102', { channel: 'delivery', rider_eta_at: new Date(now + 60_000).toISOString(), menu_items: [line('lemon_ade', 1)] }),
      order('#103', { menu_items: [line('latte', 1)] }),
    ]), [
      'make: 레몬에이드 1잔 만들기 → #102 1잔',
      'make: 아이스 아메리카노 1잔 만들기 → #101 1잔',
      'make: 카페 라떼 1잔 만들기 → #103 1잔',
      'pack: #101 내기',
      'done: 주문 #101 완료',
    ]);
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
    assert.deepEqual(sharedBoardOrders.map(({ order_id: id }) => id), ids);
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
