import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiGroupRequest, AiGroupResult, AiNoteRequest, AiNoteResult } from '../app/ai/contract.ts';
import { boardConfig, menuCatalog } from '../app/domain/catalog-data.ts';
import type { AiClient, AiResult } from '../app/server/aiserver.ts';
import { OrderStore } from '../app/server/order-store.ts';
import { RunLog, formatRunLog, josa, withRo, type RunLogEntry } from '../app/server/run-log.ts';

// aiserver 대역. 메모는 문장별로 정해 둔 답을 주고, 묶기는 1번과 같은 메뉴가 있는 주문만 묶는다.
const answers: Record<string, Omit<AiNoteResult['sentences'][number], 'id'>> = {
  '문 앞에 두세요.': { kind: { other: 0.96, recipe: 0.02 }, option: { none: 0.9 }, partial: 0.05, body: 0.01 },
  '한 잔은 디카페인으로요': { kind: { recipe: 0.97, other: 0.01 }, option: { decaf: 0.95, none: 0.03 }, partial: 0.93, body: 0.02 },
  '하나는 연하게요.': { kind: { recipe: 0.95 }, option: { shot_light: 0.93 }, partial: 0.47, body: 0.01 },
  '빨대는 빼주세요.': { kind: { packing: 0.94 }, option: { no_straw: 0.96 }, partial: 0.1, body: 0.01 },
  '노크하지 말고 문 앞에 두세요': { kind: { other: 0.95 }, option: { none: 0.8 }, partial: 0.1, body: 0.01 },
  '오시는 길에 편의점에서 담배 하나만 사다주세요.': { kind: { confirm: 0.92 }, option: { none: 0.9 }, partial: 0.1, body: 0.01 },
  '안 되면 취소할게요': { kind: { confirm: 0.9 }, option: { none: 0.9 }, partial: 0.1, body: 0.01 },
};
const readNote = async (request: AiNoteRequest): Promise<AiResult<AiNoteResult>> => ({
  ok: true, data: { fallback: false, sentences: request.sentences.map(({ id, text }) => ({ id, ...answers[text] })) },
});
const sameMenu = async (request: AiGroupRequest): Promise<AiResult<AiGroupResult>> => {
  const anchor = request.anchor!;
  const menus = (id: string) => request.orders.find((order) => order.id === id)!.menus.map(({ id: menu }) => menu);
  const others = request.orders.filter(({ id }) => id !== anchor).map(({ id }) => id);
  const same = others.filter((id) => menus(id).some((menu) => menus(anchor).includes(menu)));
  return {
    ok: true,
    data: {
      groups: same.length ? Object.fromEntries([anchor, ...same].map((id) => [id, 1])) : {},
      scores: Object.fromEntries(others.map((id) => [id, same.includes(id) ? 0.93 : 0.05])),
      matched_menus: Object.fromEntries(same.map((id) => [id, menus(id).filter((menu) => menus(anchor).includes(menu))])),
      fallback: false,
    },
  };
};
const unreachable = async () => ({ ok: false as const, error: 'AI 서버에 연결하지 못했어요.' });

function storeWith(handlers: Partial<AiClient> = {}): OrderStore {
  const ai: AiClient = {
    decide: unreachable,
    classify: unreachable,
    pickNext: async () => { throw new Error('no slot 4 pick in FIFO'); },
    groupOrders: sameMenu,
    readNote,
    ...handlers,
  };
  return new OrderStore({ catalog: menuCatalog, config: { ...boardConfig, fifo: true, quickLane: true }, decideDelayMs: 0, ai });
}

const lines = (entries: RunLogEntry[]) => entries.map(({ step, by, text }) => `${step}/${by} ${text}`);
const indexOf = (entries: RunLogEntry[], pattern: RegExp) => {
  const index = lines(entries).findIndex((line) => pattern.test(line));
  assert.ok(index >= 0, `no log line matches ${pattern}\n${lines(entries).join('\n')}`);
  return index;
};

