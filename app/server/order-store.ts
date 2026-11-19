import { toAiStoreState, toPickRequest } from '../ai/contract.ts';
import { boardEtas, remainingSeconds, rulePickNext, type BoardConfig } from '../domain/board.ts';
import { ownerRules as defaultOwnerRules } from '../domain/catalog-data.ts';
import { interpretEvent } from '../domain/events.ts';
import { buildFacts, lockedLine, type Fact } from '../domain/facts.ts';
import {
  lineName, lineUsesEquipment, maxOrderCups, normalizeLine, optionNames, orderPrice, orderWorkSeconds, stockNeeded, type MenuCatalog,
} from '../domain/menu.ts';
import { defaultScenarioId, findScenario, scenarios, type SignalPatch } from '../domain/scenarios.ts';
import type {
  Channel, Decision, EventCategory, MenuItemInput, Order, OrderLine, OrderSource, OwnerRules, Signals, Slot4Info, StoreEvent, Tip, WorkStep,
} from '../domain/types.ts';
import { channelLabels, riderLabels, sourceLabels, type BoardSnapshot, type OrderView } from '../domain/views.ts';
import { buildWorkWindow } from '../domain/work-window.ts';
import type { AiClient } from './aiserver.ts';

// 주문·보드·매장 상태의 단일 저장소. 키오스크·배달·대시보드는 모두 이 저장소를 API로 바꾸고, 바뀔 때마다 스냅샷을 구독자에게 보낸다.
// 저장 위치는 Next.js 서버 메모리다. 서버를 다시 띄우면 기본 시나리오로 돌아간다.
//
// 보드 순서는 고정칸(1~4번) 완료 때만 바뀐다. 2~4번을 당기고, 대기 5~8번 중 하나를 골라 4번에 넣는다.
// 룰 선택을 먼저 넣고("확인 중"), aiserver /ai/pick-next(Zoro) 답이 타임아웃 안에 오면 바꾼다.
// 새 주문은 맨 뒤에 붙기만 하고, 요청사항·매장 이벤트는 카드 내용만 바꾼다.

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
  slot4?: Slot4Info;
  workWindow: WorkStep[];
};

