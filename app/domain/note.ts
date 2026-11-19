import type { AiNoteAnswer, AiNoteRequest } from '../ai/contract.ts';
import { exclusiveOptionGroups, findDrink, lineName, type MenuCatalog } from './menu.ts';
import type { NoteField, NoteKind, NoteSentence, Order, OrderLine } from './types.ts';

// 배달 요청사항 읽기. 가게 칸과 배달 칸 메모를 문장으로 나누고(코드), 문장마다 Zoro가 뜻과 확신을 답하면(aiserver /ai/read-note)
// 이 파일이 그 확신에 기준선을 대서 카드에 무엇을 할지 정한다.
//
// 판단 1. 카드에 반영할까? Zoro의 확신만큼 맡긴다.
//   - 확신 높음(auto 이상): 바로 옵션을 붙인다.
//   - 중간(check 이상): 붙이고 ⚠. 알바가 되돌릴 수 있다.
//   - 낮음, 목록에 없는 요청: 붙이지 않고 원문 + ⚠.
//   가게 정책(확신과 상관없이): 돈 드는 옵션은 결제 확인 ⚠, 몸 상태 이야기는 ⚠만 띄우고 바꾸지 않음,
//   취소·메뉴 밖 부탁은 만들기 전에 확인 ⚠.
// 판단 2(1번과 같이 만들까)는 hold와 붙인 옵션(batch_blocking)으로 order-store와 review.ts가 정한다.

// body: 몸 상태 ⚠. Zoro-1 실측에서 진짜(알레르기·임신)는 0.81~0.99, "한 잔은 디카페인으로요"가 0.51이라 0.7로 둔다.
export const noteThresholds = { auto: 0.9, check: 0.7, body: 0.7, partial: 0.5 };
export const maxNoteSentences = 10;
const UNLISTED = 'unlisted';

// 문장 나누기. 마침표·물음표·느낌표·줄바꿈, "그리고", 문장 끝 "~요" 뒤 띄어쓰기에서 자른다("필요 없어요"는 자르지 않는다).
export function splitNote(text: string | undefined): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?。])\s*|\n+|\s+그리고\s+|(?<=[^필\s]요)[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /[가-힣A-Za-z0-9]/.test(part));
  if (parts.length <= maxNoteSentences) return parts;
  return [...parts.slice(0, maxNoteSentences - 1), parts.slice(maxNoteSentences - 1).join(' ')];
}

// 두 칸을 문장 목록으로. 아직 읽기 전이라 아무것도 반영하지 않았고, 읽을 때까지 1번과 같이 만들지 않는다(hold).
export function noteSentences(store: string | undefined, rider: string | undefined): NoteSentence[] {
  const fields: [NoteField, string | undefined][] = [['store', store], ['rider', rider]];
  const texts = fields.flatMap(([field, text]) => splitNote(text).map((part) => ({ field, text: part })));
  return texts.slice(0, maxNoteSentences).map(({ field, text }, index) => ({
    id: `s${index + 1}`, field, text, applied: false, hidden: false, hold: true, moved: false, resolved: false,
  }));
}

// Zoro에 보낼 요청. 옵션 선택지는 그 주문 메뉴에서 고를 수 있는 옵션(recipe.json available_options)이다.
export function noteRequest(order: Order, sentences: NoteSentence[], catalog: MenuCatalog): AiNoteRequest {
  const optionIds = [...new Set(order.menu_items.flatMap((line) => findDrink(catalog, line.menu)?.options ?? []))];
  return {
    order_id: order.order_id,
    menu: order.menu_items.map((line) => `${lineName(catalog, line)} ${line.qty}잔`).join(', '),
    options: optionIds.flatMap((id) => (catalog.options[id] ? [{ id, name: catalog.options[id].name_kr }] : [])),
    sentences: sentences.map(({ id, text }) => ({ id, text })),
  };
}

// Zoro가 답하지 못했을 때: 원문을 보여 주고 ⚠, 확인될 때까지 묶지 않는다(모르면 같이 만들지 않는 쪽이 안전하다).
export function unreadSentences(sentences: NoteSentence[], check = 'Zoro가 메모를 읽지 못했어요. 직접 확인하세요'): NoteSentence[] {
  return sentences.map((sentence) => ({ ...sentence, applied: false, hidden: false, hold: true, moved: false, resolved: false, check }));
}

// AI 서버가 없을 때: 예전처럼 메모 원문만 보여 준다(⚠·보류 없음).
export function plainSentences(sentences: NoteSentence[]): NoteSentence[] {
  return sentences.map((sentence) => ({ ...sentence, hold: false }));
}