describe('agent run log', () => {
  it('records what came in, what Zoro answered, what the agent did, and the re-judgment that followed (SC-N #102)', async () => {
    const store = storeWith();
    store.loadScenario('SC-N');
    await store.settle();
    await store.runTrigger('SC-N', 0);
    await store.settle();
    const entries = store.runLogEntries({ scenario: 'SC-N' });

    const start = indexOf(entries, /^observe\/code 시나리오 SC-N 시작/);
    const arrived = indexOf(entries, /^observe\/customer #102 주문 들어옴: 카페 라떼 2잔 · 배달 · 배달 칸 "문 앞에 두세요. 한 잔은 디카페인으로요"$/);
    const asked = indexOf(entries, /^decide\/zoro Zoro에 #102 메모 2문장을 물음\(라벨: 문장 종류 5개, 이 주문 메뉴의 옵션 \d+개 \+ 목록에 없음\/없음\)$/);
    const answer = indexOf(entries, /^decide\/zoro #102 "한 잔은 디카페인으로요" → 종류 만드는 법 0\.97 · 옵션 디카페인 0\.95 · 일부 잔 0\.93 · 몸 상태 0\.02$/);
    const applied = indexOf(entries, /^act\/agent #102 "한 잔은 디카페인으로요": 배달 칸에 적힌 가게 일 · 카드에 1잔 디카페인을 붙임\(확신 0\.95 ≥ 자동 반영 0\.9\) · ⚠ 결제 확인 \+500원$/);
    const folded = indexOf(entries, /^act\/agent #102 "문 앞에 두세요\.": 가게 일이 아니라 카드에서 접어 둠\(확신 0\.96\)$/);
    const changed = indexOf(entries, /^observe\/code #102 옵션이 바뀜\(카페 라떼 1잔, 카페 라떼 1잔\(디카페인\) · 배달\) → 1번 기준 묶기를 다시 판단$/);
    const excluded = entries.findIndex((entry, index) => index > changed && entry.by === 'code' && entry.step === 'decide');
    const scored = indexOf(entries, /^decide\/zoro 1번 #101 카페 라떼 1잔 · 매장 기준 같이 만들기 점수: #102 0\.93 \(기준 0\.5\)$/);
    const grouped = indexOf(entries, /^act\/agent #102\(카페 라떼\)를 1번 #101과 같은 작업으로 묶음$/);

    assert.ok(start < arrived && arrived < asked && asked < answer && answer < applied && applied < changed && changed < scored && scored < grouped, lines(entries).join('\n'));
    assert.ok(folded > asked);
    assert.equal(excluded, -1, 'the decaf cup is a line of #102, not a whole order the code drops');
    assert.ok(entries.filter(({ by }) => by === 'zoro').every(({ step }) => step === 'decide'), 'Zoro only decides; the agent acts');
    assert.ok(entries[asked].ms !== undefined && entries[scored].ms !== undefined, 'aiserver calls carry their latency');
    assert.deepEqual(entries[answer].data?.kind, { recipe: 0.97, other: 0.01 }, 'the full probabilities stay in data');
  });

  it('logs code exclusions, the staff confirm, and the re-judgment after it (SC-N #104)', async () => {
    const store = storeWith();
    store.loadScenario('SC-N');
    for (const index of [0, 1, 2]) {
      await store.runTrigger('SC-N', index);
      await store.settle();
    }
    store.resolveNote('#104', 's1', 'confirm');
    store.resolveNote('#104', 's2', 'confirm');
    await store.settle();
    const entries = store.runLogEntries();
    indexOf(entries, /^act\/agent #104 "안 되면 취소할게요": 카드를 고치지 않고 ⚠ 만들기 전에 확인하세요 · 확인 전까지 1번과 같이 만들지 않음$/);
    indexOf(entries, /^decide\/code #104: 메모를 확인하기 전이라 Zoro에 묻지 않고 1번과 따로 만듦$/);
    const confirmed = indexOf(entries, /^observe\/staff 알바가 #104 메모 "안 되면 취소할게요"를 확인함$/);
    const rejudge = indexOf(entries, /^observe\/code #104 메모 확인이 끝남 → 1번 기준 묶기를 다시 판단$/);
    assert.ok(confirmed < rejudge);
    assert.match(lines(entries).slice(rejudge).join('\n'), /decide\/zoro 1번 #101 .* #104 0\.05/, 'Zoro is asked about #104 once it is confirmed');
  });

  it('logs the quick lane as a code rule and the staff serving it early (SC-Q)', async () => {
    const store = storeWith();
    store.loadScenario('SC-Q');
    await store.settle();
    const laneId = store.snapshot().quick_lane.order_id!;
    store.handleNote(`quick:${laneId}`);
    await store.settle();
    const entries = store.runLogEntries();
    indexOf(entries, /^decide\/code 8번 빠른 주문 후보 #110 티라미수 1개 · 포장\(원래 10번째\) · 내주는 데 \d+초 · #101 샷 추출 30초 동안 손이 빔$/);
    indexOf(entries, /^act\/agent 8번 칸에 "#110 지금 먼저 내주세요"를 띄움$/);
    indexOf(entries, /^decide\/code #104: .* Zoro에 묻지 않고 1번과 따로 만듦$/);
    indexOf(entries, /^observe\/staff 알바가 8번 빠른 주문 #110을 먼저 내보냄$/);
  });

  it('logs a Zoro failure and the safe default the agent took', async () => {
    const store = storeWith({ groupOrders: unreachable, readNote: unreachable });
    store.loadScenario('SC-N');
    await store.runTrigger('SC-N', 0);
    await store.settle();
    const entries = store.runLogEntries();
    indexOf(entries, /^decide\/zoro Zoro에 #102 메모 2문장을 물음.* → 답하지 못함\(AI 서버에 연결하지 못했어요\.\)$/);
    indexOf(entries, /^act\/agent #102 메모 원문을 ⚠로 띄워 알바에게 넘김$/);
  });

  it('keeps runs apart, finds the last run of a scenario, and formats readable lines', () => {
    let now = Date.parse('2026-11-20T03:30:05Z');
    const log = new RunLog(() => now, 3);
    log.start('SC-Q');
    log.add({ step: 'observe', by: 'customer', text: 'a' });
    log.start('SC-N');
    log.add({ step: 'decide', by: 'zoro', text: '#102 "한 잔은 디카페인으로요" → …', ms: 412.4 });
    now += 1000;
    log.add({ step: 'act', by: 'agent', text: '카드에 1잔 디카페인' });
    assert.deepEqual(log.list().map(({ text }) => text), ['#102 "한 잔은 디카페인으로요" → …', '카드에 1잔 디카페인']);
    assert.deepEqual(log.list({ scenario: 'SC-Q' }).map(({ text }) => text), ['a']);
    assert.equal(formatRunLog(log.list()), '[12:30:05] 판단(Zoro) #102 "한 잔은 디카페인으로요" → … (412ms)\n[12:30:06] 행동(에이전트) 카드에 1잔 디카페인');
    log.add({ step: 'act', by: 'agent', text: 'b' });
    assert.deepEqual(log.list({ scenario: 'SC-Q' }), [], 'only the last limit lines are kept');
  });

  it('picks particles from how order numbers and words are read', () => {
    assert.deepEqual(['#101', '#102', '#110', '#100', '#103', '#106'].map((id) => josa(id, '을', '를')), ['#101을', '#102를', '#110을', '#100을', '#103을', '#106을']);
    assert.equal(josa('#101', '과', '와'), '#101과');
    assert.equal(josa('#102', '과', '와'), '#102와');
    assert.equal(josa('연하게 (샷 1개)', '을', '를'), '연하게 (샷 1개)를', 'brackets are skipped');
    assert.equal(josa('"안 되면 취소할게요"', '을', '를'), '"안 되면 취소할게요"를');
    assert.equal(josa('Zoro', '을', '를'), 'Zoro을(를)', 'unknown endings keep both');
    assert.deepEqual(['#101', '#102', '#103'].map(withRo), ['#101로', '#102로', '#103으로']);
  });
});
