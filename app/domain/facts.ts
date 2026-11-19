import { workLeftSeconds } from './board.ts';
import { findDrink, formatDuration, lineName, optionNames, type MenuCatalog } from './menu.ts';
import type { Order, OrderLine, OwnerLimits } from './types.ts';
import { channelLabels, riderLabels } from './views.ts';

// 4번 고르기에 쓰는 후보별 사실. 룰이 쓸 숫자와 Zoro가 읽을 문장 한 줄을 같이 만든다.
// 종합 점수는 만들지 않는다. 종합 점수로 줄을 세우면 그게 룰이고, Zoro가 할 일이 없어진다.
// 시간은 "5분 10초"처럼 사람이 읽는 말로 넣는다. Zoro에게 시각 두 개를 주고 빼기를 시키지 않는다.

export type Fact = {
  line: string;              // Zoro에 보낼 문장
  receivedAt: number;        // 접수 시각(ms)
  slackSec: number;          // 4번일 때 마감까지 여유. 매장·포장은 접수 + max_wait_sec, 배달은 라이더 도착 시각
  waitPushedSec?: number;    // 매장·포장: 한 칸 밀리면 나갈 때까지 기다린 시간
  latePushedSec?: number;    // 배달: 한 칸 밀리면 라이더보다 늦는 시간
};

export type FactContext = { orders: Map<string, Order>; catalog: MenuCatalog; limits: OwnerLimits; now: number };

// 아이스 음료가 이보다 오래 기다리면 얼음이 녹는다. 스무디는 간 뒤 90초 안에 나가야 한다.
const iceHoldSec = 300;
export const smoothieHoldSec = 90;

// 10초 단위로 반올림해 "9분 30초"처럼 쓴다.
export function say(seconds: number): string {
  return formatDuration(Math.round(Math.abs(seconds) / 10) * 10);
}

function lineText(catalog: MenuCatalog, line: OrderLine): string {
  const options = optionNames(catalog, line.options);
  return `${lineName(catalog, line)} ${line.qty}잔${options.length ? `(${options.join(', ')})` : ''}`;
}

export function menuText(catalog: MenuCatalog, order: Order): string {
  return order.menu_items.map((line) => lineText(catalog, line)).join(', ');
}

// 같이 만들 수 없는 옵션(recipe.json options batch_blocking: 디카페인, 오트밀크 등)이 붙은 줄.
export function isBatchBlocking(catalog: MenuCatalog, line: OrderLine): boolean {
  return line.options.some((id) => catalog.options[id]?.batch_blocking);
}

export function riderEtaMs(order: Order): number | undefined {
  if (order.channel !== 'delivery' || !order.rider_eta_at) return undefined;
  return Date.parse(order.rider_eta_at);
}

export function riderText(order: Order, now: number): string | undefined {
  if (order.channel !== 'delivery') return undefined;
  const eta = riderEtaMs(order);
  if (eta === undefined) return order.rider_status ? riderLabels[order.rider_status] : undefined;
  if (eta <= now) return `라이더 도착함 (${say((now - eta) / 1000)} 기다림)`;
  return `라이더 ${say((eta - now) / 1000)} 뒤`;
}

function noteTexts(order: Order): string[] {
  return [
    order.request_note ? `메모 "${order.request_note}"` : '',
    order.needs_confirmation ? '픽업 시간 확인 중' : '',
  ].filter(Boolean);
}

// 1~3번(지금 만드는 주문)의 한 줄. 예: "아이스 아메리카노 2잔 · 배달 · 다 만듦 · 라이더 1분 10초 뒤"
export function lockedLine(order: Order, ctx: Pick<FactContext, 'catalog' | 'now'>): string {
  return [
    menuText(ctx.catalog, order),
    channelLabels[order.channel],
    order.made ? '다 만듦' : order.prepped ? '재료 준비됨' : '',
    riderText(order, ctx.now) ?? '',
    ...noteTexts(order),
  ].filter(Boolean).join(' · ');
}

// 1~3번 중 같은 메뉴를 같이 만들 수 있는 주문. 미리 만든 주문은 이미 끝났으니 뺀다.
function batchTexts(candidate: Order, locked: Order[], catalog: MenuCatalog): string[] {
  const texts: string[] = [];
  locked.forEach((other, index) => {
    if (other.made) return;
    const shared = candidate.menu_items.find((line) => !isBatchBlocking(catalog, line)
      && other.menu_items.some((mine) => mine.menu === line.menu && mine.size === line.size && !isBatchBlocking(catalog, mine)));
    if (shared) texts.push(`${index + 1}번 ${other.order_id} 주문과 ${lineName(catalog, shared)} 같이 만들기 가능`);
  });
  return texts;
}

