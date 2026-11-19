import { isBatchBlocking, riderEtaMs } from './facts.ts';
import { findDrink, lineName, optionNames, stockNeeded, type MenuCatalog } from './menu.ts';
import type { Order, OrderLine, WorkStep } from './types.ts';

// 작업창: 1~4번을 같이 보고 다음 완료(1번 주문)까지 할 일을 순서대로 쓴다. 마지막 줄은 "주문 #101 완료"다.
// 같은 입력이면 같은 줄이 나온다. 1번 완료 때 make 단계에 있던 주문은 made, prep 단계는 prepped가 된다(markWindowDone).
//
// 1. made가 아닌 1~4번 주문의 품목 줄을 모은다.
// 2. batch_blocking 옵션(디카페인, 오트밀크 등)이 붙은 줄은 따로 한 단계로 쓴다.
// 3. 나머지는 메뉴별로 묶는다. 예: "아이스 아메리카노 3잔 만들기 → #101 1잔 · #102 2잔"
// 4. 스무디는 그 주문이 1~2번이면 "갈기", 3~4번이면 "재료만 준비"로 쓴다. 갈면 90초 안에 나가야 한다.
//    3~4번 스무디 주문의 다른 음료는 같이 나가도록 그 주문이 2번 안으로 들어올 때 만든다.
// 5. 라이더가 가장 빨리 오는 주문이 들어 있는 묶음을 앞으로 보낸다. 1번이 이미 만들어져 있으면
//    자동으로 멈추는 샷 추출을 먼저 시작하고, 그동안 1번 포장을 한다.
// 6. made인 주문은 포장만 남는다. 포장은 그 주문이 1번일 때 쓴다(2~4번 포장을 미리 쓰면 매번 반복된다).
// 7. 마지막 줄은 { text: '주문 #(1번) 완료', kind: 'done' }이다.
// 8. 같은 계열(data/menu_groups.json, Zoro가 레시피로 만든 표) 메뉴는 연달아 놓는다. 단, 라이더가 오는 주문이 든 단계보다
//    앞으로 끌어오지는 않는다. 단계마다 group을 붙여 화면이 같은 계열을 같은 색으로 잇는다.

type Mode = 'make' | 'blend' | 'prep' | 'solo';
type Part = { order: Order; slot: number; line: OrderLine };
type Group = { mode: Mode; name: string; parts: Part[] };

const isBlended = (catalog: MenuCatalog, line: OrderLine) => findDrink(catalog, line.menu)?.temperature === 'BLENDED';

function partText(catalog: MenuCatalog, { order, line }: Part): string {
  const options = line.options.filter((id) => catalog.options[id]?.label !== 'packaging_only');
  const names = optionNames(catalog, options);
  return `${order.order_id} ${line.qty}잔${names.length ? `(${names.join(', ')})` : ''}`;
}

function groupStep(catalog: MenuCatalog, group: Group): WorkStep {
  const family = findDrink(catalog, group.parts[0].line.menu)?.group;
  return { ...baseStep(catalog, group), ...(family ? { group: family } : {}) };
}

function baseStep(catalog: MenuCatalog, group: Group): WorkStep {
  const total = group.parts.reduce((sum, { line }) => sum + line.qty, 0);
  const parts = group.parts.map((part) => partText(catalog, part)).join(' · ');
  const orders = [...new Set(group.parts.map(({ order }) => order.order_id))];
  if (group.mode === 'solo') {
    const blocking = optionNames(catalog, group.parts[0].line.options.filter((id) => catalog.options[id]?.batch_blocking));
    return { text: `${group.name} ${total}잔 따로 만들기 (${blocking.join(', ')}) → ${group.parts[0].order.order_id}`, orders, kind: 'make' };
  }
  if (group.mode === 'prep') return { text: `${group.name} ${total}잔 재료만 준비 → ${parts}`, orders, kind: 'prep' };
  return { text: `${group.name} ${total}잔 ${group.mode === 'blend' ? '갈기' : '만들기'} → ${parts}`, orders, kind: 'make' };
}

