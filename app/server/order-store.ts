import { toAiStoreState, toPickRequest } from '../ai/contract.ts';
import { boardEtas, remainingSeconds, rulePickNext, workLeftSeconds, type BoardConfig } from '../domain/board.ts';
import { ownerRules as defaultOwnerRules } from '../domain/catalog-data.ts';
import { interpretEvent } from '../domain/events.ts';
import { buildFacts, lockedLine, type Fact } from '../domain/facts.ts';
import {
  findDrink,
  lineName, lineUsesEquipment, maxOrderCups, normalizeLine, optionNames, orderPrice, orderWorkSeconds, stockNeeded, type MenuCatalog,
} from '../domain/menu.ts';
import {
  apartText, blockingReason, buildGroupRequest, groupViews, handsSeconds, headNote, idleWindow, isQuickDessert, lineUnit, quickLaneText, zoroText,
} from '../domain/review.ts';
import { defaultScenarioId, findScenario, scenarios, type SignalPatch } from '../domain/scenarios.ts';
import type {
  BoardReview,
  Note,
  QuickLane,
  Channel, Decision, EventCategory, MenuItemInput, Order, OrderLine, OrderSource, OwnerRules, Signals, Slot4Info, StoreEvent, Tip, WorkStep,
} from '../domain/types.ts';
import { channelLabels, riderLabels, sourceLabels, type BoardSnapshot, type OrderView } from '../domain/views.ts';
import { buildWorkWindow } from '../domain/work-window.ts';
import type { AiClient } from './aiserver.ts';

// 주문·보드·매장 상태의 단일 저장소. 키오스크·배달·대시보드는 모두 이 저장소를 API로 바꾸고, 바뀔 때마다 스냅샷을 구독자에게 보낸다.
// 저장 위치는 Next.js 서버 메모리다. 서버를 다시 띄우면 기본 시나리오로 돌아간다.
//
// 보드 순서는 고정칸(1~4번) 완료 때만 바뀐다. 2~4번을 당기고, 대기 5~8번 중 하나를 골라 4번에 넣는다.
// 4번은 aiserver /ai/pick-next(Zoro)가 고른다. 답이 올 때까지 4번은 비워 두고("Zoro 고르는 중"),
// 룰 선택은 Zoro가 답하지 못할 때(aiserver 없음·타임아웃·오류)와 후보가 하나뿐일 때만 쓴다.
// 새 주문은 맨 뒤에 붙기만 하고, 요청사항·매장 이벤트는 카드 내용만 바꾼다.
//
// fifo(data/cafe_db.json kds_board.fifo)면 위 4번 고르기를 끄고 들어온 순서로만 채운다. 이때 Zoro는
// 1번(기준)과 비슷한 2~4번만 판단해(/ai/group-orders anchor) 같은 색으로 묶고, 아래 일머리 팁 칸에 같이 만들 주문을 적는다.
// quickLane이면 8번 칸은 빠른 주문 전용이다. FIFO는 1~7번이고, 8번에는 1~4번 밖(화면 밖 포함)의 첫 디저트 전용 주문을
// 띄워 1번 레시피의 손 비는 시간(샷 추출 등)에 먼저 내보낸다. 숫자 비교라 코드 규칙이며 Zoro에 묻지 않는다.

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
  // 마지막 Zoro 묶기. ok가 false면 aiserver가 답하지 못한 것이다. key는 물을 때의 맨 앞 4건과 기준 주문이다.
  review?: { key: string; ok: boolean; anchor?: string; groups: Record<string, number>; scores: Record<string, number> };
  // 빠른 주문 칸에서 먼저 내보낸 주문(최근 것부터)
  quickServed: QuickLane['served'];
};

type Deps = { catalog: MenuCatalog; config: BoardConfig; ai?: AiClient; now?: () => number; decideDelayMs?: number; ownerRules?: OwnerRules };