function cautionTexts(order: Order, catalog: MenuCatalog, finish4: number): string[] {
  const eta = riderEtaMs(order);
  if (eta === undefined || eta <= finish4) return [];
  const idle = (eta - finish4) / 1000;
  const temps = new Set(order.menu_items.map((line) => findDrink(catalog, line.menu)?.temperature));
  const texts: string[] = [];
  if (temps.has('BLENDED') && idle > smoothieHoldSec) texts.push(`4번이면 라이더 오기 ${say(idle)} 전에 나옴 (스무디는 간 뒤 90초 안에 나가야 함)`);
  else if (temps.has('ICE') && idle > iceHoldSec) texts.push(`4번이면 라이더 오기 ${say(idle)} 전에 나와 얼음이 녹음`);
  return texts;
}

// 받침에 맞춰 을/를을 붙인다. say()의 결과는 "분" 또는 "초"로 끝난다.
function withObject(text: string): string {
  return text.endsWith('초') ? `${text}를` : `${text}을`;
}

// 기준 문장은 "4번에 안 넣으면 어떻게 되나"로 쓴다. "기준 넘김"을 그 주문의 나쁜 점으로 읽고 피하지 않도록,
// 기준을 넘기는 건 이 주문을 4번에 넣지 않았을 때라는 게 문장에 드러나야 한다(Zoro 실험, 2026-11-19).
function storeStandard(waited4: number, waitedPushed: number, limit: number): string {
  const standard = withObject(`기준 ${say(limit)}`);
  if (waited4 > limit) return `4번에 넣어도 ${say(waited4)}에 나가 ${standard} 넘김, 안 넣으면 ${say(waitedPushed)}에 나감`;
  if (waitedPushed > limit) return `4번에 안 넣으면 ${say(waitedPushed)}에 나가 ${standard} 넘김 (4번이면 ${say(waited4)})`;
  return `4번에 안 넣어도 ${say(waitedPushed)}에 나가 기준 ${say(limit)} 안`;
}

function deliveryStandard(late4: number, latePushed: number, ok: number): string {
  if (latePushed <= 0) return '4번에 안 넣어도 라이더보다 먼저 나옴';
  const verdict = latePushed > ok ? `늦어 ${withObject(`기준 ${say(ok)}`)} 넘김` : `늦지만 기준 ${say(ok)} 안`;
  return `4번에 안 넣으면 라이더보다 ${say(latePushed)} ${verdict}${late4 > 0 ? ` (4번이어도 ${say(late4)} 늦음)` : ''}`;
}

// locked: 새 1~3번(칸 순서), candidates: 4번 후보(들어온 순서).
export function buildFacts(lockedIds: string[], candidateIds: string[], ctx: FactContext): Map<string, Fact> {
  const { catalog, limits, now } = ctx;
  const locked = lockedIds.map((id) => ctx.orders.get(id)!);
  const cands = candidateIds.map((id) => ctx.orders.get(id)!);
  const start4 = now + locked.reduce((sum, order) => sum + workLeftSeconds(order, now), 0) * 1000;   // 4번 시작 시각
  return new Map(cands.map((c) => {
    const receivedAt = Date.parse(c.received_at);
    const prep = workLeftSeconds(c, now) * 1000;
    const others = cands.filter((x) => x !== c).map((x) => workLeftSeconds(x, now) * 1000);
    const finish4 = start4 + prep;                                             // 4번이면 끝나는 시각
    const finishPushed = finish4 + (others.length ? Math.min(...others) : 0);  // 한 칸 밀리면 끝나는 시각
    const eta = riderEtaMs(c);
    const fact: Fact = { line: '', receivedAt, slackSec: 0 };
    let standard = '';
    if (c.channel === 'delivery' && eta !== undefined) {
      fact.slackSec = (eta - finish4) / 1000;
      fact.latePushedSec = (finishPushed - eta) / 1000;
      standard = deliveryStandard((finish4 - eta) / 1000, fact.latePushedSec, limits.delivery_late_ok_sec);
    } else {
      fact.slackSec = (receivedAt + limits.max_wait_sec * 1000 - finish4) / 1000;
      if (c.channel !== 'delivery') {
        fact.waitPushedSec = (finishPushed - receivedAt) / 1000;
        standard = storeStandard((finish4 - receivedAt) / 1000, fact.waitPushedSec, limits.max_wait_sec);
      }
    }
    fact.line = [
      menuText(catalog, c),
      channelLabels[c.channel],
      `${say((now - receivedAt) / 1000)} 기다림`,
      riderText(c, now) ?? '',
      standard,
      ...batchTexts(c, locked, catalog),
      ...cautionTexts(c, catalog, finish4),
      c.made ? '다 만듦' : c.prepped ? '재료 준비됨' : '',
      ...noteTexts(c),
      c.overtaken ? `${c.overtaken}번 밀림` : '',
    ].filter(Boolean).join(' · ');
    return [c.order_id, fact];
  }));
}
