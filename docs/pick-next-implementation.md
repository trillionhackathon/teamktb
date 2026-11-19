# 4번 칸 고르기 구현 방법

1번 주문 완료 때 Zoro가 대기 중인 5~8번 주문 중 하나를 골라 4번 칸에 넣는 기능의 구현 순서다. 기준 코드는 `main` 3883a54(PR #8까지 머지)의 [app/server/order-store.ts](../app/server/order-store.ts), [app/domain/board.ts](../app/domain/board.ts), [app/ai/contract.ts](../app/ai/contract.ts), [app/server/aiserver.ts](../app/server/aiserver.ts)와 [aiserver-api.md](aiserver-api.md)다.

## 동작 규칙

| 항목 | 규칙 |
| --- | --- |
| 보드 | 8칸. 1~4번 고정, 5~8번 대기. 9번째부터는 화면 밖 대기열 |
| 트리거 | 1번 주문 완료 하나. 고정칸(1~4번)의 다른 주문이 먼저 완료돼도 같은 처리를 한다 |
| 당기기 | 2~4번 → 1~3번. 4번 칸이 빈다 |
| 4번 채우기 | 대기 5~8번 중 하나. 룰로 먼저 채우고, Zoro 답이 타임아웃 안에 오면 바꾼다 |
| 5~8번 순서 | 들어온 순서를 유지한다. 4번으로 가는 주문만 움직인다. 새 주문은 맨 뒤에 붙는다 |
| 작업창 | 1~4번을 같이 보고 다음 완료까지 할 일을 순서대로 쓴다. 마지막 줄은 "주문 ○ 완료" |
| 요청사항 | 들어온 순간 카드 내용을 고친다. 1~4번 주문이면 작업창도 다시 쓴다. 5~8번이면 다음 완료 때 반영된다 |
| 역할 | 숫자는 코드가 계산하고, Zoro는 사장님 기준을 보고 고르기만 한다. 확신이 0.7보다 낮거나 실패하면 룰이 고른다 |

이벤트별로 바뀌는 것:

| 이벤트 | 보드 | 작업창 | Zoro |
| --- | --- | --- | --- |
| 1번 완료 | 당기기 + 4번 채우기 | 다시 씀 | 4번 고르기 (choice 질문 1개) |
| 새 주문 | 맨 뒤 빈칸에 추가. 8칸이 차면 화면 밖 대기열 | 그대로 | 없음 |
| 요청사항·메시지 | 해당 카드 내용만 바꿈 | 1~4번 주문이면 다시 씀 | 없음 (메모 읽기는 다음 단계) |
| 재고·장비 이벤트 | 카드에 표시 | 1~4번에 영향이 있으면 다시 씀 | 없음 |

4번은 1~3번이 끝난 뒤에 만들기 시작하므로 Zoro 답이 1초쯤 걸려도 알바가 기다리지 않는다.

## 전체 흐름

```text
알바: 작업창 마지막 줄 "주문 ○ 완료"
  → teamktb: 1번 삭제, 2~4번 당김
  → teamktb: 후보(기존 5~8번)마다 사실 계산, 룰 선택 계산, 4번에 룰 선택을 먼저 넣음 (상태 "확인 중")
  → teamktb → aiserver: POST /ai/pick-next
  → aiserver → Zoro: POST /v1/systemone (choice 질문 1개)
  → Zoro: 후보별 확률
  → aiserver: 1등 ≥ 0.7이면 그 주문, 아니면 룰 선택
  → teamktb: 검증 후 4번 확정(필요하면 교체), 밀린 횟수 기록, 작업창 다시 씀, SSE 전송
```

## teamktb

### 1단계. 보드를 8칸, 4개 고정으로

[data/cafe_db.json](../data/cafe_db.json)의 `kds_board`를 고친다.

```json
"rows": 2, "cols": 4, "locked_count": 4,
"promotion_rule": "1번 완료 → 2~4번이 1~3번으로 → 5~8번 중 하나를 골라 4번에 넣고 고정"
```

`app/domain/catalog-data.ts`의 `boardConfig`는 `rows × cols`와 `locked_count`를 읽으므로 코드는 그대로 둔다. 10칸·5개 고정을 가정한 곳을 같이 고친다.

- `tests/ai-contract.test.ts`, `tests/domain.test.ts`, `tests/order-store.test.ts`의 기대값
- `app/dashboard.tsx`의 보드 표시
- `board.ts` `applyAiOrder`의 오류 문구 "1~5번 고정칸"

### 2단계. 이벤트마다 재정렬하는 호출을 끈다

지금 `OrderStore.commit()`은 상태가 바뀔 때마다 250ms 뒤 `runDecide()`를 예약하고, AI 서버가 없으면 `applyRule()`로 `ruleArrange()`를 돌린다. 둘 다 재배치칸을 다시 정렬한다.

- `commit()`은 버전을 올리고 `notify()`만 한다. 새 주문은 `board` 끝에 붙기만 하므로 5~8번이 들어온 순서로 남는다.
- 팁은 지금 `/ai/decide` 응답에 같이 온다. 팁을 유지하려면 `/ai/decide`를 팁 용도로만 계속 부르고 응답의 `orders`는 반영하지 않는다.

### 3단계. 완료 처리와 4번 채우기

`updateOrderStatus(orderId, 'complete')`의 완료 부분:

```ts
} else {
  order.status = 'done';
  order.completed_at = now;
  const index = this.state.board.indexOf(orderId);
  this.state.board.splice(index, 1);
  this.markWindowDone(orderId);                                  // 8단계
  if (index < this.deps.config.lockedCount) this.fillSlot4();    // 고정칸이 비면 4번 채우기
}
this.commit();
```

4번 채우기:

```ts
private fillSlot4(): void {
  const L = this.deps.config.lockedCount;                                  // 4
  const board = this.state.board;
  const locked = board.slice(0, L - 1);                                    // 새 1~3번
  const pool = board.slice(L - 1, this.deps.config.visibleCount - 1);      // 기존 5~8번 (지금은 4~7번 칸)
  const candidates = pool.filter((id) => {
    const o = this.state.orders.get(id)!;
    return o.status === 'waiting' && !this.isBlocked(o);
  });
  if (!candidates.length) return;
  const facts = buildFacts(locked, candidates, this.factContext());        // 4단계
  const rule = rulePickNext(candidates, this.state.orders, facts, ownerRules.limits);  // 6단계
  this.placeAt4(rule, { source: 'rule', status: this.deps.ai ? 'checking' : 'final', rule_pick: rule });
  this.rebuildWorkWindow();
  const seq = ++this.pickSeq;
  if (this.deps.ai) this.pending = this.askZoro(seq, locked, candidates, facts, rule);
  else this.finishPick(candidates);
}

private placeAt4(pick: string, info: Slot4Info): void {
  const L = this.deps.config.lockedCount;
  const rest = this.state.board.filter((id) => id !== pick);
  this.state.board = [...rest.slice(0, L - 1), pick, ...rest.slice(L - 1)];  // 나머지는 원래 순서
  this.state.slot4 = { order_id: pick, ...info };
}

private async askZoro(seq: number, locked: string[], candidates: string[], facts: Map<string, Fact>, rule: string) {
  const res = await this.deps.ai!.pickNext(toPickRequest(locked, candidates, facts, rule, this.now()));
  if (seq !== this.pickSeq) return;                     // 기다리는 사이 또 완료됐으면 버린다
  const L = this.deps.config.lockedCount;
  if (this.state.board[L - 1] !== rule) return;         // 그 사이 4번이 바뀌었으면 버린다
  if (res.ok && res.data.source === 'zoro' && candidates.includes(res.data.pick)) {
    if (res.data.pick !== rule) {
      this.placeAt4(res.data.pick, { source: 'zoro', status: 'final', rule_pick: rule, confidence: res.data.confidence });
    } else {
      this.state.slot4 = { ...this.state.slot4!, source: 'zoro', status: 'final', confidence: res.data.confidence };
    }
  } else {
    this.state.slot4 = { ...this.state.slot4!, status: 'final' };   // 실패·확신 낮음 → 룰 그대로
  }
  this.finishPick(candidates);
}

private finishPick(candidates: string[]): void {
  const pick = this.state.board[this.deps.config.lockedCount - 1];
  this.countOvertaken(candidates, pick);   // pick보다 먼저 접수된 후보의 overtaken +1
  this.rebuildWorkWindow();
  this.commit();
}
```

`app/domain/types.ts`의 `Order`에 필드를 추가한다.

| 필드 | 타입 | 뜻 |
| --- | --- | --- |
| `overtaken` | `number` | 4번 고르기에서 건너뛴 횟수. 지금 aiserver에 항상 0을 보내는 문제(aiserver-api.md 미결 항목)도 이걸로 해결한다 |
| `made` | `boolean` | 작업창에서 미리 만들어 둔 주문 |
| `rider_eta_at` | `string?` | 라이더·픽업 도착 시각. `pickup_eta_seconds`는 "지금부터 몇 초 뒤"라서 값을 받는 순간 `now + 초`로 바꿔 저장한다 (`addEvent`의 `activeTarget.pickup_eta_seconds = effect.seconds` 부분) |

`State`에는 `slot4?: Slot4Info`와 `workWindow: WorkStep[]`, 클래스에는 `pickSeq: number`를 둔다.

```ts
type Slot4Info = {
  order_id: string;
  source: 'zoro' | 'rule';
  status: 'checking' | 'final';
  rule_pick: string;
  confidence?: number;
};
```

### 4단계. 사실 만들기 — `app/domain/facts.ts` (새 파일)

후보마다 룰이 쓸 숫자와 Zoro가 읽을 문장 한 줄을 같이 만든다. **종합 점수는 만들지 않는다.** 종합 점수로 줄을 세우면 그게 룰이고, Zoro가 할 일이 없어진다.

```ts
export type Fact = {
  line: string;              // Zoro에 보낼 문장
  receivedAt: number;        // 접수 시각
  slackSec: number;          // 마감까지 여유 (4번일 때)
  waitPushedSec?: number;    // 매장·포장: 한 칸 밀리면 나갈 때까지 기다린 시간
  latePushedSec?: number;    // 배달: 한 칸 밀리면 라이더보다 늦는 시간
};

export function buildFacts(lockedIds: string[], candidateIds: string[], ctx: FactContext): Map<string, Fact> {
  const locked = lockedIds.map((id) => ctx.orders.get(id)!);
  const cands = candidateIds.map((id) => ctx.orders.get(id)!);
  const start4 = ctx.now + sum(locked.map((o) => remainingSeconds(o, ctx.now))) * 1000;   // 4번 시작 시각
  return new Map(cands.map((c) => {
    const prep = c.remaining_work_seconds * 1000;
    const others = cands.filter((x) => x !== c).map((x) => x.remaining_work_seconds * 1000);
    const finish4 = start4 + prep;                                     // 4번이면 끝나는 시각
    const finishPushed = finish4 + (others.length ? Math.min(...others) : 0);  // 한 칸 밀리면
    // 아래 표의 항목을 계산해 " · "로 이어 붙인다
    return [c.order_id, { line, receivedAt, slackSec, waitPushedSec, latePushedSec }];
  }));
}
```

| 항목 | 계산 | 문장 예 |
| --- | --- | --- |
| 메뉴·옵션 | `menu_items` + 카탈로그 이름 | 라떼 2 · 1잔 연하게 |
| 채널 | `channel` | 포장 |
| 기다린 시간 | 지금 − `received_at` | 4분 20초 기다림 |
| 매장·포장 기준 | `finishPushed − received_at`를 `limits.max_wait_sec`와 비교 | 4번이면 9분 30초에 나감, 밀리면 11분 넘음 (기준 10분 넘김) |
| 배달 기준 | `finishPushed − rider_eta_at`를 `limits.delivery_late_ok_sec`와 비교 | 라이더 3분 40초 뒤 · 4번이 아니면 1분 30초 늦음 (기준 2분 안) |
| 같이 만들기 | 1~3번 품목과 메뉴가 같고, 양쪽 다 `recipe.json` 옵션의 `batch_blocking`(디카페인, 오트밀크 등)이 없음 | 3번 #104와 블렌더 같이 |
| 주의 | 아이스인데 픽업까지 5분 넘게 남음 / 스무디(만든 뒤 90초) | 지금 만들면 얼음 녹음 |
| 메모 | `request_note`, `needs_confirmation` | 메모 "하나는 연하게요" / 메모 확인 중 |
| 밀린 횟수 | `overtaken` | 2번 밀림 |

시간은 "5분 10초"처럼 사람이 읽는 말로 바꿔 넣는다. Zoro에게 시각 두 개를 주고 빼기를 시키지 않는다.

### 5단계. 사장님 기준 — `data/owner_rules.json` (새 파일)

```json
{
  "sentences": [
    "매장·포장 손님은 10분을 넘기지 않는다",
    "배달은 라이더 도착보다 2분까지 늦어도 괜찮다"
  ],
  "limits": { "max_wait_sec": 600, "delivery_late_ok_sec": 120, "max_overtaken": 3 }
}
```

`sentences`는 Zoro에 보내고, `limits`는 사실 계산과 룰에 쓴다. 문장과 숫자가 같은 내용을 말하도록 같이 고친다.

### 6단계. 룰 — `app/domain/board.ts`에 추가

```ts
export function rulePickNext(cands: string[], orders: Map<string, Order>, facts: Map<string, Fact>, limits: Limits): string {
  const oldest = (ids: string[]) => ids.reduce((a, b) => (facts.get(a)!.receivedAt <= facts.get(b)!.receivedAt ? a : b));
  const starving = cands.filter((id) => (orders.get(id)!.overtaken ?? 0) >= limits.max_overtaken);
  if (starving.length) return oldest(starving);                                       // ① 3번 이상 밀린 주문
  const late = cands.filter((id) => (facts.get(id)!.latePushedSec ?? -Infinity) > limits.delivery_late_ok_sec);
  if (late.length) return late.reduce((a, b) => (facts.get(a)!.slackSec <= facts.get(b)!.slackSec ? a : b));  // ② 밀리면 기준 넘게 늦는 배달
  return oldest(cands);                                                                 // ③ 가장 오래 기다린 주문
}
```

`ruleArrange()`와 `applyAiOrder()`는 새 흐름에서 쓰지 않는다. 지우는 건 기존 테스트를 정리할 때 같이 한다.

### 7단계. aiserver 호출 — `app/ai/contract.ts`, `app/server/aiserver.ts`

```ts
// contract.ts
export type AiPickRequest = {
  now: string;                                   // ISO 8601 UTC
  baristas: number;
  owner_rules: string[];
  locked: { id: string; facts: string }[];       // 새 1~3번
  candidates: { id: string; facts: string }[];   // 들어온 순서
  rule_pick: string;
  examples: string[];                            // 알바가 고친 예시 (처음엔 빈 배열)
};

export type AiPickResult = {
  pick: string;
  source: AiSource;
  confidence: number;
  scores: Record<string, number>;
  fallback: boolean;
};

export function parsePickResult(value: unknown): AiPickResult | undefined { /* 필드 타입 검사 */ }

// aiserver.ts — AiClient 타입과 createAiClient에 추가
pickNext: (req) => post(baseUrl, '/ai/pick-next', req, timeoutMs, parsePickResult),
```

타임아웃은 지금처럼 `AISERVER_TIMEOUT_MS`(기본 1500ms)를 쓴다. `tests/ai-contract.test.ts`에 정상 응답, 형식 오류, 타임아웃 경우를 추가한다.

### 8단계. 작업창 — `app/domain/work-window.ts` (새 파일)

```ts
export type WorkStep = { text: string; orders: string[]; kind: 'make' | 'prep' | 'pack' | 'done' };
export function buildWorkWindow(top4: Order[], catalog: MenuCatalog): WorkStep[];
```

위에서부터 차례로 적용한다.

1. `made`가 아닌 1~4번 주문의 품목 줄을 모은다.
2. `batch_blocking` 옵션이 붙은 줄(디카페인, 오트밀크 등)은 따로 한 단계로 쓴다.
3. 나머지는 메뉴별로 묶는다. 예: "아이스 아메리카노 3잔 만들기 → #101 1잔 · #102 2잔"
4. 스무디는 그 주문이 1~2번이면 "갈기", 3~4번이면 "재료만 준비"로 쓴다. 갈면 90초 안에 나가야 한다.
5. 라이더가 가장 빨리 오는 주문이 들어 있는 묶음을 앞으로 보낸다. 자동으로 멈추는 샷 추출은 "추출 시작"을 먼저 쓰고, 그동안 할 포장 단계를 바로 뒤에 둔다.
6. `made`인 주문은 "포장" 단계만 쓴다.
7. 마지막 줄은 `{ text: '주문 #(1번) 완료', kind: 'done' }`이다.

다시 쓰는 때: 4번이 정해졌을 때, Zoro 답으로 4번이 바뀌었을 때, 1~4번 주문에 요청사항이 왔을 때.

`markWindowDone(orderId)`는 완료된 작업창의 `make` 단계에 들어 있던 주문을 모두 `made = true`로 바꾼다. 완료 버튼을 누르면 위 단계는 다 한 것으로 본다.

### 9단계. 요청사항

지금 `addEvent()`가 `interpretEvent()` 결과로 카드를 고치는 구조는 그대로 둔다.

- 대상 주문이 `board.slice(0, lockedCount)` 안에 있으면 `rebuildWorkWindow()`를 부른다.
- 5~8번 주문이면 카드만 바뀌고, 다음 완료 때 사실 문장에 반영된다.
- Zoro로 메모 읽기는 다음 단계다. `/ai/read-note`를 따로 만들고, 선택지는 이 가게 옵션 id(`recipe.json` `options`), 확신이 낮으면 `needs_confirmation = true`로 둔다.

### 10단계. 화면 — `app/dashboard.tsx`, `app/domain/views.ts`

- `BoardSnapshot`에 `slot4`와 `work_window`를 추가한다.
- 보드는 4칸 × 2줄. 윗줄 고정 1~4번, 아랫줄 대기 5~8번.
- 4번 카드에 "확인 중", "Zoro 0.78", "룰" 중 하나를 붙인다. Zoro가 룰과 다르게 골랐으면 "룰은 #110 · 이유" 한 줄을 쓴다. 이유는 두 후보의 사실 문장으로 코드가 만든다. Zoro는 이유를 말하지 않는다.
- 작업창 패널은 단계 목록과 마지막 줄의 완료 버튼이다. 버튼은 1번 주문에 지금 있는 완료 API를 부른다.
- 5~8번 카드에는 메모 칩, ✔ 만듦, ⚠ 확인 필요를 붙인다.

## aiserver

### 11단계. `POST /ai/pick-next`

`/ai/decide`는 그대로 두고 새 엔드포인트를 만든다.

- `app/schemas.py`: `PickRequest`, `PickResult` (7단계 형식과 같게)
- `app/pipeline.py`: 아래 함수
- `app/main.py`: 라우트 추가
- 요청마다 후보, 점수, 걸린 시간을 로그로 남긴다. 12단계 실험과 정답률 계산에 쓴다.

요청 예 (12:37:20, #103 완료 직후):

```json
{
  "now": "2026-11-19T03:37:20Z",
  "baristas": 1,
  "owner_rules": ["매장·포장 손님은 10분을 넘기지 않는다", "배달은 라이더 도착보다 2분까지 늦어도 괜찮다"],
  "locked": [
    { "id": "#104", "facts": "딸기 스무디 1 · 매장 · 재료 준비됨" },
    { "id": "#106", "facts": "아이스 아메리카노 2 · 배달 · 다 만듦 · 라이더 1분 10초 뒤" },
    { "id": "#107", "facts": "딸기 스무디 1 · 매장 · 재료 준비됨" }
  ],
  "candidates": [
    { "id": "#105", "facts": "아이스 아메리카노 1 · 포장 · 12:43 픽업 (6분 남음)" },
    { "id": "#108", "facts": "라떼 2 · 포장 · 7분 20초 기다림 · 4번이면 9분 30초에 나감, 밀리면 11분 넘음 (기준 10분 넘김) · 1잔 연하게" },
    { "id": "#109", "facts": "아이스 아메리카노 2 · 배달 · 라이더 8분 40초 뒤 · 여유 있음" },
    { "id": "#110", "facts": "라떼 1 · 배달 · 라이더 3분 40초 뒤 · 4번이 아니면 1분 30초 늦음 (기준 2분 안)" }
  ],
  "rule_pick": "#110",
  "examples": []
}
```

응답 예:

```json
{ "pick": "#108", "source": "zoro", "confidence": 0.78,
  "scores": { "#108": 0.78, "#110": 0.17, "#109": 0.03, "#105": 0.02 }, "fallback": false }
```

| 응답 필드 | 뜻 |
| --- | --- |
| `pick` | 4번에 넣을 주문. 항상 `candidates` 안의 id |
| `source` | `zoro`: Zoro 1등이 임계값 이상. `rule`: 확신이 낮거나 Zoro 실패라 `rule_pick`을 돌려줌 |
| `confidence` | Zoro 1등 확률. Zoro가 실패했으면 `1.0`(룰) |
| `scores` | 후보별 Zoro 확률. Zoro가 실패했으면 빈 객체 |
| `fallback` | Zoro 호출 자체가 실패했으면 `true` |

파이프라인:

```python
PICK_THRESHOLD = float(os.getenv("PICK_THRESHOLD", "0.7"))

def build_state(req: PickRequest) -> dict:
    return {
        "지금": f"{to_kst(req.now)} · 바리스타 {req.baristas}명",
        "사장님 기준": req.owner_rules,
        "지금 만드는 1~3번": [f"{o.id} {o.facts}" for o in req.locked],
        "예시": req.examples,
    }

def build_question(req: PickRequest) -> dict:
    return {
        "type": "choice",
        "instructions": "1~3번 다음에 만들 주문 하나를 고르세요. 사장님 기준을 먼저 따르고, "
                        "기준이 말하지 않는 부분은 먼저 온 손님을 먼저 합니다.",
        "criteria": {c.id: c.facts for c in req.candidates},   # 들어온 순서 그대로
    }

def pick_next(req: PickRequest) -> PickResult:
    try:
        ans = zoro.systemone(build_state(req), {"next": build_question(req)}, timeout=ZORO_TIMEOUT_S)
        scores = ans["answers"]["next"]["probabilities"]
    except Exception:
        return PickResult(pick=req.rule_pick, source="rule", confidence=1.0, scores={}, fallback=True)
    ids = [c.id for c in req.candidates]
    top = max(ids, key=lambda i: scores.get(i, 0.0))
    if scores.get(top, 0.0) >= PICK_THRESHOLD:
        return PickResult(pick=top, source="zoro", confidence=scores[top], scores=scores, fallback=False)
    return PickResult(pick=req.rule_pick, source="rule", confidence=scores.get(top, 0.0), scores=scores, fallback=False)
```

후보는 늘 들어온 순서로 적는다. 앞에 적힌 후보를 더 고르는 버릇이 있는지는 12단계에서 확인한다. 시간이 남으면 1등이 0.5~0.7일 때만 Zoro가 이유를 쓰고 다시 고르게 할 수 있다. Zoro가 권하는 방식이지만 느리다.

### 12단계. Zoro 실험 스크립트 — `scripts/pick_experiment.py` (가장 먼저)

1. 기준이 부딪히는 장면 3개와 부딪히지 않는 대조 장면 1개를 준비한다.
2. 네 조건으로 돌린다: 기준 없음, 목표 한 줄, 사장님 기준, 알바가 고친 예시 1개.
3. 후보 순서만 바꿔서 한 번 더 돌린다.
4. 장면 × 조건마다 점수표를 출력한다.

사장님 기준을 넣었을 때 점수가 기준 쪽으로 움직이지 않으면, 4번 고르기는 룰로만 하고 Zoro는 메모 읽기에 쓴다.

## 테스트

teamktb `tests/`:

- 당기기: 1번 완료 → 2~4번이 1~3번으로, 4번에 룰 선택이 먼저 들어감
- 1번이 아닌 고정 주문 완료 → 4번 다시 채우기
- 룰 ①②③의 우선순위
- Zoro 답 처리: 후보 밖 id → 룰, `source: rule` → 룰, 기다리는 사이 또 완료됨 → 응답 버림, 4번이 바뀐 뒤 온 응답 → 버림
- 밀린 횟수: pick보다 먼저 접수된 후보만 +1
- 작업창: 같은 메뉴 묶기, 디카페인 따로, 스무디 갈기와 재료 준비 구분, `made` 주문은 포장만, 마지막 줄 완료
- 요청사항: 1~4번 주문이면 작업창 다시 씀, 5~8번이면 카드만 바뀜

정답률 (aiserver):

- `data/scenarios.json`에 "사장님이라면 누구를 4번에?" 정답을 단 장면 30~50개를 넣는다.
- 룰과 Zoro의 정답률, 그리고 0.7 이상인데 틀린 수(자신 있게 틀림)를 센다.
- `/ai/pick-next` 응답 시간의 중간값과 느린 10%를 잰다.

## 작업 순서와 나누기

| 순서 | A (teamktb) | B (aiserver) |
| --- | --- | --- |
| 0 | 같이: [aiserver-api.md](aiserver-api.md)에 `/ai/pick-next` 형식 확정 | 같이 |
| 1 | 1·2단계: 보드 8칸, 재정렬 끄기 | 12단계: 실험 스크립트 |
| 2 | 3·6단계: 완료 처리와 룰 → 룰만으로 시연 가능 | 11단계: `/ai/pick-next` |
| 3 | 4·5·7단계: 사실, 사장님 기준, 호출 → Zoro 연결 | 정답률 스크립트, 로그 |
| 4 | 8·10단계: 작업창, 화면 | 장면 정답 달기, 사장님 기준 문장 다듬기 |
| 5 | 9단계: 요청사항 → 작업창 | 시간이 남으면 `/ai/read-note` |

## 정할 것

| 항목 | 권하는 값 |
| --- | --- |
| 1번이 아닌 주문을 먼저 완료할 때 (라이더가 먼저 와서 미리 만든 주문을 가져감) | 같은 처리. 고정칸이 비면 당기고 4번을 고른다 |
| 4번에 들어간 뒤 품절이나 요청 때문에 못 만들게 될 때 | 4번에서 빼고 다시 고른다 |
| 밀린 횟수 상한 | 3번 (aiserver `MAX_OVERTAKES`와 맞춤) |
| Zoro 점수를 화면에 보일지 | 데모에서는 보이고, 실제 매장 화면에서는 숨긴다 |
| 사장님 기준 문장을 화면에서 고칠 수 있게 할지 | 데모에서는 파일로 두고, 시간이 남으면 입력칸을 만든다 |
