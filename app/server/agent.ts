import type { Signals, StoreEvent } from '../domain/types.ts';
import type { OrderView } from '../domain/views.ts';
import { inventoryLevel, orderUsage, type InventoryItem, type InventoryLevel } from './inventory.ts';

// 일머리 마법사(목업 에이전트). 재고, 보드의 주문 순서, 최근 처리량을 보고 바리스타에게 할 말을 만든다.
// 숫자와 순서 계산은 코드가 하고 문장은 템플릿으로 만든다. 무엇을 먼저 보여 줄지는 나중에 Zoro 판단으로 바꿀 수 있다.

export type AgentMessage = {
  id: string;
  level: 'danger' | 'warn' | 'info';
  topic: string;
  text: string;
  at?: string;
  action?: { kind: 'restock'; item_id: string; label: string };
};

// 재고 목록 한 줄. 화면에는 소모량을 보여 주고, 급한 순서(status)로 정렬한다. 채우기는 마법사 대화에서 한다.
export type InventoryView = {
  id: string;
  name_kr: string;
  level: InventoryLevel;
  status: StockStatus;
  status_label: string;
  used_recent: string;
  used_today: string;
  used_today_real: string;
  note: string;
  menus: string[];
};

export type UsageSummary = Map<string, { recent: number; today: number; todayReal: number }>;

export type AgentContext = {
  items: InventoryItem[];
  usage: Map<string, Map<string, number>>;
  // 화면에 보이는 순서: 1~4번 고정, 5~8번 후보, 그 뒤 대기열
  orders: OrderView[];
  recent: { minutes: number; byItem: Map<string, number>; cups: number };
  events: StoreEvent[];
  equipment: Signals['store']['equipment_status'];
};

const equipmentLabels: Record<string, string> = { blender: '블렌더', espresso_machine: '에스프레소 머신', steam_wand: '스팀 완드' };
const storeEventCategories = ['spill_cleanup', 'stock_shortage', 'equipment_failure', 'equipment_recovered'];
const rateWarnMinutes = 30;
// 요약 말고 한 번에 보낼 알림 수. 위험, 주의, 안내 순서로 자른다.
const maxMessages = 4;
const levelRank = { danger: 0, warn: 1, info: 2 } as const;

export function formatAmount(amount: number, unit: string): string {
  const value = Math.max(0, amount);
  if (unit === 'g') return value >= 1000 ? `${(value / 1000).toFixed(1)}kg` : `${Math.round(value)}g`;
  if (unit === 'ml') return value >= 1000 ? `${(value / 1000).toFixed(1)}L` : `${Math.round(value)}ml`;
  return `${Math.round(value)}개`;
}

