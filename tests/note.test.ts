import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiNoteAnswer } from '../app/ai/contract.ts';
import { menuCatalog } from '../app/domain/catalog-data.ts';
import { addNoteOption, applyNoteAnswers, cupCount, namesSomeCups, noteSentences, removeNoteOption, splitNote } from '../app/domain/note.ts';
import type { Order, OrderLine } from '../app/domain/types.ts';

const line = (menu: string, qty: number, options: string[] = []): OrderLine => ({ menu, qty, size: 'R', options });
const order = (lines: OrderLine[]): Order => ({
  order_id: '#102', channel: 'delivery', source: 'delivery_app', menu_items: lines, received_at: new Date(0).toISOString(), status: 'waiting', remaining_work_seconds: 0, price_krw: 0,
});
const answer = (id: string, kind: string, kindP: number, option: string, optionP: number, partial = 0.1, body = 0.01): AiNoteAnswer => ({ id, kind: { [kind]: kindP }, option: { [option]: optionP }, partial, body });

describe('splitting delivery notes into sentences', () => {
  it('splits on punctuation, line breaks, 그리고 and a sentence-final 요', () => {
    assert.deepEqual(splitNote('아아 2잔이요 하나는 샷 추가요. 담배 사다주실 수 있나요? 안 되면 취소할게요\n노크 없이 문 앞에 두세요'),
      ['아아 2잔이요', '하나는 샷 추가요.', '담배 사다주실 수 있나요?', '안 되면 취소할게요', '노크 없이 문 앞에 두세요']);
    assert.deepEqual(splitNote('얼음 적게 해주세요 그리고 덜 달게'), ['얼음 적게 해주세요', '덜 달게']);
    assert.deepEqual(splitNote('빨대 필요 없어요'), ['빨대 필요 없어요'], '필요 is not a sentence end');
    assert.deepEqual(splitNote('감사합니다!!'), ['감사합니다!']);
    assert.deepEqual(splitNote(undefined), []);
  });

  it('numbers the sentences of both fields, store first, and holds them until read', () => {
    const sentences = noteSentences('빨대 빼주세요', '문 앞에 두세요. 한 잔은 디카페인으로요');
    assert.deepEqual(sentences.map(({ id, field, text, hold }) => ({ id, field, text, hold })), [
      { id: 's1', field: 'store', text: '빨대 빼주세요', hold: true },
      { id: 's2', field: 'rider', text: '문 앞에 두세요.', hold: true },
      { id: 's3', field: 'rider', text: '한 잔은 디카페인으로요', hold: true },
    ]);
  });

  it('counts cups from Korean words and takes the smallest when there are several', () => {
    assert.equal(cupCount('한 잔은 디카페인'), 1);
    assert.equal(cupCount('하나는 연하게'), 1);
    assert.equal(cupCount('두 잔 중 한 잔은'), 1);
    assert.equal(cupCount('2잔은 얼음 적게'), 2);
    assert.equal(cupCount('연하게요'), 1);
  });

  it('treats a cup count followed by 은/는/만 as some cups, but not a shot count', () => {
    assert.equal(namesSomeCups('하나는 연하게요'), true);
    assert.equal(namesSomeCups('한 잔은 디카페인으로요'), true);
    assert.equal(namesSomeCups('2잔만 얼음 적게'), true);
    assert.equal(namesSomeCups('샷 하나 추가해주세요'), false);
    assert.equal(namesSomeCups('하나 더 주세요'), false);
  });
});

describe('putting memo options on order lines', () => {
  it('splits only the asked cups, replaces an option of the same group, and merges back on revert', () => {
    const added = addNoteOption([line('latte', 3, ['shot_add'])], menuCatalog, 'shot_light', 1);
    assert.equal(added.cups, 1);
    assert.deepEqual(added.lines, [
      line('latte', 2, ['shot_add']),
      { ...line('latte', 1, ['shot_light']), note_options: ['shot_light'] },
    ]);
    assert.deepEqual(removeNoteOption(added.lines, 'shot_light'), [line('latte', 2, ['shot_add']), line('latte', 1)]);
    const decaf = addNoteOption([line('latte', 2)], menuCatalog, 'decaf', 1);
    assert.deepEqual(removeNoteOption(decaf.lines, 'decaf'), [line('latte', 2)]);
  });

  it('skips menus that cannot take the option and lines that already have it', () => {
    const result = addNoteOption([line('strawberry_smoothie', 1), line('iced_americano', 1, ['no_straw'])], menuCatalog, 'no_straw');
    assert.equal(result.cups, 1);
  });
});