// "한 잔은", "하나는", "두 잔" 같은 말에서 잔 수를 뽑는다. 여러 개면 가장 작은 수(예: "두 잔 중 한 잔은" → 1), 없으면 1.
const cupWords: [RegExp, number][] = [[/(한|1)\s*잔|하나|한\s*개/, 1], [/(두|2)\s*잔|둘/, 2], [/(세|3)\s*잔|셋/, 3], [/(네|4)\s*잔|넷/, 4]];
export function cupCount(text: string): number {
  const found = cupWords.filter(([pattern]) => pattern.test(text)).map(([, n]) => n);
  return found.length ? Math.min(...found) : 1;
}

// "하나는", "한 잔은", "두 잔만"처럼 잔 수 뒤에 은/는/만이 붙으면 일부 잔 이야기다. 잔 수는 코드 몫이라 Zoro 답(partial)과 함께 본다.
// Zoro-1 실측에서 "하나는 연하게요"의 partial이 0.47로 기준 아래였다. "샷 하나 추가"는 잔이 아니라 걸리지 않는다.
export function namesSomeCups(text: string): boolean {
  return /(^|\s)(한|두|세|네|[1-4])\s*잔\s*(은|는|만)|(^|\s)(하나|둘|셋)\s*(은|는|만)/.test(text);
}

const sameGroup = (a: string, b: string) => a === b || exclusiveOptionGroups.some((group) => group.includes(a) && group.includes(b));

function withOption(line: OrderLine, option: string, qty: number): OrderLine {
  return {
    ...line,
    qty,
    options: [...line.options.filter((id) => !sameGroup(id, option)), option].sort(),
    note_options: [...(line.note_options ?? []).filter((id) => !sameGroup(id, option)), option].sort(),
  };
}

// 옵션을 붙인다. cups가 있으면 그 잔 수만 줄을 나눠 붙이고(2잔 → 1잔 기본 + 1잔 옵션), 없으면 고를 수 있는 줄 전부에 붙인다.
// 이미 그 옵션이 붙은 줄과 그 옵션을 고를 수 없는 메뉴는 건너뛴다.
export function addNoteOption(lines: OrderLine[], catalog: MenuCatalog, option: string, cups?: number): { lines: OrderLine[]; cups: number } {
  const out: OrderLine[] = [];
  let left = cups;
  let applied = 0;
  for (const line of lines) {
    const eligible = findDrink(catalog, line.menu)?.options.includes(option) && !line.options.includes(option);
    if (!eligible || left === 0) {
      out.push(line);
      continue;
    }
    const take = left === undefined ? line.qty : Math.min(left, line.qty);
    if (take < line.qty) out.push({ ...line, qty: line.qty - take }, withOption(line, option, take));
    else out.push(withOption(line, option, line.qty));
    applied += take;
    if (left !== undefined) left -= take;
  }
  return { lines: out, cups: applied };
}

// 메모로 붙인 옵션을 되돌린다. 나눴던 줄은 같은 내용이면 다시 합친다.
export function removeNoteOption(lines: OrderLine[], option: string): OrderLine[] {
  const merged: OrderLine[] = [];
  const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((id, index) => id === b[index]);
  for (const line of lines) {
    const stripped = line.note_options?.includes(option)
      ? { ...line, options: line.options.filter((id) => id !== option), note_options: line.note_options.filter((id) => id !== option) }
      : { ...line };
    if (stripped.note_options && stripped.note_options.length === 0) delete stripped.note_options;
    const twin = merged.find((other) => other.menu === stripped.menu && other.size === stripped.size && same(other.options, stripped.options) && same(other.note_options, stripped.note_options));
    if (twin) twin.qty += stripped.qty;
    else merged.push(stripped);
  }
  return merged;
}

function top(probabilities: Record<string, number>): [string, number] {
  return Object.entries(probabilities).reduce<[string, number]>((best, entry) => (entry[1] > best[1] ? entry : best), ['', -1]);
}

// 문장 종류와 확신. 배달 기사 몫(delivery)과 그 밖의 말(other)은 같은 행동(가게 일 아님)이라 확률을 더해 가게 일(recipe·packing·confirm)과 견준다.
function kindOf(probabilities: Record<string, number>): [NoteKind, number] {
  const p = (label: string) => probabilities[label] ?? 0;
  const notStore = p('delivery') + p('other');
  const [storeKind, storeP] = top({ recipe: p('recipe'), packing: p('packing'), confirm: p('confirm') });
  if (notStore >= storeP) return [p('delivery') > p('other') ? 'delivery' : 'other', notStore];
  return [storeKind as NoteKind, storeP];
}