function packStep(catalog: MenuCatalog, head: Order): WorkStep {
  const packaging = [...new Set(head.menu_items.flatMap((line) => line.options.filter((id) => catalog.options[id]?.label === 'packaging_only')))];
  const extras = [...optionNames(catalog, packaging), ...(head.request_note ? [`메모 "${head.request_note}"`] : [])];
  return { text: `${head.order_id} ${head.channel === 'dine-in' ? '내기' : '포장'}${extras.length ? ` · ${extras.join(' · ')}` : ''}`, orders: [head.order_id], kind: 'pack' };
}

// 같은 계열 묶음을 연달아 놓는다. g 뒤로 같은 계열 h를 당길 때, 사이에 라이더가 오는 묶음이 있으면 당기지 않는다.
function chainFamilies(catalog: MenuCatalog, groups: Group[], riderFirst: (group: Group) => number): Group[] {
  const familyOf = (group: Group) => findDrink(catalog, group.parts[0].line.menu)?.group?.id;
  const rest = [...groups];
  const out: Group[] = [];
  while (rest.length) {
    const head = rest.shift()!;
    out.push(head);
    const family = familyOf(head);
    if (!family) continue;
    for (let i = 0; i < rest.length; ) {
      const between = rest.slice(0, i);
      if (familyOf(rest[i]) === family && between.every((group) => riderFirst(group) === Infinity)) out.push(...rest.splice(i, 1));
      else i += 1;
    }
  }
  return out;
}

export function buildWorkWindow(top4: Order[], catalog: MenuCatalog, blockedReason: (order: Order) => string | undefined = () => undefined): WorkStep[] {
  const head = top4[0];
  if (!head) return [];
  const groups = new Map<string, Group>();
  const holds: WorkStep[] = [];

  top4.forEach((order, index) => {
    const slot = index + 1;
    if (order.made) return;
    const blocked = blockedReason(order);
    if (blocked) {
      holds.push({ text: `${order.order_id} 보류 · ${blocked}`, orders: [], kind: 'prep' });
      return;
    }
    const later = slot > 2 && order.menu_items.some((line) => isBlended(catalog, line));
    if (later && order.prepped) return;
    order.menu_items.forEach((line, lineIndex) => {
      const blended = isBlended(catalog, line);
      if (later && !blended) return;
      const mode: Mode = blended ? (later ? 'prep' : 'blend') : isBatchBlocking(catalog, line) ? 'solo' : 'make';
      const key = mode === 'solo' ? `solo:${order.order_id}:${lineIndex}` : `${mode}:${line.menu}:${line.size}`;
      const group = groups.get(key) ?? { mode, name: lineName(catalog, line), parts: [] };
      group.parts.push({ order, slot, line });
      groups.set(key, group);
    });
  });

  // 라이더가 빨리 오는 주문이 든 묶음 → 앞 칸 주문이 든 묶음 순서. 재료 준비는 만들기 뒤에 둔다.
  const riderFirst = (group: Group) => Math.min(...group.parts.map(({ order }) => riderEtaMs(order) ?? Infinity));
  const firstSlot = (group: Group) => Math.min(...group.parts.map(({ slot }) => slot));
  const sorted = [...groups.values()].sort((a, b) => riderFirst(a) - riderFirst(b) || firstSlot(a) - firstSlot(b));
  const makes = chainFamilies(catalog, sorted.filter(({ mode }) => mode !== 'prep'), riderFirst);
  const preps = sorted.filter(({ mode }) => mode === 'prep');

  const steps: WorkStep[] = [...holds];
  const pack = packStep(catalog, head);
  if (head.made) {
    const espressoLines = makes.flatMap(({ parts }) => parts.map(({ line }) => line)).filter((line) => (findDrink(catalog, line.menu)?.espresso_shots ?? 0) > 0);
    const shots = stockNeeded(catalog, espressoLines).espresso_shot;
    if (shots > 0) steps.push({ text: `샷 추출 시작 (${shots}샷, 자동으로 멈춤) · 그동안 아래 포장`, orders: [], kind: 'prep' });
    steps.push(pack);
  }
  steps.push(...makes.map((group) => groupStep(catalog, group)), ...preps.map((group) => groupStep(catalog, group)));
  if (!head.made) steps.push(pack);
  steps.push({ text: `주문 ${head.order_id} 완료`, orders: [head.order_id], kind: 'done' });
  return steps;
}
