import type { AiGroupMenu, AiGroupRequest } from '../ai/contract.ts';
import { findDrink, lineName, optionNames, type MenuCatalog } from './menu.ts';
import type { BoardReview, Note, Order, OrderLine, ReviewGroup } from './types.ts';

// 위 4칸 묶기와 아래 일머리 팁 칸에 쓰는 코드. 순서와 잔 수·초 계산은 여기서 하고,
// Zoro는 1번(기준)과 2~4번이 비슷한지만 판단한다. 팁 문장과 빠른 주문 칸은 코드가 만든다.
//
// 코드가 먼저 정하는 것: 디카페인·오트밀크처럼 batch_blocking 옵션이 붙은 줄은 같이 못 만든다(Zoro에 보내지 않음).
// 같은 메뉴끼리는 aiserver가 Zoro에 묻지 않고 바로 묶는다. Zoro는 이름이 다른 메뉴 짝만 판단한다.

// 1번(기준) 묶음 색. 위 4칸의 카드 하이라이트와 아래 작업 카드가 같은 묶음이면 같은 색을 쓴다.
export const anchorColor = '#ff2e93';
// 묶음별 색. 1번 묶음(기준 주문이 낀 묶음)은 항상 핫핑크, 그다음 묶음부터 네온 톤을 돌아가며 쓴다.
// 빠른 주문 칸 노랑과는 겹치지 않는 색만 고른다.
export const taskPalette = [anchorColor, '#2dd4ff', '#b14aff', '#22e67a', '#ff8a3d'] as const;

export function taskLineColors(notes: Note[]): Record<string, string> {
  return Object.fromEntries(notes.flatMap((note) => note.kind === 'task' && note.color
    ? (note.parts ?? []).map(({ order_id, line_index }) => [`${order_id}:${line_index}`, note.color!])
    : []));
}

// 같이 만들기 기준은 재료와 만드는 기계다. "얼음 준비"(얼음 기계)는 거의 모든 아이스 음료에 들어가서 기준에서 뺀다.
// 얼음만 같이 쓰는 메뉴(예: 아이스 아메리카노와 레몬에이드)는 같이 만들지 않는다.
export const iceEquipment = 'ice_dispenser';

export function mainEquipment(catalog: MenuCatalog, menu: string): string[] {
  return (findDrink(catalog, menu)?.equipment ?? []).filter((name) => name !== iceEquipment);
}

// 두 줄을 같이 만들 수 있는지: 같은 메뉴이거나, 얼음 말고 같은 기계를 쓴다.
export function sharesMainWork(a: Pick<OrderLine, 'menu'>, b: Pick<OrderLine, 'menu'>, catalog: MenuCatalog): boolean {
  if (a.menu === b.menu) return true;
  const theirs = new Set(mainEquipment(catalog, b.menu));
  return mainEquipment(catalog, a.menu).some((name) => theirs.has(name));
}

const usesIce = (catalog: MenuCatalog, menu: string) => findDrink(catalog, menu)?.equipment.includes(iceEquipment) ?? false;

// 이 줄이 기준 주문 줄들과 "얼음 준비"로만 이어지나: 얼음 말고 같이 쓰는 기계가 없고(같은 메뉴도 아님), 얼음은 둘 다 쓴다.
// 아무것도 겹치지 않는 메뉴는 여기서 빼지 않고 예전처럼 Zoro가 판단한다.
export function linkedOnlyByIce(anchorLines: Pick<OrderLine, 'menu'>[], line: Pick<OrderLine, 'menu'>, catalog: MenuCatalog): boolean {
  if (anchorLines.some((mine) => sharesMainWork(mine, line, catalog))) return false;
  return usesIce(catalog, line.menu) && anchorLines.some((mine) => usesIce(catalog, mine.menu));
}

// 주문 단위: 같이 만들 수 있는 줄(막는 옵션 없는 줄)이 모두 기준 주문과 얼음으로만 이어지면 Zoro에 묻기 전에 뺀다.
export function onlyIceWithAnchor(anchor: Order, other: Order, catalog: MenuCatalog): boolean {
  const open = (order: Order) => order.menu_items.filter((line) => !isBlockingLine(line, catalog));
  const anchorLines = open(anchor);
  const lines = open(other);
  return lines.length > 0 && anchorLines.length > 0 && lines.every((line) => linkedOnlyByIce(anchorLines, line, catalog));
}

export const iceOnlyReason = '얼음 말고 같이 쓰는 기계가 없어서';