// 판단 1. Zoro의 답(뜻 + 확신)으로 카드를 고친다. 새 메뉴 줄과 문장별 결과를 돌려준다.
export function applyNoteAnswers(order: Order, sentences: NoteSentence[], answers: AiNoteAnswer[], catalog: MenuCatalog): { lines: OrderLine[]; sentences: NoteSentence[] } {
  let lines = order.menu_items;
  const totalCups = lines.reduce((sum, line) => sum + line.qty, 0);
  const read = sentences.map((sentence): NoteSentence => {
    const answer = answers.find(({ id }) => id === sentence.id);
    if (!answer) return unreadSentences([sentence])[0];
    const [kind, kindP] = kindOf(answer.kind);
    const [option, optionP] = top(answer.option);
    const base: NoteSentence = { ...sentence, kind, confidence: round(kindP), applied: false, hidden: false, hold: false, moved: false, resolved: false, check: undefined };
    const notStore = kind === 'delivery' || kind === 'other';
    const moved = sentence.field === 'rider' && !notStore;
    let result: NoteSentence;
    if (kindP < noteThresholds.check) {
      result = { ...base, check: '무슨 요청인지 확실하지 않아요', hold: true };
    } else if (notStore) {
      result = { ...base, hidden: sentence.field === 'rider' };
    } else if (kind === 'confirm') {
      result = { ...base, moved, check: '만들기 전에 확인하세요', hold: true };
    } else {
      const known = option !== UNLISTED && Boolean(catalog.options[option]) && lines.some((line) => findDrink(catalog, line.menu)?.options.includes(option));
      const confidence = round(Math.min(kindP, optionP));
      const name = catalog.options[option]?.name_kr ?? option;
      if (!known) {
        result = { ...base, moved, check: '옵션 목록에 없는 요청이에요', hold: kind === 'recipe' };
      } else if (confidence < noteThresholds.check) {
        result = { ...base, moved, option, confidence, check: `"${name}"인지 확실하지 않아요`, hold: kind === 'recipe' };
      } else {
        const partial = totalCups > 1 && (answer.partial >= noteThresholds.partial || namesSomeCups(sentence.text));
        const added = addNoteOption(lines, catalog, option, partial ? cupCount(sentence.text) : undefined);
        if (added.cups === 0) {
          result = { ...base, moved, option, confidence };   // 이미 그 옵션이 붙어 있다
        } else {
          lines = added.lines;
          const price = catalog.options[option].price_krw;
          const checks = [
            confidence < noteThresholds.auto ? '확실하지 않아요. 맞는지 봐 주세요' : '',
            price > 0 ? `결제 확인 +${(price * added.cups).toLocaleString('ko-KR')}원` : '',
          ].filter(Boolean);
          result = { ...base, moved, option, confidence, cups: added.cups, applied: true, check: checks.join(' · ') || undefined };
        }
      }
    }
    // 가게 정책: 몸 상태 이야기는 메뉴를 바꾸지 않고 ⚠만 띄운다. 우유가 들어간 메뉴면 그렇게 적는다.
    if (answer.body >= noteThresholds.body) {
      const milk = lines.filter((line) => findDrink(catalog, line.menu)?.allergens?.includes('milk')).map((line) => lineName(catalog, line));
      const bodyCheck = milk.length ? `몸 상태 메모예요. ${[...new Set(milk)].join(', ')}에 우유가 들어가요` : '몸 상태 메모예요. 메뉴를 확인하세요';
      result = { ...result, hidden: false, check: [result.check, bodyCheck].filter(Boolean).join(' · ') };
    }
    return result;
  });
  return { lines, sentences: read };
}

const round = (value: number) => Math.round(value * 100) / 100;

// 확인되지 않은 메모가 있으면 1번과 같이 만들지 않는 이유. 문장 가운데에 넣는 말이다.
export function noteHoldReason(order: Order): string | undefined {
  const note = order.note_read;
  if (!note) return undefined;
  if (note.status === 'checking') return '메모를 읽는 중이라';
  return note.sentences.some(({ hold, resolved }) => hold && !resolved) ? '메모를 확인하기 전이라' : undefined;
}

// 카드에 쓰는 한 줄. 반영했으면 "메모 반영: 1잔 디카페인", 아니면 원문. 배달 칸에 적힌 가게 일은 "배달 칸 메모".
export function noteLabel(sentence: NoteSentence, catalog: MenuCatalog): string {
  const where = sentence.moved ? '배달 칸 메모' : sentence.field === 'rider' ? '배달 칸' : '메모';
  if (sentence.applied && sentence.option) return `${where} 반영: ${sentence.cups}잔 ${catalog.options[sentence.option]?.name_kr ?? sentence.option}`;
  return `${where} "${sentence.text}"`;
}