const channels: Channel[] = ['dine-in', 'takeout', 'delivery'];
const sources: OrderSource[] = ['kiosk', 'delivery_app', 'demo', 'scenario'];
const equipmentLabels: Record<string, string> = { blender: '블렌더', espresso_machine: '에스프레소 머신', steam_wand: '스팀 완드' };
// aiserver app/review.py GROUP_THRESHOLD와 같은 값. 화면에서 Zoro 점수를 읽는 기준으로만 쓴다.
const groupThreshold = 0.5;

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
  // Zoro 보드 검토. 주문 구성이 바뀔 때만 다시 부른다(reviewKey). 늦게 온 답은 순번으로 버린다.
  private reviewTimer: ReturnType<typeof setTimeout> | undefined;
  private reviewPending: Promise<void> = Promise.resolve();
  private reviewSeq = 0;
  private lastReviewKey = '';
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
  // 판단이 끝나며 다음 판단을 예약할 수 있어(늦은 decide 다시 묻기) 예약이 남지 않을 때까지 기다린다.
  async settle(): Promise<void> {
    do {
      while (this.decideTimer !== undefined || this.reviewTimer !== undefined) await new Promise((resolve) => setTimeout(resolve, 5));
      await Promise.all([this.pending, this.pickPending, this.reviewPending]);
    } while (this.decideTimer !== undefined || this.reviewTimer !== undefined);
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
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = undefined;
    this.reviewSeq += 1;
    this.lastReviewKey = '';
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
      quickServed: [],
    };
    this.reorderWaiting();
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
      return { order: this.view(order), wait_seconds: this.etas(this.now()).get(existing) ?? 0, duplicate: true };
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
    this.reorderWaiting();
    if (input.request_id) this.state.requestIds.set(input.request_id, orderId);
    inventory.coffee_beans_shots_left -= needed.espresso_shot;
    inventory.strawberry_servings_left = Math.round((inventory.strawberry_servings_left - needed.strawberry_servings) * 100) / 100;
    this.commit();
    return { order: this.view(order), wait_seconds: this.etas(this.now()).get(orderId) ?? 0, duplicate: false };
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
      // Zoro가 4번을 고르는 사이 고정 주문이 또 끝나면, 비어 있던 4번은 룰 선택으로 먼저 채우고 당긴다.
      if (this.isPicking() && this.state.board.indexOf(orderId) >= 0 && this.state.board.indexOf(orderId) < this.lockedShown()) this.settlePendingPick();
      if (this.deps.config.fifo && this.state.board[0] === orderId) this.markCompanionsMade(orderId);
      order.status = 'done';
      order.completed_at = now;
      const locked = this.lockedShown();
      const index = this.state.board.indexOf(orderId);
      if (index >= 0) this.state.board.splice(index, 1);
      this.markWindowDone(orderId);
      // 고정칸(1~4번)이 비면 2~4번이 당겨지고 4번을 새로 고른다. 1번이 아닌 고정 주문이 먼저 끝나도(라이더가 먼저 와서 가져감) 같다.
      if (index >= 0 && index < locked) this.fillSlot4();
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
    const etas = this.etas(now);
    // Zoro가 4번을 고르는 동안 4번 칸은 비어 있고, 대기 주문은 5번부터 보인다.
    // 빠른 주문 칸을 쓰면 FIFO는 1~7번이고, 8번에는 빠른 주문 하나만 들어간다(나머지는 들어온 순서 그대로).
    const locked = this.lockedShown();
    const gap = config.lockedCount - locked;
    const laneId = this.quickLaneId();
    const fifoVisible = this.fifoVisibleCount();
    const fifo = this.state.board.filter((id) => id !== laneId);
    const board = fifo.map((id, index): OrderView => {
      // 화면 밖 대기열 번호는 빠른 주문 칸(8번) 다음부터 센다.
      const slot = index < locked ? index + 1 : index + 1 + gap + (laneId !== undefined && index >= fifoVisible ? 1 : 0);
      return {
        ...this.view(this.state.orders.get(id)!),
        slot,
        zone: index < locked ? 'locked' : slot <= fifoVisible ? 'flexible' : 'queue',
        eta_seconds: etas.get(id),
      };
    });
    if (laneId) {
      const lane: OrderView = { ...this.view(this.state.orders.get(laneId)!), slot: config.visibleCount, zone: 'quick', eta_seconds: etas.get(laneId) };
      const at = board.findIndex(({ zone }) => zone === 'queue');
      board.splice(at < 0 ? board.length : at, 0, lane);
    }
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
      // Zoro가 고르는 중이거나, 4번 칸에 있는 주문의 고르기 정보만 보낸다(다음 완료로 3번이 되면 빠진다).
      slot4: slot4 && (slot4.status === 'checking' || this.state.board[config.lockedCount - 1] === slot4.order_id) ? structuredClone(slot4) : undefined,
      work_window: structuredClone(this.state.workWindow),
      review: this.reviewView(board),
      notes: this.noteViews(board),
      quick_lane: this.quickLaneView(),
    };
  }

  // 예상 대기시간. FIFO 순서로 앞 주문의 남은 일을 더한다. 빠른 주문 칸의 주문은 1번 작업이 끝나기 전(손 비는 시간)이나
  // 끝난 직후에 내보내므로 1번의 남은 일 + 자기 손 시간으로 본다. 빠른 주문은 손 비는 시간에 만들어서 다른 주문 시간에 더하지 않는다.
  private etas(now: number): Map<string, number> {
    const laneId = this.quickLaneId();
    const etas = boardEtas(this.state.board.filter((id) => id !== laneId), this.state.orders, now);
    if (laneId) {
      const lane = this.quickLaneInfo(laneId);
      const head = this.state.board[0] ? this.state.orders.get(this.state.board[0]) : undefined;
      const before = lane.ready || !head ? 0 : workLeftSeconds(head, now);
      etas.set(laneId, Math.round(before + lane.hands));
    }
    return etas;
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

  // Zoro가 4번을 고르는 중인지. 이때 4번 칸은 비어 있고 보드의 고정 주문은 1~3번뿐이다.
  private isPicking(): boolean {
    return this.state.slot4?.status === 'checking';
  }

  // 지금 화면 고정칸(1~4번)에 들어 있는 주문 수. Zoro가 고르는 중이면 4번이 비어 있어 하나 적다.
  private lockedShown(): number {
    return this.deps.config.lockedCount - (this.isPicking() ? 1 : 0);
  }

  // 후보가 아직 4번에 넣을 수 있는 상태인지(그 사이 완료되거나 빠지지 않았는지).
  private canPlace(id: string): boolean {
    return this.state.board.includes(id) && this.state.orders.get(id)?.status === 'waiting';
  }

  // 당겨진 뒤의 보드에서 4번을 채운다. 후보는 기존 5~8번(지금은 4~7번 칸)의 대기 주문 중 만들 수 있는 주문이다.
  // 4번은 Zoro가 고른다. Zoro 답이 올 때까지 4번은 비워 두고("Zoro 고르는 중"), 룰 선택은 Zoro가 답하지 못할 때만 쓴다.
  private fillSlot4(): void {
    const L = this.deps.config.lockedCount;
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
    const fifoPick = candidates[0];
    if (this.deps.config.fifo) {
      // FIFO: 4번은 가장 먼저 들어온 대기 주문이다. Zoro에 묻지 않는다(비슷한 주문 묶기는 화면에서 따로 한다).
      this.placeAt4(fifoPick, { source: 'rule', status: 'final', rule_pick: fifoPick, facts: Object.fromEntries([...facts].map(([id, fact]) => [id, fact.line])) });
      return;
    }
    const rule = rulePickNext(candidates, this.state.orders, facts, this.rules.limits);
    const factLines = Object.fromEntries([...facts].map(([id, fact]) => [id, fact.line]));
    // 후보가 하나면 고를 것이 없어 Zoro에 묻지 않는다. aiserver가 없으면 룰로 채운다.
    const ai = candidates.length > 1 ? this.deps.ai : undefined;
    if (!ai) {
      this.placeAt4(rule, { source: 'rule', status: 'final', rule_pick: rule, facts: factLines });
      this.countOvertaken(candidates, rule);
      return;
    }
    this.state.slot4 = { order_id: '', source: 'zoro', status: 'checking', rule_pick: rule, facts: factLines };
    this.pickCandidates = candidates;
    this.pickPending = this.askZoro(ai, seq, locked, candidates, facts, rule);
  }

  // Zoro 답을 기다리는 중에 고정 주문이 또 끝나면 기다리던 4번을 룰 선택으로 채운다. 늦게 온 Zoro 답은 버린다.
  private settlePendingPick(): void {
    const current = this.state.slot4!;
    const candidates = this.pickCandidates;
    this.pickSeq += 1;
    this.pickCandidates = [];
    const pick = this.canPlace(current.rule_pick) ? current.rule_pick : candidates.find((id) => this.canPlace(id));
    if (!pick) {
      this.state.slot4 = undefined;
      return;
    }
    this.placeAt4(pick, { ...current, source: 'rule', status: 'final' });
    this.countOvertaken(candidates, pick);
  }

  // pick을 4번 칸에 넣는다. 나머지 대기 주문은 들어온 순서로 둔다(4번으로 가는 주문만 움직인다).
  private placeAt4(pick: string, info: Omit<Slot4Info, 'order_id'>): void {
    const L = this.deps.config.lockedCount;
    const rest = this.state.board.filter((id) => id !== pick);
    const waiting = this.orderWaiting(rest.slice(L - 1));
    this.state.board = [...rest.slice(0, L - 1), pick, ...waiting];
    this.state.slot4 = { ...info, order_id: pick };
  }

  // 들어온 순서. 접수 시각이 같으면 주문 번호 순서다.
  // 빠른 메뉴 끌어오기(코드 규칙). 대기 주문은 접수순이 기본이고, 제조 시간이 quick_menu_sec 이하인 주문은
  // 대기칸 앞 quickSlots칸까지 먼저 온 순서로 올린다(화면 밖 대기열에 있어도 올라온다). 4번은 여전히 5~8번 중 Zoro가 고른다.
  // 앞으로 올릴 수 있는 칸 수를 제한해서, 오래 걸리는 주문이 빠른 메뉴 때문에 계속 밀리지 않게 한다.
  private isQuick(id: string): boolean {
    const order = this.state.orders.get(id);
    const limit = this.deps.config.quickMenuSec;
    return !!order && limit !== undefined && order.status === 'waiting' && !this.isBlocked(order) && order.remaining_work_seconds <= limit;
  }

  private orderWaiting(ids: string[]): string[] {
    const byArrival = [...ids].sort((a, b) => this.arrival(a) - this.arrival(b));
    const quick = this.deps.config.fifo ? [] : byArrival.filter((id) => this.isQuick(id)).slice(0, this.deps.config.quickSlots ?? 0);
    return [...quick, ...byArrival.filter((id) => !quick.includes(id))];
  }

  // 고정칸 뒤(대기칸 + 화면 밖 대기열)의 순서를 orderWaiting으로 다시 맞춘다. 고정칸은 건드리지 않는다.
  private reorderWaiting(): void {
    const start = this.lockedShown();
    this.state.board = [...this.state.board.slice(0, start), ...this.orderWaiting(this.state.board.slice(start))];
  }

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
    const current = this.state.slot4;
    if (current?.status !== 'checking') return;
    const usable = (id: string) => candidates.includes(id) && this.canPlace(id);
    this.pickCandidates = [];
    if (res.ok && res.data.source === 'zoro' && usable(res.data.pick)) {
      this.placeAt4(res.data.pick, { ...current, source: 'zoro', status: 'final', confidence: res.data.confidence, scores: res.data.scores });
    } else {
      // Zoro가 답하지 못함(연결 실패·타임아웃·형식 오류), 후보 밖 id, 그 사이 완료된 주문 → 룰 선택(그것도 없으면 남은 후보 중 먼저 온 주문)
      const fallback = usable(rule) ? rule : candidates.find(usable);
      if (!res.ok) console.warn(`[order-store] pick-next fell back to rule: ${res.error}`);
      if (!fallback) {
        this.state.slot4 = undefined;
        this.commit({ decide: false });
        return;
      }
      this.placeAt4(fallback, { ...current, source: 'rule', status: 'final', ...(res.ok ? { confidence: res.data.confidence, scores: res.data.scores } : {}) });
    }
    this.countOvertaken(candidates, this.state.board[this.deps.config.lockedCount - 1]);
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
    // Zoro가 4번을 고르는 중이면 1~3번만 본다. 4번이 정해지면 다시 쓴다.
    const top4 = this.state.board.slice(0, this.lockedShown()).map((id) => this.state.orders.get(id)!);
    this.state.workWindow = buildWorkWindow(top4, this.deps.catalog, (order) => this.blockedReason(order));
  }

  // 작업창 마지막 줄(1번 완료)을 누르면 위 단계는 다 한 것으로 본다. make 단계의 주문은 made, prep 단계는 prepped가 된다.
  // 1번이 아닌 주문이 먼저 완료되면(라이더가 먼저 와서 가져감) 작업창 단계는 한 것으로 보지 않는다.
  private markWindowDone(orderId: string): void {
    if (this.deps.config.fifo) return;   // FIFO에서는 '만듦' 표시를 아래 카드의 버튼으로만 한다
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
      items: order.menu_items.map((line) => ({ name: lineName(catalog, line), qty: line.qty, unit: lineUnit(catalog, line), options: optionNames(catalog, line.options), group: findDrink(catalog, line.menu)?.group })),
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
      served_early: order.served_early ?? false,
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
    this.scheduleReview();
    if (!this.deps.ai || options.decide === false) return;
    this.scheduleDecide();
  }

  private scheduleDecide(): void {
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
    // 묶기 답처럼 decide를 다시 예약하지 않는 커밋이 끼어들 수 있어, 버린 뒤에는 새 상태로 한 번 더 묻는다(예약이 있으면 그것을 쓴다).
    if (this.state.version !== version) {
      if (!this.decideTimer) this.scheduleDecide();
      return;
    }
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

  // ---- 위 4칸 묶기(1번 기준)와 아래 일머리 팁 칸 ----

  private topIds(): string[] {
    return this.state.board.slice(0, this.deps.config.lockedCount).filter((id) => this.state.orders.get(id)?.status !== 'done');
  }

  // 기준 주문: 위 4칸에서 먼저 만들 주문. 보통 1번이고, 1번을 앞 주문과 같이 만들어 뒀으면(포장만 남음) 그다음 주문이다.
  // 장비 고장으로 보류된 주문은 기준이 되지 않는다.
  private anchorId(): string | undefined {
    return this.topIds().find((id) => {
      const order = this.state.orders.get(id)!;
      return !order.made && !this.isBlocked(order);
    });
  }

  private reviewKey(): string {
    return `${this.anchorId() ?? '-'}|${this.topIds().join(',')}`;
  }

  // 1번 기준과 2~4번 중 같이 만들 수 있는 후보(만듦·보류·디카페인 같은 옵션 막힘은 코드가 먼저 뺀다)
  private reviewCandidates(anchor: string): string[] {
    return this.topIds().filter((id) => {
      const order = this.state.orders.get(id)!;
      return id === anchor || (!order.made && !this.isBlocked(order));
    });
  }

  // 맨 앞 4건이나 기준 주문이 바뀔 때만 다시 묻는다. 주문이 끝나 FIFO로 4건이 새로 정해지면 다시 비교한다.
  private scheduleReview(): void {
    if (!this.deps.ai) return;
    const key = this.reviewKey();
    if (key === this.lastReviewKey) return;
    this.lastReviewKey = key;
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = setTimeout(() => {
      this.reviewTimer = undefined;
      this.reviewPending = this.runReview();
    }, this.deps.decideDelayMs ?? 250);
  }

  private async runReview(): Promise<void> {
    const ai = this.deps.ai;
    if (!ai) return;
    const seq = ++this.reviewSeq;
    const key = this.reviewKey();
    const anchor = this.anchorId();
    const request = anchor ? buildGroupRequest(anchor, this.reviewCandidates(anchor), this.state.orders, this.deps.catalog) : undefined;
    if (!request || request.orders.length < 2) {
      this.state.review = { key, ok: true, anchor, groups: {}, scores: {} };
      this.commit({ decide: false });
      return;
    }
    const result = await ai.groupOrders(request);
    if (seq !== this.reviewSeq) return;   // 기다리는 사이 앞 4건이 또 바뀌었다
    if (!result.ok) console.warn(`[order-store] group-orders failed: ${result.error}`);
    const ok = result.ok && !result.data.fallback;
    this.state.review = { key, ok, anchor, groups: ok ? result.data.groups : {}, scores: ok ? result.data.scores : {} };
    this.commit({ decide: false });
  }

  // 지금 보드와 같은 맨 앞 4건으로 물은 답만 쓴다. 다시 묻는 중이면 묶음을 보여 주지 않는다.
  private currentReview(): State['review'] {
    const review = this.state.review;
    return review && review.key === this.reviewKey() ? review : undefined;
  }

  // 1번이 끝나면 1번과 같은 묶음인 2~4번은 같이 만든 것으로 본다('만듦'. 화면에서는 삭선, 남은 일은 포장뿐).
  // 위 1번의 완료 버튼과 아래 카드의 완료 버튼이 모두 이 길을 지난다.
  private markCompanionsMade(headId: string): void {
    for (const id of this.companionsOf(headId)) this.state.orders.get(id)!.made = true;
  }

  // 기준 주문과 같은 묶음인 위 4칸 주문(아직 안 끝난 것만)
  private companionsOf(anchorId: string | undefined): string[] {
    const review = this.currentReview();
    if (!anchorId || !review?.ok || review.anchor !== anchorId) return [];
    const n = review.groups[anchorId];
    if (n === undefined) return [];
    return this.topIds().filter((id) => id !== anchorId && review.groups[id] === n && this.state.orders.get(id)?.status !== 'done');
  }

  // 코드가 Zoro에 묻기 전에 뺀 2~4번과 이유
  private excludedFromReview(anchor: string | undefined): Record<string, string> {
    if (!anchor) return {};
    const excluded: Record<string, string> = {};
    for (const id of this.topIds()) {
      if (id === anchor) continue;
      const order = this.state.orders.get(id)!;
      const blocked = this.blockedReason(order)?.replace(/으로 보류$/, '이라');   // "블렌더 고장으로 보류" → "블렌더 고장이라"
      const why = order.made ? undefined : blocked ?? blockingReason(order, this.deps.catalog);
      if (why) excluded[id] = why;
    }
    return excluded;
  }

  // 화면용 묶음(색). 기준 주문과 그 짝만 같은 색이다.
  private reviewView(board: OrderView[]): BoardReview {
    const anchor = this.anchorId();
    const base = { anchor, groups: {}, scores: {}, excluded: this.excludedFromReview(anchor), threshold: groupThreshold };
    if (!this.deps.ai) return { ...base, status: 'off' };
    const review = this.currentReview();
    if (!review) return { ...base, status: 'checking' };
    const top = new Set(board.filter(({ zone }) => zone === 'locked').map(({ order_id: id }) => id));
    return { ...base, status: review.ok ? 'ready' : 'unavailable', groups: groupViews(review.anchor, review.groups, review.scores, top), scores: review.scores };
  }

  // 아래 일머리 팁 칸 카드. 1번 기준으로 1번 메뉴와 같이 만들 2~4번을 적고(head), 8번 빠른 주문을 알린다(quick).
  private noteViews(board: OrderView[]): Note[] {
    const review = this.reviewView(board);
    const { catalog } = this.deps;
    const notes: Note[] = [];
    const headId = this.topIds()[0];
    const head = headId ? this.state.orders.get(headId) : undefined;
    if (head) {
      const anchor = review.anchor;
      const companions = this.companionsOf(anchor);
      notes.push({
        id: `head:${headId}`,
        kind: 'head',
        ...headNote(head, anchor, companions, this.state.orders, catalog, review.status),
        reason: apartText(review.scores, review.excluded, review.threshold, this.state.orders, catalog),
        zoro: zoroText(anchor, review.scores, review.threshold),
        order_ids: [headId, ...(anchor && anchor !== headId ? [anchor] : []), ...companions],
        color: anchor ? review.groups[anchor]?.color : undefined,
      });
    }
    const laneId = this.quickLaneId();
    if (laneId) {
      const lane = this.quickLaneInfo(laneId);
      const { ready, text, detail, reason } = quickLaneText(this.state.orders.get(laneId)!, lane.position, this.fifoVisibleCount(), lane.hands, lane.idle, catalog, this.state.orders);
      notes.push({ id: `quick:${laneId}`, kind: 'quick', text, detail, reason, order_ids: [laneId], ready });
    }
    return notes;
  }

  // ---- 8번 빠른 주문 칸 ----

  // FIFO 칸 수. 빠른 주문 칸을 쓰면 마지막 칸(8번)을 비워 둔다.
  private fifoVisibleCount(): number {
    const { config } = this.deps;
    return config.visibleCount - (config.fifo && config.quickLane ? 1 : 0);
  }

  // 8번에 띄울 주문: 1~4번 밖(5~7번, 화면 밖 대기열)에서 가장 먼저 들어온 매장·포장 디저트 전용 주문. 보드는 들어온 순서다.
  private quickLaneId(): string | undefined {
    const { config } = this.deps;
    if (!config.fifo || !config.quickLane) return undefined;
    return this.state.board.slice(config.lockedCount).find((id) => {
      const order = this.state.orders.get(id)!;
      return isQuickDessert(order, this.deps.catalog) && !this.isBlocked(order);
    });
  }

  // 손 비는 시간: 지금 만드는 작업(기준 주문 + 같이 만들 주문)의 레시피에서 손이 비는 가장 긴 단계
  private quickLaneInfo(laneId: string) {
    const order = this.state.orders.get(laneId)!;
    const anchor = this.anchorId();
    const idle = anchor ? idleWindow([anchor, ...this.companionsOf(anchor)], this.state.orders, this.deps.catalog) : undefined;
    const hands = handsSeconds(order, this.deps.catalog);
    return { idle, hands, ready: !!idle && idle.sec >= hands, position: this.state.board.indexOf(laneId) + 1 };
  }

  private quickLaneView(): QuickLane {
    const { config } = this.deps;
    const enabled = !!(config.fifo && config.quickLane);
    const laneId = this.quickLaneId();
    const served = structuredClone(this.state.quickServed);
    if (!laneId) return { enabled, ready: false, served };
    const lane = this.quickLaneInfo(laneId);
    return { enabled, order_id: laneId, ready: lane.ready, fifo_position: lane.position, hands_sec: lane.hands, idle: lane.idle, served };
  }

  // 빠른 주문 카드(8번 칸과 아래 팁 칸)의 "내보냈어요": 그 주문을 완료한다. (1번 카드의 완료는 위 완료 버튼과 같은 주문 완료 API를 쓴다.)
  handleNote(noteId: string): { ok: true } | StoreError {
    if (!noteId.startsWith('quick:')) return { error: '이 카드는 버튼으로 처리하지 않아요.', status: 400 };
    const id = noteId.slice('quick:'.length);
    if (this.quickLaneId() !== id) return { error: '이미 처리된 알림이에요.', status: 404 };
    const order = this.state.orders.get(id)!;
    const text = `${id} ${order.menu_items.map((line) => `${lineName(this.deps.catalog, line)} ${line.qty}${lineUnit(this.deps.catalog, line)}`).join(', ')}`;
    // 차례보다 먼저 나간 기록을 남기고 완료한다. 완료가 커밋하면서 8번 칸에 다음 디저트가 올라온다.
    order.served_early = true;
    this.state.quickServed = [{ order_id: id, text, at: new Date(this.now()).toISOString() }, ...this.state.quickServed].slice(0, 3);
    const result = this.updateOrderStatus(id, 'complete');
    return 'error' in result ? result : { ok: true };
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
