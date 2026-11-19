import scenarioData from '../../data/scenarios.json' with { type: 'json' };
import type { Channel, EventCategory, MenuItemInput, RiderStatus, Signals } from './types.ts';

// data/scenarios.json(SC-A~D)과 scenarios.md(SC-01, SC-02, SC-05)를 대시보드에서 재생할 수 있는 형태로 만든다.
export type SeedOrder = { order_id: string; channel: Channel; menu_items: MenuItemInput[]; waiting_seconds: number; rider_status?: RiderStatus };

export type SignalPatch = {
  inventory?: Partial<Signals['inventory']>;
  rider_status?: Record<string, RiderStatus>;
};

export type ScenarioTrigger =
  | { label: string; kind: 'event'; raw_text: string; order_id?: string; category?: EventCategory; signal?: SignalPatch }
  | { label: string; kind: 'signal'; signal: SignalPatch }
  | { label: string; kind: 'order'; channel: Channel; menu_items: MenuItemInput[] };

export type Scenario = {
  id: string;
  title: string;
  source: string;
  description: string;
  expected: string;
  orders: SeedOrder[];
  triggers: ScenarioTrigger[];
};

type JsonOrderDetail = { menu_items: { menu: string; qty: number }[]; channel: string; waiting_seconds: number; rider_status?: string };
type JsonEvent = { raw_text: string; category?: string; order_id?: string };
type JsonSignal = { delivery?: { per_order_rider_status?: Record<string, string> }; inventory?: Record<string, number> };
type JsonTrigger = { t?: string; event?: JsonEvent; signal?: JsonSignal };
type JsonScenario = {
  title: string;
  why_this_scenario: string;
  trigger: JsonTrigger;
  expected_output: Record<string, unknown>;
  followup?: { t?: string; event: JsonEvent; expected_output?: Record<string, unknown> };
};

const shared = scenarioData.board_shared_example;
const details = shared.detail as Record<string, JsonOrderDetail>;

// board_shared_example은 #106~#110만 내용이 있다. #101~#105는 접수순이 앞서도록 이 파일에서 채운 예시다.
const lockedSeed: Record<string, JsonOrderDetail> = {
  '#101': { menu_items: [{ menu: 'latte', qty: 1 }], channel: 'dine-in', waiting_seconds: 0 },
  '#102': { menu_items: [{ menu: 'iced_americano', qty: 2 }], channel: 'takeout', waiting_seconds: 0 },
  '#103': { menu_items: [{ menu: 'strawberry_smoothie', qty: 1 }], channel: 'delivery', waiting_seconds: 0, rider_status: 'dispatched' },
  '#104': { menu_items: [{ menu: 'latte', qty: 2 }], channel: 'dine-in', waiting_seconds: 0 },
  '#105': { menu_items: [{ menu: 'iced_americano', qty: 1 }], channel: 'takeout', waiting_seconds: 0 },
};

function toChannel(value: string): Channel {
  return value === 'delivery' || value === 'takeout' ? value : 'dine-in';
}

function toRiderStatus(value: string | undefined): RiderStatus | undefined {
  return value === 'arrived' || value === 'dispatched' || value === 'not_dispatched' ? value : undefined;
}

// JSON의 waiting_seconds(#106 40, #107 30, #108 90, #109 20, #110 10)를 그대로 쓰면 #108이 가장 오래 기다린 주문이 되어
// SC-B(라이더 도착 → 다음 1번 완료 때 #108이 4번으로)의 전후 차이가 사라진다. 칸 순서가 곧 접수 순서가 되도록 앞 칸일수록 30초씩 오래 기다린 것으로 둔다.
export const sharedBoardOrders: SeedOrder[] = shared.orders.map((orderId, index) => {
  const detail = details[orderId] ?? lockedSeed[orderId];
  return {
    order_id: orderId,
    channel: toChannel(detail.channel),
    menu_items: detail.menu_items.map(({ menu, qty }) => ({ menu, qty })),
    waiting_seconds: 40 + (shared.orders.length - 1 - index) * 30,
    rider_status: toRiderStatus(detail.rider_status) ?? (detail.channel === 'delivery' ? 'not_dispatched' : undefined),
  };
});