// 받침에 맞춰 이/가를 붙인다.
export function withSubjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}이(가)`;
  return `${word}${code % 28 === 0 ? '가' : '이'}`;
}

function orderName(orders: OrderView[], index: number): string {
  return index < 8 ? `${index + 1}번 주문 ${orders[index].order_id}` : `대기열 ${orders[index].order_id}`;
}

// 재고 하나의 급한 정도. 메시지와 재고 목록이 같은 판단을 쓴다.
// status 순서: 보드 주문 중 부족(short) > 지금 위험(danger) > 보드 주문을 만들다 위험(board_danger) > 곧 위험(soon) > 주의(warn) > 여유(ok)
export type StockStatus = 'short' | 'danger' | 'board_danger' | 'soon' | 'warn' | 'ok';
const statusRank: Record<StockStatus, number> = { short: 0, danger: 1, board_danger: 2, soon: 3, warn: 4, ok: 5 };

export type StockAssessment = {
  item: InventoryItem;
  status: StockStatus;
  need: number;
  shortAt?: number;
  dangerAt?: number;
  rate: number;
  minutesToDanger?: number;
  // 이 재료를 가장 많이 쓰는 메뉴와, 그 메뉴로 몇 잔 분량이 남았는지
  topMenu?: string;
  servingsLeft?: number;
  menus: string[];
};

export function assessStock(item: InventoryItem, ctx: Pick<AgentContext, 'usage' | 'orders' | 'recent'>): StockAssessment {
  let need = 0;
  let shortAt: number | undefined;
  let dangerAt: number | undefined;
  ctx.orders.forEach((order, index) => {
    const amount = orderUsage(order, ctx.usage).get(item.id) ?? 0;
    if (amount === 0) return;
    need += amount;
    if (shortAt === undefined && need > item.on_hand) shortAt = index;
    if (dangerAt === undefined && inventoryLevel(item, item.on_hand - need) === 'danger') dangerAt = index;
  });
  const level = inventoryLevel(item);
  const rate = (ctx.recent.byItem.get(item.id) ?? 0) / ctx.recent.minutes;
  const minutesToDanger = rate > 0 && level !== 'danger' ? (item.on_hand - item.danger_below) / rate : undefined;
  const perMenu = [...(ctx.usage.get(item.id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const [topMenu, topAmount] = perMenu[0] ?? [];
  const status: StockStatus = shortAt !== undefined ? 'short'
    : level === 'danger' ? 'danger'
    : dangerAt !== undefined ? 'board_danger'
    : minutesToDanger !== undefined && minutesToDanger < rateWarnMinutes ? 'soon'
    : level === 'warn' ? 'warn' : 'ok';
  return {
    item, status, need, shortAt, dangerAt, rate, minutesToDanger, topMenu,
    servingsLeft: topAmount ? Math.floor(item.on_hand / topAmount) : undefined,
    menus: perMenu.map(([menu]) => menu),
  };
}

function compareStock(a: StockAssessment, b: StockAssessment): number {
  return statusRank[a.status] - statusRank[b.status]
    || (a.shortAt ?? a.dangerAt ?? Infinity) - (b.shortAt ?? b.dangerAt ?? Infinity)
    || (a.minutesToDanger ?? Infinity) - (b.minutesToDanger ?? Infinity)
    || a.item.on_hand / a.item.full - b.item.on_hand / b.item.full;
}

function stockMessage(stock: StockAssessment, orders: OrderView[]): AgentMessage | undefined {
  const { item } = stock;
  const name = withSubjectParticle(item.name_kr);
  const left = formatAmount(item.on_hand, item.unit);
  // 바리스타가 실제로 채운 뒤 누르는 버튼이다. 누르면 주문 단위(reorder_qty)만큼 재고가 늘어난다.
  const action = { kind: 'restock' as const, item_id: item.id, label: `${item.reorder_label} 채웠어요` };
  const id = `stock-${item.id}`;
  switch (stock.status) {
    case 'short':
      return { id, level: 'danger', topic: `${item.name_kr} 부족`, action,
        text: `${orderName(orders, stock.shortAt!)}부터 ${name} 모자라요. 지금 ${left} 남았는데 보드 주문에는 ${formatAmount(stock.need, item.unit)} 필요해요.` };
    case 'danger':
      return { id, level: 'danger', topic: `${item.name_kr} 위험`, action,
        text: `${name} ${left} 남아 위험 단계예요. ${item.reorder_label} 단위로 채워 주세요.` };
    case 'board_danger':
      return { id, level: 'warn', topic: `${item.name_kr} 주의`, action,
        text: `${orderName(orders, stock.dangerAt!)}까지 만들면 ${name} 위험 단계로 내려가요. 지금 ${left} 남았어요.` };
    case 'soon':
      return { id, level: 'warn', topic: `${item.name_kr} 소모 속도`, action,
        text: `지금 속도(분당 ${formatAmount(stock.rate, item.unit)})면 약 ${Math.max(1, Math.round(stock.minutesToDanger!))}분 뒤 ${name} 위험 단계예요.` };
    case 'warn':
      return { id, level: 'warn', topic: `${item.name_kr} 주의`, action,
        text: `${name} ${left} 남아 주의 단계예요. 여유 있을 때 채워 두세요.` };
    default:
      return undefined;
  }
}

export function agentMessages(ctx: AgentContext, limit = maxMessages): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const [name, status] of Object.entries(ctx.equipment)) {
    if (status === 'broken') messages.push({ id: `equipment-${name}`, level: 'danger', topic: '장비', text: `${withSubjectParticle(equipmentLabels[name] ?? name)} 점검 중이에요. 이 장비가 필요한 메뉴는 시작할 수 없어요.` });
  }
  for (const stock of ctx.items.map((item) => assessStock(item, ctx)).sort(compareStock)) {
    const message = stockMessage(stock, ctx.orders);
    if (message) messages.push(message);
  }
  for (const event of ctx.events.filter(({ category }) => storeEventCategories.includes(category)).slice(0, 3)) {
    messages.push({ id: `event-${event.event_id}`, level: event.needs_confirmation ? 'warn' : 'info', topic: '매장 상황', text: event.summary, at: event.received_at });
  }
  messages.sort((a, b) => levelRank[a.level] - levelRank[b.level]);
  const shown = messages.slice(0, limit);
  const hidden = messages.length - shown.length;

  const cups = ctx.orders.reduce((sum, order) => sum + order.items.reduce((total, { qty }) => total + qty, 0), 0);
  const recent = Math.round(ctx.recent.cups);
  const summary = ctx.orders.length === 0
    ? `기다리는 주문이 없어요. 최근 ${ctx.recent.minutes}분 동안 ${recent}잔을 만들었어요.`
    : `보드에 ${ctx.orders.length}건, ${cups}잔이 기다리고 있어요. 최근 ${ctx.recent.minutes}분 동안 ${recent}잔을 만들었어요.`;
  const tail = messages.length === 0 ? ' 재고는 모두 여유 있어요.' : hidden > 0 ? ` 아래 알림 말고도 ${hidden}건이 더 있어요.` : '';
  return [{ id: 'summary', level: 'info', topic: '지금 상황', text: `${summary}${tail}` }, ...shown];
}

const statusLabels: Record<StockStatus, string> = { short: '부족 예정', danger: '위험', board_danger: '곧 위험', soon: '곧 위험', warn: '주의', ok: '여유' };

function stockNote(stock: StockAssessment, orders: OrderView[]): string {
  const parts: string[] = [];
  if (stock.status === 'short') parts.push(`${orderName(orders, stock.shortAt!)}부터 모자람`);
  else if (stock.status === 'board_danger') parts.push(`${orderName(orders, stock.dangerAt!)}까지 만들면 위험`);
  else if (stock.minutesToDanger !== undefined && stock.minutesToDanger < 120) parts.push(`약 ${Math.max(1, Math.round(stock.minutesToDanger))}분 뒤 위험`);
  if (stock.topMenu && stock.servingsLeft !== undefined) parts.push(`${stock.topMenu} 기준 ${stock.servingsLeft}잔 분량`);
  return parts.join(', ');
}

// 왼쪽 패널 재고 목록: 모든 재고를 급한 순서로
export function inventoryViews(ctx: Pick<AgentContext, 'items' | 'usage' | 'orders' | 'recent'>, used: UsageSummary = new Map()): InventoryView[] {
  return ctx.items
    .map((item) => assessStock(item, ctx))
    .sort(compareStock)
    .map((stock) => {
      const { item } = stock;
      const usage = used.get(item.id) ?? { recent: 0, today: 0, todayReal: 0 };
      return {
        id: item.id,
        name_kr: item.name_kr,
        level: inventoryLevel(item),
        status: stock.status,
        status_label: statusLabels[stock.status],
        used_recent: formatAmount(usage.recent, item.unit),
        used_today: formatAmount(usage.today, item.unit),
        used_today_real: formatAmount(usage.todayReal, item.unit),
        note: stockNote(stock, ctx.orders),
        menus: stock.menus,
      };
    });
}