type Deps = { catalog: MenuCatalog; config: BoardConfig; ai?: AiClient; now?: () => number; decideDelayMs?: number; ownerRules?: OwnerRules };

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
  private pickPending: Promise<void> = Promise.resolve();
  // 4번 고르기 순번. 기다리는 사이 또 완료되면 늦게 온 Zoro 답을 버린다.
  private pickSeq = 0;
  // 확인 중인 4번 고르기의 후보. Zoro 답보다 다음 완료가 먼저 오면 룰 선택으로 확정하며 밀린 횟수를 센다.
  private pickCandidates: string[] = [];
  private readonly now: () => number;
  private readonly deps: Deps;
  private readonly rules: OwnerRules;

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.rules = deps.ownerRules ?? defaultOwnerRules;
    this.loadScenario(defaultScenarioId);
  }

  subscribe(listener: (snapshot: BoardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // 테스트와 시나리오 재생에서 AI 판단(팁, 4번 고르기)이 끝날 때까지 기다린다.
  async settle(): Promise<void> {
    while (this.decideTimer !== undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([this.pending, this.pickPending]);
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
    this.pickSeq += 1;
    this.pickCandidates = [];
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
      decision: { state_version: 0, source: 'rule', fallback: true, ai_status: this.deps.ai ? 'unavailable' : 'disabled', decided_at: new Date(now).toISOString() },
      scenarioId: scenario.id,
      workWindow: [],
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
    // 새 주문은 맨 뒤 빈칸에 붙는다. 5~8번은 들어온 순서를 유지하고, 8칸이 차면 화면 밖 대기열로 간다.
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
      const index = this.state.board.indexOf(orderId);
      if (index >= 0) this.state.board.splice(index, 1);
      this.markWindowDone(orderId);
      // 고정칸(1~4번)이 비면 2~4번이 당겨지고 4번을 새로 고른다. 1번이 아닌 고정 주문이 먼저 끝나도(라이더가 먼저 와서 가져감) 같다.
      if (index >= 0 && index < this.deps.config.lockedCount) this.fillSlot4();
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

    // 요청사항·메시지는 해당 카드 내용만 바꾼다. 1~4번 주문이면 commit에서 작업창을 다시 쓰고, 5~8번이면 다음 완료 때 사실 문장에 반영된다.
    for (const effect of interpretation.effects) {
      if (effect.type === 'tip') {
        this.state.ruleTips = [...this.state.ruleTips.filter(({ id }) => id !== effect.tip.id), effect.tip];
      } else if (effect.type === 'clear_tip') {
        this.state.ruleTips = this.state.ruleTips.filter(({ id }) => id !== effect.tip_id);
      } else if (effect.type === 'equipment') {
        this.state.signals.store.equipment_status[effect.equipment] = effect.status;
      } else if (activeTarget && effect.order_id === activeTarget.order_id && activeTarget.channel === 'delivery') {
        if (effect.type === 'rider_status') this.setRiderStatus(activeTarget, effect.status);
        if (effect.type === 'pickup_eta') {
          activeTarget.pickup_eta_seconds = effect.seconds;
          // "지금부터 몇 초 뒤"는 받는 순간 시각으로 바꿔 둔다. 다음 완료 때 남은 시간을 다시 계산한다.
          activeTarget.rider_eta_at = new Date(this.now() + effect.seconds * 1000).toISOString();
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
    const board = this.state.board.map((id, index): OrderView => ({
      ...this.view(this.state.orders.get(id)!),
      slot: index + 1,
      zone: index < config.lockedCount ? 'locked' : index < config.visibleCount ? 'flexible' : 'queue',
      eta_seconds: etas.get(id),
    }));
    const all = [...this.state.orders.values()];
    const scenario = findScenario(this.state.scenarioId);
    const tipIds = new Set(this.state.ruleTips.map(({ id }) => id));
    const { slot4 } = this.state;
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
      // 4번 칸에 있는 주문의 고르기 정보만 보낸다(다음 완료로 3번이 되면 빠진다).
      slot4: slot4 && this.state.board[config.lockedCount - 1] === slot4.order_id ? structuredClone(slot4) : undefined,
      work_window: structuredClone(this.state.workWindow),
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

  // 재고 저장소(SQLite)의 현재 재고로 주문 받을 수 있는 원두 샷과 딸기 인분을 다시 계산한다.
  // 보드와 대기열에 남은 주문이 쓸 양은 미리 뺀다. 값이 같으면 아무것도 하지 않는다.
  syncStock(onHand: { espresso_shot: number; strawberry_servings: number }): void {
    const active = this.state.board.flatMap((id) => this.state.orders.get(id)?.menu_items ?? []);
    const reserved = stockNeeded(this.deps.catalog, active);
    const next = {
      coffee_beans_shots_left: Math.max(0, Math.floor(onHand.espresso_shot - reserved.espresso_shot)),
      strawberry_servings_left: Math.max(0, Math.round((onHand.strawberry_servings - reserved.strawberry_servings) * 100) / 100),
    };
    const { inventory } = this.state.signals;
    if (inventory.coffee_beans_shots_left === next.coffee_beans_shots_left && inventory.strawberry_servings_left === next.strawberry_servings_left) return;
    Object.assign(inventory, next);
    this.commit({ decide: false });
  }

  private patchSignals(patch: SignalPatch): void {
    if (patch.inventory) Object.assign(this.state.signals.inventory, patch.inventory);
    for (const [orderId, status] of Object.entries(patch.rider_status ?? {})) {
      const order = this.state.orders.get(orderId);
      if (order?.channel === 'delivery' && order.status !== 'done') this.setRiderStatus(order, status);
    }
  }

  // 라이더가 도착하면 도착 시각을 지금으로 당긴다(예정보다 일찍 온 경우).
  private setRiderStatus(order: Order, status: NonNullable<Order['rider_status']>): void {
    order.rider_status = status;
    if (status !== 'arrived') return;
    const now = this.now();
    if (!order.rider_eta_at || Date.parse(order.rider_eta_at) > now) order.rider_eta_at = new Date(now).toISOString();
  }

  private blockedReason(order: Order): string | undefined {
    const { equipment_status: equipment } = this.state.signals.store;
    const broken = Object.keys(equipment).find((name) => equipment[name] === 'broken' && order.menu_items.some((line) => lineUsesEquipment(this.deps.catalog, line, name)));
    return broken ? `${equipmentLabels[broken] ?? broken} 고장으로 보류` : undefined;
  }

  private isBlocked = (order: Order): boolean => this.blockedReason(order) !== undefined;

  // ---- 4번 칸 고르기 ----

  // 당겨진 뒤의 보드에서 4번을 채운다. 후보는 기존 5~8번(지금은 4~7번 칸)의 대기 주문 중 만들 수 있는 주문이다.
  private fillSlot4(): void {
    const L = this.deps.config.lockedCount;
    // Zoro 답보다 다음 완료가 먼저 왔으면 그때 넣은 룰 선택으로 확정하고 밀린 횟수를 센다.
    if (this.state.slot4?.status === 'checking') this.countOvertaken(this.pickCandidates, this.state.slot4.order_id);
    this.state.slot4 = undefined;
    this.pickCandidates = [];
    const seq = ++this.pickSeq;
    const board = this.state.board;
    const locked = board.slice(0, L - 1);
    const pool = board.slice(L - 1, this.deps.config.visibleCount - 1);
    const candidates = pool.filter((id) => {
      const order = this.state.orders.get(id)!;
      return order.status === 'waiting' && !this.isBlocked(order);
    });
    if (!candidates.length) return;
    const facts = buildFacts(locked, candidates, this.factContext());
    const rule = rulePickNext(candidates, this.state.orders, facts, this.rules.limits);
    const factLines = Object.fromEntries([...facts].map(([id, fact]) => [id, fact.line]));
    // 후보가 하나면 고를 것이 없어 Zoro에 묻지 않는다.
    const ai = candidates.length > 1 ? this.deps.ai : undefined;
    this.placeAt4(rule, { source: 'rule', status: ai ? 'checking' : 'final', rule_pick: rule, facts: factLines });
    if (ai) {
      this.pickCandidates = candidates;
      this.pickPending = this.askZoro(ai, seq, locked, candidates, facts, rule);
    } else {
      this.countOvertaken(candidates, rule);
    }
  }

  // pick을 4번 칸에 넣는다. 나머지 대기 주문은 들어온 순서로 둔다(4번으로 가는 주문만 움직인다).
  private placeAt4(pick: string, info: Omit<Slot4Info, 'order_id'>): void {
    const L = this.deps.config.lockedCount;
    const rest = this.state.board.filter((id) => id !== pick);
    const waiting = rest.slice(L - 1).sort((a, b) => this.arrival(a) - this.arrival(b));
    this.state.board = [...rest.slice(0, L - 1), pick, ...waiting];
    this.state.slot4 = { ...info, order_id: pick };
  }

  // 들어온 순서. 접수 시각이 같으면 주문 번호 순서다.
  private arrival(id: string): number {
    return Date.parse(this.state.orders.get(id)!.received_at) * 1000 + (Number(id.replace(/[^0-9]/g, '')) % 1000);
  }

  private async askZoro(ai: AiClient, seq: number, locked: string[], candidates: string[], facts: Map<string, Fact>, rule: string): Promise<void> {
    const context = this.factContext();
    const request = toPickRequest({
      now: context.now,
      baristas: this.state.signals.store.staff_count,
      ownerRules: this.rules.sentences,
      locked: locked.map((id) => ({ id, facts: lockedLine(this.state.orders.get(id)!, context) })),
      candidates,
      facts,
      rulePick: rule,
    });
    const res = await ai.pickNext(request);
    if (seq !== this.pickSeq) return;                                        // 기다리는 사이 또 완료됐으면 버린다
    const L = this.deps.config.lockedCount;
    const current = this.state.slot4;
    if (this.state.board[L - 1] !== rule || current?.status !== 'checking') return;   // 그 사이 4번이 바뀌었으면 버린다
    if (res.ok && res.data.source === 'zoro' && candidates.includes(res.data.pick)) {
      const info = { ...current, source: 'zoro' as const, status: 'final' as const, confidence: res.data.confidence, scores: res.data.scores };
      if (res.data.pick !== rule) this.placeAt4(res.data.pick, info);
      else this.state.slot4 = { ...info, order_id: rule };
    } else {
      // Zoro 실패, 확신 낮음(source: rule), 후보 밖 id → 룰 선택 그대로
      this.state.slot4 = { ...current, status: 'final', ...(res.ok ? { confidence: res.data.confidence, scores: res.data.scores } : {}) };
      if (!res.ok) console.warn(`[order-store] pick-next fell back to rule: ${res.error}`);
    }
    this.pickCandidates = [];
    this.countOvertaken(candidates, this.state.board[L - 1]);
    this.commit({ decide: false });
  }

  // pick보다 먼저 접수된 후보는 한 번 밀린 것으로 센다.
  private countOvertaken(candidates: string[], pick: string): void {
    const pickedAt = this.arrival(pick);
    for (const id of candidates) {
      const order = this.state.orders.get(id);
      if (!order || id === pick || this.arrival(id) >= pickedAt) continue;
      order.overtaken = (order.overtaken ?? 0) + 1;
    }
  }

  private factContext() {
    return { orders: this.state.orders, catalog: this.deps.catalog, limits: this.rules.limits, now: this.now() };
  }

  // ---- 작업창 ----

  private rebuildWorkWindow(): void {
    const top4 = this.state.board.slice(0, this.deps.config.lockedCount).map((id) => this.state.orders.get(id)!);
    this.state.workWindow = buildWorkWindow(top4, this.deps.catalog, (order) => this.blockedReason(order));
  }

  // 작업창 마지막 줄(1번 완료)을 누르면 위 단계는 다 한 것으로 본다. make 단계의 주문은 made, prep 단계는 prepped가 된다.
  // 1번이 아닌 주문이 먼저 완료되면(라이더가 먼저 와서 가져감) 작업창 단계는 한 것으로 보지 않는다.
  private markWindowDone(orderId: string): void {
    const steps = this.state.workWindow;
    const last = steps.at(-1);
    if (last?.kind !== 'done' || last.orders[0] !== orderId) return;
    for (const step of steps) {
      for (const id of step.orders) {
        const order = this.state.orders.get(id);
        if (!order || order.status === 'done') continue;
        if (step.kind === 'make') order.made = true;
        if (step.kind === 'prep') order.prepped = true;
      }
    }
  }

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
      rider_eta_at: order.rider_eta_at,
      overtaken: order.overtaken ?? 0,
      made: order.made ?? false,
      prepped: order.prepped ?? false,
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

  // 상태가 바뀌면 버전을 올리고 작업창을 다시 쓴 뒤 구독자에게 보낸다. 보드 순서는 여기서 바꾸지 않는다.
  // 작업창은 1~4번 주문만 보므로 5~8번이나 대기열만 바뀌면 같은 줄이 나온다.
  // aiserver가 있으면 /ai/decide를 팁 용도로만 부른다(응답의 orders는 반영하지 않는다).
  private commit(options: { decide?: boolean } = {}): void {
    this.state.version += 1;
    this.rebuildWorkWindow();
    this.notify();
    if (!this.deps.ai || options.decide === false) return;
    if (this.decideTimer) clearTimeout(this.decideTimer);
    this.decideTimer = setTimeout(() => {
      this.decideTimer = undefined;
      this.pending = this.runDecide();
    }, this.deps.decideDelayMs ?? 250);
  }

  private async runDecide(): Promise<void> {
    const ai = this.deps.ai;
    if (!ai) return;
    const version = this.state.version;
    const boardOrders = this.state.board.slice(0, this.deps.config.visibleCount).map((id) => this.state.orders.get(id)!);
    const request = toAiStoreState(boardOrders, this.state.signals, { describe: this.describe, remainingSeconds: (order) => remainingSeconds(order, this.now()) });
    const result = await ai.decide(request);
    // 판단 중에 상태가 바뀌었으면 늦게 온 응답을 버린다. 새 상태의 판단은 이미 예약돼 있다(INV-04).
    if (this.state.version !== version) return;
    this.state.aiTips = result.ok ? [
      ...result.data.tips.map(({ id, text, confidence, source }) => ({ id, text, confidence, source })),
      ...result.data.feed.map(({ category, text, confidence, source }, index) => ({ id: `feed-${category}-${index}`, text, confidence, source })),
    ] : [];
    const zoro = result.ok && !result.data.fallback && [...result.data.tips, ...result.data.feed].some(({ source }) => source === 'zoro');
    this.state.decision = {
      state_version: this.state.version + 1,
      source: zoro ? 'zoro' : 'rule',
      fallback: !result.ok || result.data.fallback,
      ai_status: result.ok ? 'connected' : 'unavailable',
      ai_error: result.ok ? undefined : result.error,
      decided_at: new Date(this.now()).toISOString(),
    };
    this.commit({ decide: false });
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