// 같이 만들 수 있는 줄만 메뉴로 보낸다. 같은 메뉴가 여러 줄이면 한 번만 보낸다. 얼음 기계는 Zoro에 보내지 않는다(얼음으로 비슷하다고 보지 않게).
export function groupMenus(order: Order, catalog: MenuCatalog): AiGroupMenu[] {
  const menus = new Map<string, AiGroupMenu>();
  for (const line of order.menu_items) {
    if (line.options.some((id) => catalog.options[id]?.batch_blocking)) continue;
    const drink = findDrink(catalog, line.menu);
    if (drink && !menus.has(drink.id)) menus.set(drink.id, { id: drink.id, name: drink.name_kr, equipment: mainEquipment(catalog, drink.id), steps: drink.steps ?? [] });
  }
  return [...menus.values()];
}

// ---- 일머리 팁 제조 블록: 같이 만드는 메뉴끼리 한 블록 ----

// 같이 만들 줄을 블록으로 나눈다. 같은 메뉴이거나 얼음 말고 같은 기계를 쓰면 한 블록이다(이어진 줄끼리 모두 한 블록).
// 디카페인·오트처럼 막는 옵션이 붙은 줄은 같은 막는 옵션끼리만 같은 블록이 된다. 반환값은 줄 번호 묶음(처음 나온 순서).
export function taskBlocks(lines: OrderLine[], catalog: MenuCatalog): number[][] {
  const parent = lines.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  const blocking = (line: OrderLine) => line.options.filter((id) => catalog.options[id]?.batch_blocking).sort().join('+');
  lines.forEach((a, i) => lines.forEach((b, j) => {
    if (j <= i || blocking(a) !== blocking(b) || !sharesMainWork(a, b, catalog)) return;
    parent[root(j)] = root(i);
  }));
  const blocks = new Map<number, number[]>();
  lines.forEach((_, index) => blocks.set(root(index), [...(blocks.get(root(index)) ?? []), index]));
  return [...blocks.values()];
}

// 블록 문장. 메뉴마다 잔 수를 더하고, 만드는 법을 바꾸는 옵션만 괄호로 붙인다(빨대 같은 포장 옵션은 주문 카드에 있다).
// 예: "딸기 스무디 1잔 · 망고 스무디 1잔 만들기", "아이스 아메리카노 2잔(연하게 1잔) 만들기"
export function taskText(lines: OrderLine[], catalog: MenuCatalog): string {
  const entries = new Map<string, { name: string; unit: string; qty: number; variants: Map<string, number> }>();
  for (const line of lines) {
    const key = `${line.menu}:${line.size}`;
    const entry = entries.get(key) ?? { name: lineName(catalog, line), unit: lineUnit(catalog, line), qty: 0, variants: new Map<string, number>() };
    entry.qty += line.qty;
    const making = line.options.filter((id) => catalog.options[id] && catalog.options[id].label !== 'packaging_only').map((id) => catalog.options[id].name_kr.replace(/\s*\(.*\)$/, ''));
    if (making.length) entry.variants.set(making.join(', '), (entry.variants.get(making.join(', ')) ?? 0) + line.qty);
    entries.set(key, entry);
  }
  const text = [...entries.values()].map(({ name, unit, qty, variants }) => {
    const options = [...variants].map(([option, count]) => (count === qty ? option : `${option} ${count}${unit}`)).join(', ');
    return `${name} ${qty}${unit}${options ? `(${options})` : ''}`;
  });
  return `${text.join(' · ')} 만들기`;
}

// batch_blocking 옵션이 붙어 같이 못 만드는 이유. 문장 가운데에 넣는 말이다(예: "#104 카페 라떼는 디카페인이라 원두를 바꿔야 해서 따로 만들어요").
const blockingWhy: Record<string, string> = {
  decaf: '디카페인이라 원두를 바꿔야 해서',
  milk_oat: '오트밀크라 피처를 따로 써야 해서',
};

// 모든 줄에 batch_blocking 옵션이 붙어 같이 만들 수 없는 주문의 이유
export function blockingReason(order: Order, catalog: MenuCatalog): string | undefined {
  if (groupMenus(order, catalog).length > 0) return undefined;
  const options = [...new Set(order.menu_items.flatMap((line) => line.options.filter((id) => catalog.options[id]?.batch_blocking)))];
  if (!options.length) return undefined;
  return blockingWhy[options[0]] ?? `${optionNames(catalog, options).join(', ')} 옵션이라`;
}