describe('judgment 1: how much of the note goes on the card (Zoro confidence + store policy)', () => {
  const read = (lines: OrderLine[], text: string, field: 'store' | 'rider', a: AiNoteAnswer) => {
    const sentences = noteSentences(field === 'store' ? text : undefined, field === 'rider' ? text : undefined);
    return applyNoteAnswers(order(lines), sentences, [{ ...a, id: sentences[0].id }], menuCatalog);
  };

  it('applies with a warning when Zoro is fairly sure, and does not apply when it is unsure', () => {
    const fair = read([line('iced_americano', 1)], '연하게요', 'store', answer('s1', 'recipe', 0.95, 'shot_light', 0.8));
    assert.deepEqual({ applied: fair.sentences[0].applied, check: fair.sentences[0].check, hold: fair.sentences[0].hold }, { applied: true, check: '확실하지 않아요. 맞는지 봐 주세요', hold: false });
    const unsure = read([line('iced_americano', 1)], '지난번처럼요', 'store', answer('s1', 'recipe', 0.95, 'shot_light', 0.4));
    assert.deepEqual({ applied: unsure.sentences[0].applied, check: unsure.sentences[0].check, hold: unsure.sentences[0].hold }, { applied: false, check: '"연하게 (샷 1개)"인지 확실하지 않아요', hold: true });
    assert.deepEqual(unsure.lines, [line('iced_americano', 1)]);
    const vague = read([line('latte', 1)], '잘 부탁해요', 'store', answer('s1', 'recipe', 0.5, 'none', 0.9));
    assert.equal(vague.sentences[0].check, '무슨 요청인지 확실하지 않아요');
  });

  it('shows an unlisted recipe request raw and holds it, but does not hold an unlisted packing request', () => {
    const foam = read([line('latte', 1)], '거품 없이 해주세요', 'store', answer('s1', 'recipe', 0.93, 'unlisted', 0.9));
    assert.deepEqual({ applied: foam.sentences[0].applied, check: foam.sentences[0].check, hold: foam.sentences[0].hold }, { applied: false, check: '옵션 목록에 없는 요청이에요', hold: true });
    const carrier = read([line('latte', 1)], '캐리어에 담아주세요', 'store', answer('s1', 'packing', 0.93, 'unlisted', 0.9));
    assert.equal(carrier.sentences[0].hold, false);
  });

  it('never changes the menu for a body-condition note and names the milk', () => {
    const result = read([line('latte', 1)], '아이가 우유 알레르기가 있어요', 'store', answer('s1', 'other', 0.9, 'none', 0.9, 0.1, 0.96));
    assert.deepEqual(result.lines, [line('latte', 1)]);
    assert.equal(result.sentences[0].check, '몸 상태 메모예요. 카페 라떼에 우유가 들어가요');
    assert.equal(result.sentences[0].hidden, false);
  });

  it('adds the delivery and other probabilities because both mean "not a store job"', () => {
    const sentences = noteSentences(undefined, '문 앞에 두세요');
    const result = applyNoteAnswers(order([line('latte', 1)]), sentences, [{ id: 's1', kind: { delivery: 0.5, other: 0.3, packing: 0.2 }, option: { none: 0.9 }, partial: 0.1, body: 0.01 }], menuCatalog);
    assert.deepEqual({ kind: result.sentences[0].kind, confidence: result.sentences[0].confidence, hidden: result.sentences[0].hidden, check: result.sentences[0].check }, { kind: 'delivery', confidence: 0.8, hidden: true, check: undefined });
  });

  it('keeps a delivery-only sentence off the card only when it is in the rider field', () => {
    const rider = read([line('latte', 1)], '문 앞에 두세요', 'rider', answer('s1', 'other', 0.96, 'none', 0.9));
    const store = read([line('latte', 1)], '문 앞에 두세요', 'store', answer('s1', 'other', 0.96, 'none', 0.9));
    assert.deepEqual([rider.sentences[0].hidden, store.sentences[0].hidden], [true, false]);
  });
});
