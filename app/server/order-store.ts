import { toAiStoreState } from '../ai/contract.ts';
import {
  applyAiOrder, boardEtas, diffMoves, flexibleRange, moveReasonLabels, remainingSeconds, ruleArrange, type BoardConfig,
} from '../domain/board.ts';
import { interpretEvent } from '../domain/events.ts';
import {
  lineName, lineUsesEquipment, maxOrderCups, normalizeLine, optionNames, orderPrice, orderWorkSeconds, stockNeeded, type MenuCatalog,
} from '../domain/menu.ts';
import { defaultScenarioId, findScenario, scenarios, type SignalPatch } from '../domain/scenarios.ts';
import type {
  Channel, Decision, EventCategory, MenuItemInput, Move, Order, OrderLine, OrderSource, Signals, StoreEvent, Tip,
} from '../domain/types.ts';
import { channelLabels, riderLabels, sourceLabels, type BoardSnapshot, type OrderView } from '../domain/views.ts';
import type { AiClient } from './aiserver.ts';

// 주문·보드·매장 상태의 단일 저장소. 키오스크·배달·대시보드는 모두 이 저장소를 API로 바꾸고, 바뀔 때마다 스냅샷을 구독자에게 보낸다.
// 저장 위치는 Next.js 서버 메모리다. 서버를 다시 띄우면 기본 시나리오로 돌아간다.

export type CreateOrderInput = {
  request_id?: string;
  channel: Channel;
  source: OrderSource;
  menu_items: MenuItemInput[];
  request_note?: string;
};

export type StoreError = { error: string; status: 400 | 404 | 409 };

type State = {
  version: number;
  orders: Map<string, Order>;
  board: string[];
  nextNumber: number;
  signals: Signals;
  ruleTips: Tip[];
  aiTips: Tip[];
  events: StoreEvent[];
  eventIds: Set<string>;
  requestIds: Map<string, string>;
  decision: Decision;
  scenarioId: string;
};

type Deps = { catalog: MenuCatalog; config: BoardConfig; ai?: AiClient; now?: () => number; decideDelayMs?: number };

const channels: Channel[] = ['dine-in', 'takeout', 'delivery'];
const sources: OrderSource[] = ['kiosk', 'delivery_app', 'demo', 'scenario'];
const equipmentLabels: Record<string, string> = { blender: '블렌더', espresso_machine: '에스프레소 머신', steam_wand: '스팀 완드' };

function defaultSignals(): Signals {
  return {
    inventory: { coffee_beans_shots_left: 200, strawberry_servings_left: 30 },
    store: { equipment_status: { espresso_machine: 'ok', steam_wand: 'ok', blender: 'ok' }, staff_count: 2 },
    delivery: { weather: '맑음' },
  };
}