// 1번(anchor)과 2~4번의 메뉴·레시피를 aiserver에 보낸다. 1번에 같이 만들 줄이 없으면 묻지 않는다(undefined).
export function buildGroupRequest(anchorId: string, ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): AiGroupRequest | undefined {
  const anchor = orders.get(anchorId);
  const anchorMenus = anchor ? groupMenus(anchor, catalog) : [];
  if (!anchorMenus.length) return undefined;
  const others = ids.flatMap((id) => {
    const order = orders.get(id);
    if (id === anchorId || !order || order.status === 'done') return [];
    const menus = groupMenus(order, catalog);
    return menus.length ? [{ id, menus }] : [];
  });
  return { anchor: anchorId, orders: [{ id: anchorId, menus: anchorMenus }, ...others] };
}

// aiserver가 준 1번 묶음을 화면용으로 바꾼다. 맨 앞 주문 중 남아 있는 것만, 짝이 하나라도 있을 때만 쓴다.
export function groupViews(anchorId: string | undefined, groups: Record<string, number>, scores: Record<string, number>, present: Set<string>): Record<string, ReviewGroup> {
  if (!anchorId || !present.has(anchorId) || groups[anchorId] === undefined) return {};
  const companions = Object.keys(groups).filter((id) => id !== anchorId && groups[id] === groups[anchorId] && present.has(id));
  if (!companions.length) return {};
  const size = companions.length + 1;
  return {
    [anchorId]: { id: 1, label: '기준', color: anchorColor, size, role: 'anchor' },
    ...Object.fromEntries(companions.map((id) => [id, { id: 1, label: '같이 만들기', color: anchorColor, size, role: 'companion', score: scores[id] } satisfies ReviewGroup])),
  };
}

// 디저트는 "개", 음료는 "잔"
export function lineUnit(catalog: MenuCatalog, line: Pick<OrderLine, 'menu'>): string {
  return findDrink(catalog, line.menu)?.category === 'dessert' ? '개' : '잔';
}

// "카페 라떼 2잔, 딸기 스무디 1잔". 같은 메뉴는 잔 수를 더한다.
export function cupsText(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): string {
  return linesText(ids.flatMap((id) => orders.get(id)?.menu_items ?? []), catalog);
}

function linesText(lines: OrderLine[], catalog: MenuCatalog): string {
  const cups = new Map<string, { qty: number; unit: string }>();
  for (const line of lines) {
    const name = lineName(catalog, line);
    cups.set(name, { qty: (cups.get(name)?.qty ?? 0) + line.qty, unit: lineUnit(catalog, line) });
  }
  return [...cups].map(([name, { qty, unit }]) => `${name} ${qty}${unit}`).join(', ');
}

const isBlockingLine = (line: OrderLine, catalog: MenuCatalog) => line.options.some((id) => catalog.options[id]?.batch_blocking);

// 같이 만들 수 있는 잔만 센 이름. 2잔 중 1잔이 디카페인이면(요청사항으로 나뉜 줄) "#102 카페 라떼 1잔"
function groupableName(id: string, orders: Map<string, Order>, catalog: MenuCatalog): string {
  const lines = (orders.get(id)?.menu_items ?? []).filter((line) => !isBlockingLine(line, catalog));
  return lines.length ? `${id} ${linesText(lines, catalog)}` : orderName(id, orders, catalog);
}

// 같이 만드는 주문 안에서 따로 만드는 잔과 이유. 예: "#102 카페 라떼 1잔은 디카페인이라 원두를 바꿔야 해서 따로 만들어요."
// 주문 전체가 막힌 경우는 apartText(코드가 뺀 주문)가 쓴다.
export function splitApartText(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): string | undefined {
  const parts = ids.flatMap((id) => {
    const lines = orders.get(id)?.menu_items ?? [];
    const blocked = lines.filter((line) => isBlockingLine(line, catalog));
    if (!blocked.length || blocked.length === lines.length) return [];
    const option = blocked[0].options.find((optionId) => catalog.options[optionId]?.batch_blocking)!;
    const name = `${id} ${linesText(blocked, catalog)}`;
    return [`${name}${josa(name, ['은', '는'])} ${blockingWhy[option] ?? `${optionNames(catalog, [option]).join('')} 옵션이라`}`];
  });
  return parts.length ? `${parts.join(', ')} 따로 만들어요.` : undefined;
}

// 받침에 맞는 조사. pair는 [받침 있을 때, 없을 때]. 예: josa('1잔', ['을', '를']) → '을'
function josa(word: string, [withFinal, withoutFinal]: [string, string]): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return withFinal;
  return code % 28 ? withFinal : withoutFinal;
}

