// 주문·보드·이벤트 데이터 형식. 필드 이름은 data/cafe_db.json의 signals_schema와 kds_board를 따른다.

export type Channel = 'dine-in' | 'takeout' | 'delivery';
export type OrderSource = 'kiosk' | 'delivery_app' | 'scenario' | 'demo';
export type OrderStatus = 'waiting' | 'in_progress' | 'done';
export type RiderStatus = 'not_dispatched' | 'dispatched' | 'arrived';
export type SizeId = 'R' | 'L';
export type DecisionSource = 'zoro' | 'llm' | 'rule';

export type MenuItemInput = { menu: string; qty: number; size?: SizeId; options?: string[] };

// note_options: 요청사항 메모를 읽고 붙인 옵션(options 안에도 들어 있다). 결제한 옵션과 구분해 보여 주고 되돌릴 때 쓴다.
export type OrderLine = { menu: string; qty: number; size: SizeId; options: string[]; note_options?: string[] };

// ---- 배달 요청사항 읽기(/ai/read-note) ----
// store: 가게 요청사항 칸, rider: 배달(라이더) 요청사항 칸. 손님이 배달 칸에 가게 요청을 적기도 해서 두 칸 다 읽는다.
export type NoteField = 'store' | 'rider';
// recipe: 만드는 법이 바뀜, packing: 포장, confirm: 확인 필요(취소·변경·메뉴 밖 부탁), delivery: 배달 기사 몫, other: 그 밖의 말.
// delivery와 other는 둘 다 가게 일이 아니라 같은 행동을 한다(domain/note.ts가 확률을 더해 판단).
export type NoteKind = 'recipe' | 'packing' | 'confirm' | 'delivery' | 'other';
// 문장 하나를 읽은 결과와 카드에 한 일. Zoro는 뜻과 확신만 답하고, 반영·⚠·보류는 코드가 확신에 기준선을 대서 정한다(domain/note.ts).
export type NoteSentence = {
  id: string;
  field: NoteField;
  text: string;
  kind?: NoteKind;
  option?: string;        // Zoro가 고른 옵션 id(목록에 있을 때만)
  confidence?: number;    // 반영 판단에 쓴 Zoro 확신(종류 확률과 옵션 확률 중 작은 값)
  cups?: number;          // 옵션을 붙인 잔 수(반영했을 때만)
  applied: boolean;       // 카드에 옵션을 붙였나
  hidden: boolean;        // 카드에 띄우지 않음(배달 칸의 가게 일 아닌 문장)
  check?: string;         // ⚠ 문구. 있으면 알바가 확인한다
  hold: boolean;          // 확인될 때까지 1번과 같이 만들지 않음
  moved: boolean;         // 배달 칸에 적힌 가게 일
  resolved: boolean;      // 알바가 확인하거나 되돌림
};
// checking: Zoro가 읽는 중, ready: 읽음, unavailable: Zoro가 답하지 못함(원문 + ⚠), off: AI 서버 없음(원문만)
export type NoteRead = { status: 'checking' | 'ready' | 'unavailable' | 'off'; sentences: NoteSentence[] };

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
  // 배달(라이더) 요청사항 칸
  rider_note?: string;
  // 두 칸 메모를 문장으로 나눠 Zoro가 읽은 결과
  note_read?: NoteRead;
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
  completed_lines?: number[];
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
export type Note = { id: string; kind: 'head' | 'task' | 'quick'; text: string; detail?: string; reason?: string; zoro?: string; order_ids: string[]; color?: string; ready?: boolean; done?: boolean; unit?: string; parts?: { order_id: string; line_index: number; qty: number }[] };

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