export class OrderStore {
  private state!: State;
  private readonly listeners = new Set<(snapshot: BoardSnapshot) => void>();
  private decideTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.loadScenario(defaultScenarioId);
  }

  subscribe(listener: (snapshot: BoardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // 테스트와 시나리오 재생에서 AI 판단이 끝날 때까지 기다린다.
  async settle(): Promise<void> {
    while (this.decideTimer !== undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    await this.pending;
  }

  loadScenario(id: string): StoreError | undefined {
    const scenario = findScenario(id);
    if (!scenario) return { error: `시나리오를 찾을 수 없어요: ${id}`, status: 404 };
    const now = this.now();
    const orders = new Map<string, Order>();
    for (const seed of scenario.orders) {
      const lines = seed.menu_items.map((item) => normalizeLine(this.deps.catalog, item)).flatMap((result) => ('line' in result ? [result.line] : []));
      orders.set(seed.order_id, {
        order_id: seed.order_id,
        channel: seed.channel,
        source: 'scenario',
        menu_items: lines,
        received_at: new Date(now - seed.waiting_seconds * 1000).toISOString(),
        status: 'waiting',
        rider_status: seed.channel === 'delivery' ? seed.rider_status ?? 'not_dispatched' : undefined,
        pickup_eta_seconds: seed.channel === 'delivery' ? null : undefined,
        remaining_work_seconds: orderWorkSeconds(this.deps.catalog, lines),
        price_krw: orderPrice(this.deps.catalog, lines),
      });
    }
    const numbers = scenario.orders.map(({ order_id: orderId }) => Number(orderId.slice(1)));
    if (this.decideTimer) clearTimeout(this.decideTimer);
    this.decideTimer = undefined;
    this.state = {
      version: (this.state?.version ?? 0) + 1,
      orders,
      board: scenario.orders.map(({ order_id: orderId }) => orderId),
      nextNumber: numbers.length ? Math.max(...numbers) + 1 : 101,
      signals: defaultSignals(),
      ruleTips: [],
      aiTips: [],
      events: [],
      eventIds: new Set(),
      requestIds: new Map(),
      decision: { state_version: 0, source: 'rule', fallback: true, ai_status: this.deps.ai ? 'unavailable' : 'disabled', moves: [], decided_at: new Date(now).toISOString() },
      scenarioId: scenario.id,
    };
    this.commit();
    return undefined;
  }

  async runTrigger(scenarioId: string, index: number): Promise<StoreError | undefined> {
    const scenario = findScenario(scenarioId);
    const trigger = scenario?.triggers[index];
    if (!scenario || !trigger) return { error: '시나리오 트리거를 찾을 수 없어요.', status: 404 };
    if (this.state.scenarioId !== scenarioId) return { error: '먼저 이 시나리오를 불러와 주세요.', status: 409 };
    const eventId = `${scenarioId}-${index}`;
    if (trigger.kind === 'order') {
      const result = this.createOrder({ request_id: eventId, channel: trigger.channel, source: 'scenario', menu_items: trigger.menu_items });
      return 'error' in result ? result : undefined;
    }
    if (trigger.kind === 'signal') {
      this.applySignal(trigger.signal);
      return undefined;
    }
    if (trigger.signal) this.patchSignals(trigger.signal);
    const result = this.addEvent({ event_id: eventId, raw_text: trigger.raw_text, order_id: trigger.order_id, category: trigger.category });
    return 'error' in result ? result : undefined;
  }

  createOrder(input: CreateOrderInput): { order: OrderView; wait_seconds: number; duplicate: boolean } | StoreError {
    const existing = input.request_id ? this.state.requestIds.get(input.request_id) : undefined;
    if (existing) {
      const order = this.state.orders.get(existing)!;
      return { order: this.view(order), wait_seconds: boardEtas(this.state.board, this.state.orders, this.now()).get(existing) ?? 0, duplicate: true };
    }
    if (!channels.includes(input.channel)) return { error: `channel은 ${channels.join(', ')} 중 하나여야 해요.`, status: 400 };
    if (!sources.includes(input.source)) return { error: `source는 ${sources.join(', ')} 중 하나여야 해요.`, status: 400 };
    if (!Array.isArray(input.menu_items) || input.menu_items.length === 0 || input.menu_items.length > 20) return { error: 'menu_items는 1~20개여야 해요.', status: 400 };
    if (input.request_note !== undefined && (typeof input.request_note !== 'string' || input.request_note.length > 200)) return { error: '요청사항은 200자 이하여야 해요.', status: 400 };

    const lines: OrderLine[] = [];
    for (const item of input.menu_items) {
      const result = normalizeLine(this.deps.catalog, item);
      if ('error' in result) return { error: result.error, status: 400 };
      lines.push(result.line);
    }
    const cups = lines.reduce((sum, line) => sum + line.qty, 0);
    if (cups > maxOrderCups) return { error: `한 주문은 ${maxOrderCups}잔까지 받을 수 있어요.`, status: 400 };

    const unavailable = this.availability();
    const blocked = lines.find((line) => unavailable[line.menu]);
    if (blocked) return { error: `${lineName(this.deps.catalog, blocked)}: ${unavailable[blocked.menu]}`, status: 409 };
    const needed = stockNeeded(this.deps.catalog, lines);
    const { inventory } = this.state.signals;
    if (needed.espresso_shot > inventory.coffee_beans_shots_left) return { error: `원두가 부족해요(남은 ${inventory.coffee_beans_shots_left}샷).`, status: 409 };
    if (needed.strawberry_servings > inventory.strawberry_servings_left) return { error: `딸기가 부족해요(남은 ${inventory.strawberry_servings_left}인분).`, status: 409 };

    const orderId = `#${this.state.nextNumber}`;
    const order: Order = {
      order_id: orderId,
      channel: input.channel,
      source: input.source,
      menu_items: lines,
      received_at: new Date(this.now()).toISOString(),
      status: 'waiting',
      request_note: input.request_note?.trim() || undefined,
      rider_status: input.channel === 'delivery' ? 'not_dispatched' : undefined,
      pickup_eta_seconds: input.channel === 'delivery' ? null : undefined,
      remaining_work_seconds: orderWorkSeconds(this.deps.catalog, lines),
      price_krw: orderPrice(this.deps.catalog, lines),
      request_id: input.request_id,
    };
    this.state.nextNumber += 1;
    this.state.orders.set(orderId, order);
    this.state.board.push(orderId);
    if (input.request_id) this.state.requestIds.set(input.request_id, orderId);
    inventory.coffee_beans_shots_left -= needed.espresso_shot;
    inventory.strawberry_servings_left = Math.round((inventory.strawberry_servings_left - needed.strawberry_servings) * 100) / 100;
    this.commit();
    return { order: this.view(order), wait_seconds: boardEtas(this.state.board, this.state.orders, this.now()).get(orderId) ?? 0, duplicate: false };
  }

  updateOrderStatus(orderId: string, action: 'start' | 'complete'): { order: OrderView } | StoreError {
    const order = this.state.orders.get(orderId);
    if (!order) return { error: `${orderId} 주문이 없어요.`, status: 404 };
    if (order.status === 'done') return { error: `${orderId}은(는) 이미 완료된 주문이에요.`, status: 409 };
    const now = new Date(this.now()).toISOString();
    if (action === 'start') {
      if (order.status === 'in_progress') return { order: this.view(order) };
      const blocked = this.blockedReason(order);
      if (blocked) return { error: `${orderId}: ${blocked}`, status: 409 };
      order.status = 'in_progress';
      order.started_at = now;
    } else {
      order.status = 'done';
      order.completed_at = now;
      // 완료된 카드가 빠지면 뒤 칸이 당겨지고, 5번으로 올라온 주문은 그 순간부터 고정된다(kds_board.promotion_rule).
      this.state.board = this.state.board.filter((id) => id !== orderId);
    }
    this.commit();
    return { order: this.view(order) };
  }

  addEvent(input: { event_id: string; raw_text: string; order_id?: string; category?: EventCategory }): { event: StoreEvent; duplicate: boolean } | StoreError {
    const text = typeof input.raw_text === 'string' ? input.raw_text.trim() : '';
    if (!text || text.length > 300) return { error: '상황 입력은 1~300자여야 해요.', status: 400 };
    if (typeof input.event_id !== 'string' || !input.event_id || input.event_id.length > 100) return { error: 'event_id가 필요해요.', status: 400 };
    // 같은 이벤트 ID의 재전송은 다시 처리하지 않는다(INV-03).
    if (this.state.eventIds.has(input.event_id)) {
      const event = this.state.events.find(({ event_id: id }) => id === input.event_id);
      if (event) return { event, duplicate: true };
    }

    const interpretation = interpretEvent(text, input.order_id, input.category);
    const target = interpretation.order_id ? this.state.orders.get(interpretation.order_id) : undefined;
    const activeTarget = target && target.status !== 'done' ? target : undefined;
    let summary = interpretation.summary;
    if (interpretation.order_id && !activeTarget && interpretation.effects.some((effect) => 'order_id' in effect)) {
      summary = `${interpretation.order_id}은(는) 진행 중인 주문이 아니에요`;
    }

    for (const effect of interpretation.effects) {
      if (effect.type === 'tip') {
        this.state.ruleTips = [...this.state.ruleTips.filter(({ id }) => id !== effect.tip.id), effect.tip];
      } else if (effect.type === 'clear_tip') {
        this.state.ruleTips = this.state.ruleTips.filter(({ id }) => id !== effect.tip_id);
      } else if (effect.type === 'equipment') {
        this.state.signals.store.equipment_status[effect.equipment] = effect.status;
      } else if (activeTarget && effect.order_id === activeTarget.order_id && activeTarget.channel === 'delivery') {
        if (effect.type === 'rider_status') activeTarget.rider_status = effect.status;
        if (effect.type === 'pickup_eta') {
          activeTarget.pickup_eta_seconds = effect.seconds;
          activeTarget.eta_confirmed = true;
          activeTarget.needs_confirmation = false;
        }
        if (effect.type === 'needs_confirmation') {
          activeTarget.needs_confirmation = true;
          activeTarget.eta_confirmed = false;
        }
      } else if (activeTarget && 'order_id' in effect) {
        summary = `${activeTarget.order_id}은(는) 배달 주문이 아니에요`;
      }
    }

    const event: StoreEvent = {
      event_id: input.event_id,
      raw_text: text,
      order_id: interpretation.order_id,
      category: interpretation.category,
      needs_confirmation: interpretation.needs_confirmation,
      summary,
      received_at: new Date(this.now()).toISOString(),
    };
    this.state.eventIds.add(input.event_id);
    this.state.events = [event, ...this.state.events].slice(0, 20);
    this.commit();
    void this.classify(event);
    return { event, duplicate: false };
  }

  applySignal(patch: SignalPatch): void {
    this.patchSignals(patch);
    this.commit();
  }

  dismissTip(id: string): StoreError | undefined {
    const before = this.state.ruleTips.length + this.state.aiTips.length;
    this.state.ruleTips = this.state.ruleTips.filter((tip) => tip.id !== id);
    this.state.aiTips = this.state.aiTips.filter((tip) => tip.id !== id);
    if (before === this.state.ruleTips.length + this.state.aiTips.length) return { error: `팁을 찾을 수 없어요: ${id}`, status: 404 };
    this.commit({ decide: false });
    return undefined;
  }

  snapshot(): BoardSnapshot {
    const { config } = this.deps;
    const now = this.now();
    const etas = boardEtas(this.state.board, this.state.orders, now);
    const [, flexibleEnd] = flexibleRange(this.state.board, config);
    const moveReasons = new Map(this.state.decision.moves.map((move) => [move.order_id, moveReasonLabels[move.reason] ?? move.reason]));
    const board = this.state.board.map((id, index): OrderView => ({
      ...this.view(this.state.orders.get(id)!),
      slot: index + 1,
      zone: index < config.lockedCount ? 'locked' : index < flexibleEnd ? 'flexible' : 'queue',
      move_reason: moveReasons.get(id),
      eta_seconds: etas.get(id),
    }));
    const all = [...this.state.orders.values()];
    const scenario = findScenario(this.state.scenarioId);
    const tipIds = new Set(this.state.ruleTips.map(({ id }) => id));
    return {
      state_version: this.state.version,
      server_time: new Date(now).toISOString(),
      board,
      history: all.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at) || b.order_id.localeCompare(a.order_id)).slice(0, 40).map((order) => this.view(order)),
      counts: {
        waiting: all.filter(({ status }) => status === 'waiting').length,
        in_progress: all.filter(({ status }) => status === 'in_progress').length,
        done: all.filter(({ status }) => status === 'done').length,
      },
      decision: this.state.decision,
      tips: [...this.state.ruleTips, ...this.state.aiTips.filter(({ id }) => !tipIds.has(id))],
      events: this.state.events.slice(0, 8),
      signals: structuredClone(this.state.signals),
      scenario: scenario ? { id: scenario.id, title: scenario.title, source: scenario.source, description: scenario.description, expected: scenario.expected, triggers: scenario.triggers.map(({ label }) => label) } : null,
      scenarios: scenarios.map(({ id, title }) => ({ id, title })),
      availability: this.availability(),
      config: { lockedCount: config.lockedCount, visibleCount: config.visibleCount },
    };
  }

  availability(): Record<string, string> {
    const { equipment_status: equipment } = this.state.signals.store;
    const { inventory } = this.state.signals;
    const result: Record<string, string> = {};
    for (const drink of this.deps.catalog.drinks) {
      const broken = drink.equipment.find((name) => equipment[name] === 'broken');
      if (broken) result[drink.id] = `${equipmentLabels[broken] ?? broken} 점검 중`;
      else if (drink.strawberry_servings > inventory.strawberry_servings_left) result[drink.id] = '딸기 재고 소진';
      else if (drink.espresso_shots > inventory.coffee_beans_shots_left) result[drink.id] = '원두 재고 소진';
    }
    return result;
  }

  private patchSignals(patch: SignalPatch): void {
    if (patch.inventory) Object.assign(this.state.signals.inventory, patch.inventory);
    for (const [orderId, status] of Object.entries(patch.rider_status ?? {})) {
      const order = this.state.orders.get(orderId);
      if (order?.channel === 'delivery' && order.status !== 'done') order.rider_status = status;
    }
  }

  private blockedReason(order: Order): string | undefined {
    const { equipment_status: equipment } = this.state.signals.store;
    const broken = Object.keys(equipment).find((name) => equipment[name] === 'broken' && order.menu_items.some((line) => lineUsesEquipment(this.deps.catalog, line, name)));
    return broken ? `${equipmentLabels[broken] ?? broken} 고장으로 보류` : undefined;
  }

  private isBlocked = (order: Order): boolean => this.blockedReason(order) !== undefined;

  private view(order: Order): OrderView {
    const { catalog } = this.deps;
    return {
      order_id: order.order_id,
      channel: order.channel,
      channel_label: channelLabels[order.channel],
      source: order.source,
      source_label: sourceLabels[order.source],
      status: order.status,
      items: order.menu_items.map((line) => ({ name: lineName(catalog, line), qty: line.qty, options: optionNames(catalog, line.options) })),
      request_note: order.request_note,
      rider_status: order.rider_status,
      rider_label: order.rider_status ? riderLabels[order.rider_status] : undefined,
      pickup_eta_seconds: order.pickup_eta_seconds,
      eta_confirmed: order.eta_confirmed,
      needs_confirmation: order.needs_confirmation,
      received_at: order.received_at,
      started_at: order.started_at,
      completed_at: order.completed_at,
      remaining_work_seconds: Math.round(remainingSeconds(order, this.now())),
      price_krw: order.price_krw,
      blocked_reason: order.status === 'done' ? undefined : this.blockedReason(order),
    };
  }

  private describe = (order: Order): string => order.menu_items
    .map((line) => {
      const options = optionNames(this.deps.catalog, line.options);
      return `${lineName(this.deps.catalog, line)} ${line.qty}잔${options.length ? `(${options.join(', ')})` : ''}`;
    })
    .join(', ');

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[order-store] listener failed', error);
      }
    }
  }

  // 상태가 바뀌면 버전을 올리고 판단을 다시 요청한다. AI 서버가 없으면 규칙으로 바로 정렬한다.
  private commit(options: { decide?: boolean } = {}): void {
    this.state.version += 1;
    if (options.decide === false) {
      this.notify();
      return;
    }
    if (!this.deps.ai) {
      this.applyRule('disabled');
      return;
    }
    this.notify();
    if (this.decideTimer) clearTimeout(this.decideTimer);
    this.decideTimer = setTimeout(() => {
      this.decideTimer = undefined;
      this.pending = this.runDecide();
    }, this.deps.decideDelayMs ?? 250);
  }

  private applyRule(aiStatus: Decision['ai_status'], aiError?: string): void {
    const before = [...this.state.board];
    const { board, moves } = ruleArrange(this.state.board, this.state.orders, this.deps.config, this.isBlocked);
    this.state.board = board;
    this.state.aiTips = [];
    this.state.version += 1;
    this.state.decision = {
      state_version: this.state.version,
      source: 'rule',
      fallback: true,
      ai_status: aiStatus,
      ai_error: aiError,
      moves: before.join() === board.join() ? this.keepMoves(moves) : moves,
      decided_at: new Date(this.now()).toISOString(),
    };
    this.notify();
  }

  // 순서가 그대로면 직전 판단의 이동 사유를 유지한다(새 주문이 들어올 때마다 사유가 사라지지 않게).
  private keepMoves(moves: Move[]): Move[] {
    return moves.length ? moves : this.state.decision.moves.filter(({ order_id: id }) => this.state.board.includes(id));
  }

  private async runDecide(): Promise<void> {
    const ai = this.deps.ai;
    if (!ai) return;
    const version = this.state.version;
    // 재배치는 보드 10칸 안에서만 한다(INV-02). 11번째부터의 대기열은 접수순 그대로 두고 보내지 않는다.
    const boardOrders = this.state.board.slice(0, this.deps.config.visibleCount).map((id) => this.state.orders.get(id)!);
    const request = toAiStoreState(boardOrders, this.state.signals, { describe: this.describe, remainingSeconds: (order) => remainingSeconds(order, this.now()) });
    const result = await ai.decide(request);
    // 판단 중에 상태가 바뀌었으면 늦게 온 응답을 버린다. 새 상태의 판단은 이미 예약돼 있다(INV-04).
    if (this.state.version !== version) return;
    if (!result.ok) {
      this.applyRule('unavailable', result.error);
      return;
    }
    const applied = applyAiOrder(this.state.board, this.state.orders, this.deps.config, this.isBlocked, result.data.orders);
    if ('error' in applied) {
      console.warn(`[order-store] ${applied.error}`);
      this.applyRule('connected', applied.error);
      return;
    }
    const aiMoves = new Map(result.data.moves.map((move) => [move.order_id, move]));
    const before = [...this.state.board];
    const moves = diffMoves(before, applied.board, (id) => {
      const move = aiMoves.get(id);
      if (move) return { reason: move.reason, confidence: move.confidence ?? 0, source: move.source };
      return { reason: this.state.orders.get(id)?.rider_status === 'arrived' ? 'rider_waiting' : 'ai_hint', confidence: 0, source: 'rule' };
    });
    this.state.board = applied.board;
    this.state.aiTips = [
      ...result.data.tips.map(({ id, text, confidence, source }) => ({ id, text, confidence, source })),
      ...result.data.feed.map(({ category, text, confidence, source }, index) => ({ id: `feed-${category}-${index}`, text, confidence, source })),
    ];
    this.state.version += 1;
    this.state.decision = {
      state_version: this.state.version,
      source: result.data.fallback ? 'rule' : [...result.data.moves, ...result.data.tips, ...result.data.feed].some(({ source }) => source === 'zoro') ? 'zoro' : 'rule',
      fallback: result.data.fallback,
      ai_status: 'connected',
      moves: before.join() === applied.board.join() ? this.keepMoves(moves) : moves,
      decided_at: new Date(this.now()).toISOString(),
    };
    this.notify();
  }

  private async classify(event: StoreEvent): Promise<void> {
    const ai = this.deps.ai;
    if (!ai) return;
    const result = await ai.classify(event.raw_text);
    if (!result.ok) return;
    const stored = this.state.events.find(({ event_id: id }) => id === event.event_id);
    if (!stored) return;
    stored.intent = result.data;
    this.notify();
  }
}