const orderName = (id: string, orders: Map<string, Order>, catalog: MenuCatalog) => `${id} ${cupsText([id], orders, catalog)}`;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).map((name) => `${name}${josa(name, ['과', '와'])}`).join(' ')} ${names.at(-1)}`;
}

// 왜 같이 만드는지 한 문장. 같은 메뉴인지, 어떤 장비를 같이 쓰는지는 코드가 레시피에서 찾는다(Zoro는 비슷한지만 판단).
const sharedWorkReasons: [string, string][] = [
  ['espresso_machine', '둘 다 에스프레소 샷이 들어가서 샷을 한 번에 뽑으면 돼요.'],
  ['steam_wand', '둘 다 우유 스팀이 필요해서 한 번에 스팀하면 돼요.'],
  ['blender', '둘 다 블렌더를 써서 이어서 갈면 헹구는 횟수가 줄어요.'],
  ['ice_cream_freezer', '둘 다 아이스크림이라 냉동고를 한 번만 열면 돼요.'],
  ['hot_water', '둘 다 뜨거운 물을 받아서 이어서 만들면 돼요.'],
];

export function togetherReason(anchor: Order, other: Order, catalog: MenuCatalog): string {
  const menus = (order: Order) => new Set(groupMenus(order, catalog).map(({ id }) => id));
  const anchorMenus = menus(anchor);
  if ([...menus(other)].some((id) => anchorMenus.has(id))) return '같은 메뉴라 한 번에 만들면 돼요.';
  const equipment = (order: Order) => new Set(groupMenus(order, catalog).flatMap((menu) => menu.equipment));
  const mine = equipment(anchor);
  const theirs = equipment(other);
  return sharedWorkReasons.find(([id]) => mine.has(id) && theirs.has(id))?.[1] ?? '만드는 순서가 비슷해서 이어서 만들면 손이 덜 가요.';
}

function togetherLines(anchorId: string, companions: string[], orders: Map<string, Order>, catalog: MenuCatalog): { text: string; detail: string } {
  const anchor = orders.get(anchorId)!;
  const anchorName = orderName(anchorId, orders, catalog);
  const names = companions.map((id) => groupableName(id, orders, catalog));
  const together = joinNames(names);
  const reasons = companions.map((id) => togetherReason(anchor, orders.get(id)!, catalog));
  const detail = new Set(reasons).size === 1 ? reasons[0] : companions.map((id, index) => `${id}는 ${reasons[index].replace(/^둘 다 /, '')}`).join(' ');
  return { text: `${anchorName}${josa(anchorName, ['을', '를'])} 만들 때 ${together}도 같이 만드세요.`, detail };
}

// 1번 카드. 쉬운 문장 두세 개로 쓴다: 무엇을 만들지, 무엇을 같이 만들지, 왜 같이 만드는지.
// 1번을 앞 주문과 같이 만들어 뒀으면(made) 포장만 남았다고 알리고, 다음에 만들 기준 주문(anchor)과 그 짝을 적는다.
// status가 checking이면 Zoro 답을 기다리는 중, unavailable이면 Zoro가 답하지 못한 것이라 "같이 만들 주문이 없어요"라고 하지 않는다.
export function headNote(head: Order, anchorId: string | undefined, companions: string[], orders: Map<string, Order>, catalog: MenuCatalog, status: BoardReview['status'] = 'ready'): { text: string; detail: string } {
  const headName = orderName(head.order_id, orders, catalog);
  const pending = status === 'checking' ? 'Zoro가 같이 만들 주문을 찾고 있어요.' : status === 'unavailable' ? 'Zoro가 답하지 못해서 같이 만들 주문은 고르지 못했어요. 순서대로 만들어 주세요.' : undefined;
  if (anchorId === head.order_id) {
    if (pending) return { text: `${headName}부터 만들어요.`, detail: pending };
    if (!companions.length) return { text: `${headName}부터 만들어요.`, detail: '같이 만들 주문은 없어요.' };
    return togetherLines(anchorId, companions, orders, catalog);
  }
  const first = head.made ? `${headName}${josa(headName, ['은', '는'])} 앞에서 같이 만들어 뒀어요. 포장만 하면 돼요.` : `${headName}${josa(headName, ['은', '는'])} 지금 만들 수 없어요.`;
  if (!anchorId) return { text: first, detail: '다음에 만들 주문은 없어요.' };
  const anchorName = orderName(anchorId, orders, catalog);
  if (pending || !companions.length) return { text: first, detail: `다음은 ${anchorName} 차례예요. ${pending ?? ''}`.trim() };
  const next = togetherLines(anchorId, companions, orders, catalog);
  return { text: first, detail: `다음은 ${next.text} ${next.detail}` };
}

// 따로 만드는 2~4번과 그 이유. 코드가 뺀 주문(디카페인, 고장)과 Zoro가 다르다고 본 주문을 한 문장으로 쓴다.
export function apartText(scores: Record<string, number>, excluded: Record<string, string>, threshold: number, orders: Map<string, Order>, catalog: MenuCatalog): string | undefined {
  const name = (id: string) => {
    const line = orders.get(id)?.menu_items[0];
    return line ? `${id} ${lineName(catalog, line)}` : id;
  };
  const parts = [
    ...Object.entries(scores).filter(([, score]) => score < threshold).map(([id]) => `${name(id)}${josa(name(id), ['은', '는'])} 만드는 방법이 달라서`),
    ...Object.entries(excluded).map(([id, why]) => `${name(id)}${josa(name(id), ['은', '는'])} ${why}`),
  ];
  return parts.length ? `${parts.join(', ')} 따로 만들어요.` : undefined;
}

// Zoro가 본 점수. 작은 글씨로 근거만 보여 준다.
export function zoroText(anchorId: string | undefined, scores: Record<string, number>, threshold: number): string | undefined {
  const entries = Object.entries(scores);
  if (!anchorId || !entries.length) return undefined;
  return `Zoro가 레시피를 읽고 ${anchorId}${josa(anchorId, ['과', '와'])} 비슷한 정도를 매겼어요(${threshold} 넘으면 같이): ${entries.map(([id, score]) => `${id} ${score.toFixed(2)}`).join(', ')}`;
}

// ---- 빠른 주문 칸(8번): 코드 규칙, Zoro 없음 ----
// 매장·포장 주문 중 모든 줄이 디저트(아이스크림, 티라미수 등)인 주문. 배달은 라이더가 올 때까지 녹거나 무르니 뺀다.
export function isQuickDessert(order: Order, catalog: MenuCatalog): boolean {
  if (order.status === 'done' || order.channel === 'delivery' || order.menu_items.length === 0) return false;
  return order.menu_items.every((line) => findDrink(catalog, line.menu)?.category === 'dessert');
}

// 주문에 손이 드는 시간(레시피 attended 합 × 수량). step_seconds가 없으면 첫 잔 시간을 쓴다.
export function handsSeconds(order: Order, catalog: MenuCatalog): number {
  return order.menu_items.reduce((sum, line) => {
    const drink = findDrink(catalog, line.menu);
    return sum + (drink?.hands_sec ?? drink?.first_cup_sec ?? 0) * line.qty;
  }, 0);
}

// 지금 만드는 작업(1번 기준 주문과 같이 만들 주문)에서 손이 비는 가장 긴 단계. 예: #101 샷 추출 30초
export type IdleWindow = { order_id: string; sec: number; label: string };

export function idleWindow(ids: string[], orders: Map<string, Order>, catalog: MenuCatalog): IdleWindow | undefined {
  let best: IdleWindow | undefined;
  for (const id of ids) {
    const order = orders.get(id);
    if (!order || order.made || order.status === 'done') continue;
    for (const line of order.menu_items) {
      const idle = findDrink(catalog, line.menu)?.idle;
      if (idle && (!best || idle.sec > best.sec)) best = { order_id: id, sec: idle.sec, label: idle.label };
    }
  }
  return best;
}

// 손이 비는 단계를 문장 속 말로. 예: "샷 추출" → "샷이 내려가는"
const idlePhrases: Record<string, string> = { '샷 추출': '샷이 내려가는', 블렌더: '블렌더가 도는', '티 우리기': '티가 우러나는', 그릴: '그릴이 굽는' };

export function quickLaneText(order: Order, fifoPosition: number, visibleFifo: number, hands: number, idle: IdleWindow | undefined, catalog: MenuCatalog, orders: Map<string, Order>): { ready: boolean; text: string; detail: string; reason: string } {
  const ready = !!idle && idle.sec >= hands;
  const name = orderName(order.order_id, orders, catalog);
  const reason = `원래 순서는 ${fifoPosition}번째${fifoPosition > visibleFifo ? '라 화면에 안 보이지만' : '지만'} ${hands}초면 끝나서 먼저 내요.`;
  if (ready) {
    return { ready, text: `${idle!.order_id} ${idlePhrases[idle!.label] ?? '기계가 도는'} ${idle!.sec}초 동안 손이 비어요.`, detail: `그동안 ${name}${josa(name, ['을', '를'])} 먼저 내주세요.`, reason };
  }
  const detail = idle
    ? `지금 ${idle.order_id} ${idlePhrases[idle.label] ?? '기계가 도는'} ${idle.sec}초로는 조금 모자라요.`
    : '지금 만드는 주문에는 기다리는 단계가 없어요.';
  return { ready, text: `${name}${josa(name, ['은', '는'])} 손이 빌 때 먼저 내주세요.`, detail, reason };
}