// expected_output을 화면에 한 줄로 보여준다. 예: orders_tail: #108, #106 · moves: #108 8→6 rider_waiting
function formatExpected(expected: Record<string, unknown>): string {
  return Object.entries(expected).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: ${value.map((item) => (item && typeof item === 'object' && 'order_id' in item
        ? `${(item as { order_id: string }).order_id} ${(item as { from: number }).from}→${(item as { to: number }).to} ${(item as { reason: string }).reason}`
        : String(item))).join(', ')}`;
    }
    return `${key}: ${value && typeof value === 'object' ? Object.values(value).join(' / ') : String(value)}`;
  }).join(' · ');
}

function toSignalPatch(signal: JsonSignal | undefined): SignalPatch | undefined {
  if (!signal) return undefined;
  const riders = signal.delivery?.per_order_rider_status;
  const inventory = signal.inventory as Partial<Signals['inventory']> | undefined;
  return {
    ...(inventory ? { inventory } : {}),
    ...(riders ? { rider_status: Object.fromEntries(Object.entries(riders).flatMap(([id, status]) => (toRiderStatus(status) ? [[id, toRiderStatus(status)!]] : []))) } : {}),
  };
}

function toTrigger(trigger: JsonTrigger, fallbackLabel: string): ScenarioTrigger {
  const signal = toSignalPatch(trigger.signal);
  const at = trigger.t ? `${trigger.t} ` : '';
  if (trigger.event) {
    return {
      label: `${at}${trigger.event.raw_text}`,
      kind: 'event',
      raw_text: trigger.event.raw_text,
      order_id: trigger.event.order_id,
      category: trigger.event.category as EventCategory | undefined,
      signal,
    };
  }
  return { label: `${at}${fallbackLabel}`, kind: 'signal', signal: signal ?? {} };
}

function describeSignal(signal: JsonSignal | undefined): string {
  const riders = Object.entries(signal?.delivery?.per_order_rider_status ?? {}).map(([id, status]) => `${id} 라이더 ${status === 'arrived' ? '도착' : status}`);
  const inventory = Object.entries(signal?.inventory ?? {}).map(([key, value]) => (key === 'coffee_beans_shots_left' ? `원두 ${value}샷 남음` : key === 'strawberry_servings_left' ? `딸기 ${value}인분 남음` : `${key} ${value}`));
  return [...riders, ...inventory].join(', ') || '신호 반영';
}

const jsonScenarios = Object.entries(scenarioData.scenarios as Record<string, JsonScenario>).map(([id, scenario]): Scenario => ({
  id,
  title: scenario.title,
  source: 'data/scenarios.json',
  description: scenario.why_this_scenario,
  expected: formatExpected(scenario.expected_output),
  orders: sharedBoardOrders,
  triggers: [
    toTrigger(scenario.trigger, describeSignal(scenario.trigger.signal)),
    ...(scenario.followup ? [toTrigger(scenario.followup, '후속 메시지')] : []),
  ],
}));

const markdownScenarios: Scenario[] = [
  {
    id: 'SC-01',
    title: '새 주문은 맨 뒤에 붙는다',
    source: 'scenarios.md',
    description: '보드 #101~#110이 찬 상태에서 #111 아이스 아메리카노 3잔이 접수된다. 맨 뒤(화면 밖 대기열)에 붙고, 앞 주문이 빠지면 들어온 순서대로 5~8번 칸으로 올라온다.',
    expected: '#111은 대기열에서 시작, 예상 대기시간 표시. 보드 순서는 그대로.',
    orders: sharedBoardOrders,
    triggers: [{ label: '#111 아이스 아메리카노 3잔 접수', kind: 'order', channel: 'takeout', menu_items: [{ menu: 'iced_americano', qty: 3 }] }],
  },
  {
    id: 'SC-02',
    title: '손님이 커피를 쏟으면 청소 안내가 work_tip에 뜬다',
    source: 'scenarios.md',
    description: '쏟음은 보드 카드가 아니라 팁으로만 안내하고, 어떤 주문도 밀리거나 사라지지 않는다.',
    expected: 'work_tip "통행로 커피 쏟음 - 바닥 청소 필요". 위치가 없으면 needs_confirmation.',
    orders: sharedBoardOrders,
    triggers: [
      { label: '손님이 통행로에 커피를 쏟았어요', kind: 'event', raw_text: '손님이 통행로에 커피를 쏟았어요' },
      { label: '커피를 쏟았어요 (위치 없음)', kind: 'event', raw_text: '커피를 쏟았어요' },
    ],
  },
  {
    id: 'SC-05',
    title: '블렌더 고장으로 스무디 포함 주문이 4번 후보에서 빠진다',
    source: 'scenarios.md',
    description: '불가능한 메뉴가 섞인 주문은 보드에서 지우지 않고 4번 후보에서만 제외하고, 복구되면 다시 후보에 넣는다.',
    expected: '#108은 보드에 남고 후보에서만 제외, 팁 "블렌더 고장 - 스무디 포함 주문 보류".',
    orders: sharedBoardOrders,
    triggers: [
      { label: '블렌더 고장', kind: 'event', raw_text: '블렌더 고장' },
      { label: '블렌더 복구됐어요', kind: 'event', raw_text: '블렌더 복구됐어요' },
    ],
  },
];

export const scenarios: Scenario[] = [
  {
    id: 'board',
    title: '공통 보드',
    source: 'data/scenarios.json board_shared_example',
    description: '#101~#110이 채워진 2x4 보드. 1~4번은 고정, 5~8번은 들어온 순서로 대기, #109~#110은 화면 밖 대기열이다. 1번 완료 때 5~8번 중 하나가 4번으로 간다.',
    expected: '키오스크·배달 주문은 #111부터 대기열에 쌓인다.',
    orders: sharedBoardOrders,
    triggers: [],
  },
  ...jsonScenarios,
  ...markdownScenarios,
  {
    id: 'empty',
    title: '빈 보드',
    source: '시연용',
    description: '주문 없이 시작해 키오스크·배달 주문이 1번 칸부터 채워지는 흐름을 본다.',
    expected: '첫 주문은 #101.',
    orders: [],
    triggers: [],
  },
];

export const defaultScenarioId = 'board';

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
