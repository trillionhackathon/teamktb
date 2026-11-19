// 주문·보드·이벤트 데이터 형식. 필드 이름은 data/cafe_db.json의 signals_schema와 kds_board를 따른다.

export type Channel = 'dine-in' | 'takeout' | 'delivery';
export type OrderSource = 'kiosk' | 'delivery_app' | 'scenario' | 'demo';
export type OrderStatus = 'waiting' | 'in_progress' | 'done';
export type RiderStatus = 'not_dispatched' | 'dispatched' | 'arrived';
export type SizeId = 'R' | 'L';
export type DecisionSource = 'zoro' | 'llm' | 'rule';

export type MenuItemInput = { menu: string; qty: number; size?: SizeId; options?: string[] };

export type OrderLine = { menu: string; qty: number; size: SizeId; options: string[] };

export type Order = {
  order_id: string;
  channel: Channel;
  source: OrderSource;
  menu_items: OrderLine[];
  received_at: string;
  status: OrderStatus;
  started_at?: string;
  completed_at?: string;
  request_note?: string;
  rider_status?: RiderStatus;
  pickup_eta_seconds?: number | null;
  eta_confirmed?: boolean;
  needs_confirmation?: boolean;
  remaining_work_seconds: number;
  price_krw: number;
  request_id?: string;
  // 4번 고르기에서 건너뛴 횟수(뒤에 접수된 주문이 먼저 4번에 들어간 횟수).
  overtaken?: number;
  // 작업창에서 미리 만들어 둔 주문(앞 주문 완료 때 같이 만든 잔). 남은 일은 포장뿐이다.
  made?: boolean;
  // 스무디 재료만 준비해 둔 주문. 갈기는 1~2번이 됐을 때 한다.
  prepped?: boolean;
  // 라이더·픽업 도착 시각. pickup_eta_seconds("지금부터 몇 초 뒤")를 받는 순간 now + 초로 바꿔 저장한다.
  rider_eta_at?: string;
  // 빠른 주문 칸(8번)에서 차례보다 먼저 내보낸 주문
  served_early?: boolean;
};

// 사장님 기준의 숫자(data/owner_rules.json limits).
export type OwnerLimits = { max_wait_sec: number; delivery_late_ok_sec: number; max_overtaken: number };
export type OwnerRules = { sentences: string[]; limits: OwnerLimits };

// 4번 칸을 누가 골랐는지. checking은 Zoro가 고르는 중이라 4번 칸이 비어 있고 order_id는 빈 문자열이다.
export type Slot4Info = {
  order_id: string;
  source: 'zoro' | 'rule';
  status: 'checking' | 'final';
  rule_pick: string;
  confidence?: number;
  // 고를 때의 후보별 사실 문장과 Zoro 점수. 화면에서 "룰은 #110 · 이유"를 만들 때 쓴다.
  facts: Record<string, string>;
  scores?: Record<string, number>;
};

// 작업창 한 줄. 마지막 줄은 kind 'done'("주문 #101 완료")이다.
export type MenuGroup = { id: string; name_kr: string; color: string };
// group: 이 단계 메뉴의 계열(Zoro가 레시피로 만든 data/menu_groups.json). 같은 계열 단계는 연달아 놓는다.
export type WorkStep = { text: string; orders: string[]; kind: 'make' | 'prep' | 'pack' | 'done'; group?: MenuGroup };

// Zoro가 맨 앞 4건(고정칸)이 바뀔 때마다 1번(기준)과 2~4번을 비교한 결과(/ai/group-orders, anchor).
// anchor: 기준 주문. 보통 1번이고, 1번을 앞 주문과 같이 만들어 뒀으면(포장만 남음) 그다음 만들 주문이다.
// groups: 기준 주문과 같이 만들 주문(같은 색 하이라이트). 짝이 없으면 비어 있다.
// scores: 2~4번마다 Zoro가 본 기준 주문과 비슷한 정도. excluded: 코드가 먼저 뺀 주문과 이유(디카페인 등).
export type ReviewGroup = { id: number; label: string; color: string; size: number; role: 'anchor' | 'companion'; score?: number };
export type BoardReview = {
  status: 'off' | 'checking' | 'ready' | 'unavailable';
  anchor?: string;
  groups: Record<string, ReviewGroup>;
  scores: Record<string, number>;
  excluded: Record<string, string>;
  threshold: number;
};

// 아래 일머리 팁 칸의 카드.
// 문장은 쉬운 말로 쓴다. text: 할 일, detail: 왜(같이 만드는 이유, 손이 비는 단계), reason: 따로 만드는 주문이나 먼저 내는 이유, zoro: Zoro 점수(작은 글씨).
// head: 1번 주문과 같이 만들 2~4번. 카드의 완료 버튼은 위 1번의 완료 버튼과 같은 동작이다.
// quick: 8번 빠른 주문 칸의 디저트. 1번 레시피에 손이 비는 단계가 있으면 지금 먼저 내라고 알린다(ready). 누르면 그 주문이 완료된다.
export type Note = { id: string; kind: 'head' | 'quick'; text: string; detail?: string; reason?: string; zoro?: string; order_ids: string[]; color?: string; ready?: boolean };

// 8번 빠른 주문 칸. order_id가 없으면 빈 칸이다. served는 방금 먼저 내보낸 주문(최근 3건).
export type QuickLane = {
  enabled: boolean;
  order_id?: string;
  ready: boolean;
  fifo_position?: number;
  hands_sec?: number;
  idle?: { order_id: string; sec: number; label: string };
  served: { order_id: string; text: string; at: string }[];
};

export type Tip = { id: string; text: string; source: DecisionSource; confidence?: number };

export type EventCategory =
  | 'spill_cleanup' | 'stock_shortage' | 'customer_message' | 'rider_message' | 'equipment_failure' | 'equipment_recovered'
  | 'rider_arrived' | 'pickup_eta_update' | 'quality_request' | 'unknown';

export type StoreEvent = {
  event_id: string;
  raw_text: string;
  order_id?: string;
  category: EventCategory;
  needs_confirmation: boolean;
  summary: string;
  received_at: string;
  intent?: { intent: string; confidence: number; source: DecisionSource };
};

export type Signals = {
  inventory: { coffee_beans_shots_left: number; strawberry_servings_left: number };
  store: { equipment_status: Record<string, 'ok' | 'broken'>; staff_count: number };
  delivery: { weather: string };
};

// aiserver 연결 상태. 보드 순서는 바꾸지 않는다(4번 고르기는 Slot4Info, 팁은 /ai/decide).
export type Decision = {
  state_version: number;
  source: DecisionSource;
  fallback: boolean;
  ai_status: 'connected' | 'unavailable' | 'disabled';
  ai_error?: string;
  decided_at: string;
};
