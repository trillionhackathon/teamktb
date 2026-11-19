# aiserver API 명세

`teamktb`(Next.js 서버)와 `aiserver`(FastAPI) 사이의 HTTP 계약이다. 기준 코드는 aiserver `main`(4번 고르기는 `feat/pick-next`)의 `app/schemas.py`, `app/main.py`, `app/pipeline.py`와 teamktb의 [app/ai/contract.ts](../app/ai/contract.ts), [app/server/aiserver.ts](../app/server/aiserver.ts)다. 필드를 바꾸면 양쪽 코드, [tests/ai-contract.test.ts](../tests/ai-contract.test.ts), 이 문서를 함께 고친다.

## 구성

```text
브라우저 ──(SSE / REST)──▶ teamktb Next.js 서버 ──HTTP──▶ aiserver ──HTTP──▶ Zoro-1 서버
                           주문 저장·보드 상태     4번 고르기·팁·입력 분류   POST /v1/systemone
```

- 브라우저는 aiserver 주소를 모른다. aiserver 호출은 Next.js 서버의 주문 저장소(`app/server/order-store.ts`)만 한다.
- aiserver는 상태를 저장하지 않는다. 요청마다 현재 보드 전체를 받아 판단만 돌려준다.
- 주문 상태 변경(시작·완료·재제조)과 최종 보드 순서 확정은 teamktb가 한다. aiserver 응답은 검증을 통과할 때만 반영한다.
- 보드 순서는 1번(고정칸) 완료 때만 바뀐다. 그때 `POST /ai/pick-next`로 4번에 넣을 주문을 묻는다. 숫자는 teamktb가 계산해 사실 문장으로 보내고, Zoro는 사장님 기준을 보고 고르기만 한다. 설계는 [pick-next-implementation.md](pick-next-implementation.md).

## 공통

| 항목 | 값 |
| --- | --- |
| Base URL | teamktb `AISERVER_URL` (로컬 기본 `http://127.0.0.1:8000`) |
| 형식 | `Content-Type: application/json`, UTF-8 |
| 인증 | 없음. aiserver는 내부망·로컬에서만 연다. |
| 타임아웃 | teamktb `AISERVER_TIMEOUT_MS` (기본 1500ms). 넘으면 요청을 끊고 규칙 판단으로 대신한다. |
| 시각 | ISO 8601 UTC 문자열 (`2026-11-19T08:02:00Z`) |
| 검증 실패 | FastAPI 기본 `422` + `{"detail": [...]}` |

## GET /health

aiserver 생존 확인.

```json
{ "ok": true, "llm_enabled": false }
```

Zoro 연결 여부는 알려 주지 않는다. Zoro가 죽어도 aiserver는 `200`으로 규칙 폴백 응답을 준다(`fallback: true`).

## POST /ai/pick-next

1번 완료 때 대기 5~8번 중 4번 칸에 넣을 주문을 고른다. aiserver는 Zoro에 `choice` 질문 하나를 묻고, Zoro가 답하면 확률과 상관없이 1등 주문을 돌려준다(`PICK_THRESHOLD` 기본 0). Zoro가 답하지 못하면 teamktb가 보낸 `rule_pick`을 돌려준다. `PICK_THRESHOLD`를 0보다 크게 두면 1등 확률이 그보다 낮을 때도 `rule_pick`을 돌려준다.

**호출 시점:** 고정칸(1~4번) 주문이 완료될 때. teamktb는 2~4번을 당기고 룰 선택을 4번에 먼저 넣은 뒤("확인 중") 이 요청을 보낸다. 4번은 1~3번이 끝난 뒤에 만들기 시작하므로 Zoro 답이 1초쯤 걸려도 알바가 기다리지 않는다. 후보가 하나면 묻지 않는다.

### 요청 — `PickRequest`

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `now` | ISO 8601 UTC | 지금 시각. aiserver가 KST로 바꿔 Zoro 상태에 넣는다 |
| `baristas` | `int ≥ 1` | 바리스타 수 |
| `owner_rules` | `string[]` | 사장님 기준 문장. teamktb [data/owner_rules.json](../data/owner_rules.json) `sentences` |
| `locked` | `{ id, facts }[]` (최대 3) | 새 1~3번, 칸 순서 |
| `candidates` | `{ id, facts }[]` (1~4) | 4번 후보(기존 5~8번 중 대기 중이고 만들 수 있는 주문), 들어온 순서 |
| `rule_pick` | `string` | teamktb 룰 선택. `candidates` 안의 id여야 한다(아니면 `422`) |
| `examples` | `string[]` | 알바가 고친 예시. 지금은 빈 배열 |

`facts`는 teamktb [app/domain/facts.ts](../app/domain/facts.ts)가 계산한 한 줄이다. 시간은 "5분 10초"처럼 사람이 읽는 말로 넣고, Zoro에게 시각 두 개를 주고 빼기를 시키지 않는다. 종합 점수는 넣지 않는다.

기준 문장은 "4번에 안 넣으면 어떻게 되나"로 쓴다(예: "4번에 안 넣으면 11분 10초에 나가 기준 10분을 넘김"). "밀리면 11분 (기준 10분 넘김)"처럼 쓰면 Zoro가 "기준 넘김"을 그 주문의 나쁜 점으로 읽고 피했다(2026-11-19 실험).

```json
{
  "now": "2026-11-19T03:37:20Z",
  "baristas": 1,
  "owner_rules": ["매장·포장 손님은 10분을 넘기지 않는다", "배달은 라이더 도착보다 2분까지 늦어도 괜찮다"],
  "locked": [
    { "id": "#104", "facts": "딸기 스무디 1잔 · 매장 · 재료 준비됨" },
    { "id": "#106", "facts": "아이스 아메리카노 2잔 · 배달 · 다 만듦 · 라이더 1분 10초 뒤" },
    { "id": "#107", "facts": "딸기 스무디 1잔 · 매장 · 재료 준비됨" }
  ],
  "candidates": [
    { "id": "#105", "facts": "아이스 아메리카노 1잔 · 포장 · 2분 기다림" },
    { "id": "#108", "facts": "카페 라떼 2잔 · 포장 · 7분 20초 기다림 · 4번에 안 넣으면 11분 10초에 나가 기준 10분을 넘김 (4번이면 9분 30초)" },
    { "id": "#109", "facts": "아이스 아메리카노 2잔 · 배달 · 라이더 8분 40초 뒤 · 4번에 안 넣어도 라이더보다 먼저 나옴" },
    { "id": "#110", "facts": "카페 라떼 1잔 · 배달 · 라이더 3분 40초 뒤 · 4번에 안 넣으면 라이더보다 1분 30초 늦지만 기준 2분 안" }
  ],
  "rule_pick": "#110",
  "examples": []
}
```

### 응답 — `PickResult`

```json
{ "pick": "#108", "source": "zoro", "confidence": 0.78,
  "scores": { "#105": 0.02, "#108": 0.78, "#109": 0.03, "#110": 0.17 }, "fallback": false }
```

| 필드 | 뜻 |
| --- | --- |
| `pick` | 4번에 넣을 주문. 항상 `candidates` 안의 id |
| `source` | `zoro`: Zoro가 고름(기본 설정에서는 Zoro가 답하면 항상). `rule`: Zoro 실패(또는 `PICK_THRESHOLD`보다 낮은 확신)라 `rule_pick`을 돌려줌 |
| `confidence` | Zoro 1등 확률. Zoro가 실패했으면 `1.0`(룰) |
| `scores` | 후보별 Zoro 확률(후보 id만). Zoro가 실패했으면 빈 객체 |
| `fallback` | Zoro 호출 자체가 실패했으면 `true` |

aiserver는 요청마다 후보, 점수, 선택, 걸린 시간을 `pick-next {...}` 로그 한 줄로 남긴다.

### Zoro 질문

```json
{
  "state": { "지금": "12:37:20 · 바리스타 1명", "사장님 기준": ["..."], "지금 만드는 1~3번": ["#104 딸기 스무디 1잔 · 매장 · 재료 준비됨"], "예시": [] },
  "questions": { "next": { "type": "choice",
    "instructions": "1~3번 다음 4번 자리에 넣을 주문 하나를 고르세요. 4번에 넣지 않으면 사장님 기준을 넘기게 되는 주문이 있으면 그 주문을 넣어야 합니다. 그런 주문이 없으면 먼저 온 손님을 먼저 합니다.",
    "criteria": { "#105": "...", "#108": "...", "#109": "...", "#110": "..." } } }
}
```

### teamktb의 룰과 반영

- 룰(`app/domain/board.ts` `rulePickNext`): ① `max_overtaken`(3)번 이상 밀린 주문 → ② 4번이 아니면 `delivery_late_ok_sec`(120초)보다 더 늦는 배달 중 여유가 가장 적은 주문 → ③ 가장 오래 기다린 주문.
- 응답은 `parsePickResult`로 형식을 검사한다. `source: "zoro"`이고 `pick`이 후보 안에 있을 때만 4번을 바꾼다. 형식 오류, 타임아웃, `source: "rule"`, 후보 밖 id는 룰 선택을 그대로 둔다.
- 기다리는 사이 다른 고정칸이 또 완료됐거나 4번이 바뀌었으면 늦게 온 응답을 버린다.
- 4번이 정해지면 그 주문보다 먼저 접수된 후보의 `overtaken`을 1 올린다. 이 값은 `/ai/decide`의 `overtaken`으로도 보낸다.
- 화면 4번 카드에는 "확인 중", "Zoro 0.78", "룰" 중 하나를 붙이고, Zoro가 룰과 다르게 골랐으면 "룰은 #110 · (사실 문장)"을 쓴다.


## POST /ai/group-orders (위 4칸 묶기, 1번 기준)

위 4칸 구성이나 기준 주문이 바뀔 때마다 부른다. FIFO 보드에서는 `anchor`(기준 주문, 보통 1번)를 보내고, Zoro는 기준 주문 메뉴 × 나머지 메뉴 짝마다 noul 질문 하나("연달아 만들면 같은 장비·작업을 이어 쓰나?")에 답한다. 같은 메뉴 짝은 묻지 않고 1로 본다. 한 번 물은 짝은 aiserver가 기억한다. 타임아웃은 15초(`groupTimeoutMs`)다.

teamktb가 보내기 전에 빼는 것: 이미 만든 주문(`made`), 장비 고장으로 보류된 주문, `batch_blocking` 옵션(디카페인, 오트밀크)이 붙은 줄.

```json
{ "anchor": "#101", "orders": [
  { "id": "#101", "menus": [{ "id": "latte", "name": "카페 라떼", "equipment": ["espresso_machine", "steam_wand"], "steps": ["..."] }] },
  { "id": "#102", "menus": [{ "id": "iced_latte", "name": "아이스 카페 라떼", "equipment": ["espresso_machine", "ice_dispenser"], "steps": ["..."] }] }
] }
```

```json
{ "groups": { "#101": 1, "#102": 1 }, "scores": { "#102": 0.85, "#103": 0.12 }, "matched_menus": { "#102": ["iced_latte"] }, "fallback": false }
```

| 응답 필드 | 뜻 |
| --- | --- |
| `groups` | 기준 주문과 그 짝(점수 0.5 이상). 짝이 없으면 빈 객체 |
| `scores` | `anchor`가 있을 때만. 기준이 아닌 주문마다 Zoro가 본 비슷한 정도(0~1) |
| `matched_menus` | 함께 만들 주문별로 기준 주문 메뉴와 제조 호환성이 0.5 이상인 메뉴 ID. 복합 주문에서 다른 메뉴는 작업에 섞지 않는다 |
| `fallback` | Zoro가 답하지 못했으면 `true`. teamktb는 묶지 않고 "Zoro가 답하지 못했어요"로 표시한다 |

`anchor`를 빼면 예전처럼 모든 주문 짝을 평균 연결로 묶는다(`scores`는 비어 있음).

## POST /ai/decide

일머리 팁을 받는다. 응답에는 보드 재배치(`orders`, `moves`)와 예상 완료 시각도 있지만 teamktb는 **팁만 쓰고 보드 순서는 바꾸지 않는다**(보드 순서는 `/ai/pick-next`만 바꾼다).

**호출 시점:** 새 주문 접수, 시작·완료 버튼, 매장·배달·재고 이벤트, 시나리오 입력이 있을 때마다 호출한다. teamktb는 250ms 동안 들어온 변경을 묶어 한 번만 보내고(`decideDelayMs`), 응답이 오기 전에 상태가 바뀌면 늦게 온 응답을 버린다. 보드 8칸(1~4번 고정 + 5~8번 대기)만 보낸다.

### 요청 — `StoreState`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `orders` | `Order[]` | O | 현재 보드 1~10번 칸 순서 그대로. 11번째부터의 대기열은 보내지 않는다. |
| `store` | `Record<string,string>` | | 매장 상황. teamktb는 고장 난 장비만 보낸다. 예: `{"블렌더": "고장"}` |
| `external` | `Record<string,string>` | | 외부 신호. 예: `{"날씨": "비"}` |
| `inventory` | `Record<string,string>` | | 코드가 계산한 재고 문장. 예: `{"원두": "약 200샷", "딸기": "30인분"}` |
| `baristas` | `int ≥ 1` | | 근무 인원. 기본 2. ETA 계산에 쓴다. |

`Order`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | `string` | O | 주문번호. 예: `"#101"` |
| `items` | `string` | O | 사람이 읽는 메뉴 요약. 예: `"카페 라떼 2잔"` |
| `channel` | `"store" \| "delivery"` | | 기본 `store`. teamktb `dine-in`·`takeout` → `store` |
| `created_at` | datetime | O | 접수 시각. 재배치해도 바뀌지 않는다. |
| `prep_seconds` | `int ≥ 0` | | 남은 제조 시간(초). 제조 중이면 남은 시간만 보낸다. 기본 60 |
| `rider_status` | `"none" \| "assigned" \| "arrived"` | | 배달만 의미 있음. teamktb `not_dispatched` → `none`, `dispatched` → `assigned`, `arrived` → `arrived` |
| `overtaken` | `int ≥ 0` | | 4번 고르기에서 뒤 주문에게 밀린 횟수. teamktb가 주문별로 센다. |
| `remake` | `bool` | | 재제조 주문 여부. 현재 teamktb는 항상 `false`를 보낸다. |

```json
{
  "orders": [
    { "id": "#101", "items": "카페 라떼 1잔", "channel": "store", "created_at": "2026-11-19T08:02:00Z", "prep_seconds": 90, "rider_status": "none", "overtaken": 0, "remake": false },
    { "id": "#106", "items": "카페 라떼 1잔", "channel": "store", "created_at": "2026-11-19T08:04:30Z", "prep_seconds": 90, "rider_status": "none", "overtaken": 0, "remake": false },
    { "id": "#107", "items": "아이스 아메리카노 2잔", "channel": "store", "created_at": "2026-11-19T08:05:00Z", "prep_seconds": 60, "rider_status": "none", "overtaken": 0, "remake": false },
    { "id": "#108", "items": "딸기 스무디 2잔", "channel": "delivery", "created_at": "2026-11-19T08:05:30Z", "prep_seconds": 200, "rider_status": "arrived", "overtaken": 0, "remake": false }
  ],
  "store": {},
  "external": {},
  "inventory": { "원두": "약 200샷", "딸기": "30인분" },
  "baristas": 1
}
```

(예시는 줄였다. 실제로는 1~4번 고정칸 주문까지 보드 순서대로 8칸을 보낸다.)

### 응답 — `DecideResult`

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `orders` | `string[]` | 새 보드 순서(최대 10개). 앞 `locked_count`개는 요청 순서와 같아야 한다. |
| `locked_count` | `int` | 고정칸 수. 현재 5 |
| `moves` | `Move[]` | 앞으로 당겨진 주문만. 뒤로 밀린 주문은 넣지 않는다. |
| `eta` | `Record<id, datetime>` | 주문별 예상 완료 시각. 앞 주문 제조 시간 누적 ÷ 인원 |
| `tips` | `Tip[]` | 일머리 팁. 최대 2개 |
| `fallback` | `bool` | Zoro 호출 자체가 실패했으면 `true`. Zoro가 답했지만 확신이 낮아 규칙을 쓴 경우는 `false` |

`Move`

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `order_id` | `string` | 이동한 주문 |
| `from`, `to` | `int` | 1부터 시작하는 칸 번호. `to < from` |
| `reason` | `string` | `ai_hint`(Zoro가 고름) · `rider_waiting`(라이더 도착) · `short_job`(규칙 정렬) · `remake`(재제조) |
| `confidence` | `float` | Zoro 판단이면 선택 확률, 규칙이면 `1.0` |
| `source` | `"zoro" \| "llm" \| "rule"` | 판단 출처 |

`Tip` — `{ id, text, confidence, source }`. `id`는 aiserver `app/catalog.py`의 고정 목록 중 하나다.

| id | text |
| --- | --- |
| `beans` | 원두 재고 확인 필수 |
| `ice` | 얼음 보충 |
| `cups` | 컵·홀더 보충 |
| `floor` | 바닥 청소·미끄럼 주의 |
| `returns` | 반납대 정리·설거지 |
| `delivery_hold` | 배달 손님께 지연 안내 |
| `fruit` | 과일 재고 확인 |

실제 응답 예시(Zoro 연결, 8건, 0.69초):

```json
{
  "orders": ["#101", "#102", "#103", "#104", "#105", "#107", "#108", "#106"],
  "locked_count": 5,
  "moves": [
    { "order_id": "#107", "from": 7, "to": 6, "reason": "ai_hint", "confidence": 0.7834, "source": "zoro" },
    { "order_id": "#108", "from": 8, "to": 7, "reason": "rider_waiting", "confidence": 1.0, "source": "rule" }
  ],
  "eta": { "#101": "2026-11-19T08:23:23.411348Z", "#106": "2026-11-19T08:35:23.411348Z" },
  "tips": [
    { "id": "fruit", "text": "과일 재고 확인", "confidence": 0.776, "source": "zoro" },
    { "id": "delivery_hold", "text": "배달 손님께 지연 안내", "confidence": 0.761, "source": "zoro" }
  ],
  "fallback": false
}
```

### aiserver의 판단 규칙

| 기능 | 1차 | 실패하거나 확률 < 임계값이면 | 그것도 실패하면 |
| --- | --- | --- | --- |
| 재배치 | Zoro `choice`로 6~10번 중 맨 앞 주문 1개 지정 (`REORDER_THRESHOLD` 0.7) | 규칙: 재제조 → 고정칸 → 추월 3회 이상 주문 → 라이더 도착 우선·제조 시간 짧은 순 | — |
| 팁 | Zoro `noul`로 팁별 필요 확률 (`TIP_THRESHOLD` 0.7) | LLM 폴백(`LLM_ENABLED=true`일 때) | 팁 없음 |
| 입력 분류 | Zoro `choice` (`INTENT_THRESHOLD` 0.7) | LLM 폴백 | `needs_review` |

### teamktb의 응답 반영

`tips`(와 `feed`)만 팁으로 보여 준다. `orders`, `moves`, `eta`는 쓰지 않는다.

응답 형식이 계약과 다르면(`parseDecideResult` 실패) 연결 실패와 같게 처리한다. 화면 표시는 다음과 같다.

| 상황 | `decision.ai_status` | `decision.source` | 대시보드 문구 |
| --- | --- | --- | --- |
| `AISERVER_URL` 없음 | `disabled` | `rule` | AI 서버 미설정 |
| 타임아웃·네트워크 오류·HTTP 오류·형식 오류 | `unavailable` | `rule` | AI 서버 미응답 |
| 응답 반영, `tips` 중 `source: "zoro"`가 있음 | `connected` | `zoro` | AI 서버 연결됨 |
| 응답 반영, Zoro 출처 판단 없음 또는 `fallback: true` | `connected` | `rule` | AI 서버 연결됨 |

## POST /ai/operator-input

작업자가 입력한 상황 문장의 종류를 분류한다. teamktb는 `/api/events`로 들어온 입력을 먼저 자체 규칙으로 반영하고, 이 분류 결과는 이벤트에 `intent`로 덧붙여 화면에 보여 준다. 분류 결과로 보드 순서를 바꾸지는 않는다.

요청

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `text` | `string` (1~500자) | O | 작업자 입력 원문 |

```json
{ "text": "라떼 하나 쏟았어요" }
```

응답 — `IntentResult`

```json
{ "intent": "store_event", "confidence": 0.989, "source": "zoro" }
```

| intent | 뜻 |
| --- | --- |
| `store_event` | 매장 사고·상황 보고 (쏟음, 기기 고장 등) |
| `delivery_event` | 배달·날씨 상황 보고 |
| `inventory_question` | 재고 질문 |
| `order_command` | 특정 주문 순서 변경 지시 |
| `needs_review` | 분류하지 못함. `source: "rule"`, `confidence: 0` |

빈 문자열이나 500자 초과는 `422`다. teamktb 입력창은 300자로 제한한다.

## POST /ai/quest (teamktb에서 쓰지 않음)

화면에서 4+4칸을 나누던 퀘스트 보드용 API였다. teamktb는 4번 고르기를 서버 저장소와 `/ai/pick-next`로 옮기면서 `POST /api/quest`와 `app/client/quest-board.ts`를 지웠다. aiserver의 `/ai/quest`(`app/quest.py`)는 남아 있다.

## 참고: aiserver → Zoro-1

aiserver 내부 호출이라 teamktb가 직접 부르지 않는다. 연결 설정은 aiserver 환경 변수다.

| 변수 | 설명 |
| --- | --- |
| `ZORO_BASE_URL` | Zoro 서버 주소. 기본 `http://127.0.0.1:8080` |
| `ZORO_MODEL` | 요청 `model` 값. 서버의 `/v1/models` id와 맞춘다(GPU 서버 `serve_tf.py`는 `Zoro-1`, MLX 서버는 `--served-model-name`). |
| `ZORO_TIMEOUT_S` | Zoro 응답 대기(초). 기본 3 |

`POST /v1/systemone`

```json
{
  "model": "Zoro-1",
  "state": { "store": {}, "external": {}, "inventory": {}, "queue_size": 8, "flexible_orders": [{ "id": "#106", "items": "카페 라떼 1잔", "channel": "store", "waited_min": 3, "rider": "none" }] },
  "questions": {
    "first": { "type": "choice", "instructions": "재배열칸 주문 중 가장 먼저 만들어야 할 주문은? ...", "criteria": { "#106": "카페 라떼 1잔, store, 대기 3분, 기사 none" } },
    "need_beans": { "type": "noul", "instructions": "지금 '원두 재고 확인 필수'이(가) 필요한가?" }
  }
}
```

응답은 `{"answers": {"first": {"type": "choice", "choice": "#106", "probabilities": {...}}, "need_beans": {"type": "noul", "noul": 0.12}}}` 형태다. 질문 키가 하나라도 빠지면 aiserver는 Zoro 실패로 본다.

시연 환경의 Zoro는 GPU 인스턴스에서 `serve_tf.py --port 30001`로 띄우고, 로컬에서 SSH 터널(`-L 8080:127.0.0.1:30001`)로 aiserver 기본 주소에 연결한다. 이 경로에서 측정한 `/ai/decide` 응답은 0.3~0.8초였다.

## 미결 항목

| 항목 | 현재 상태 | 정해야 할 것 |
| --- | --- | --- |
| `remake` | teamktb는 재제조를 새 주문으로 만들어 직접 1번 칸에 넣고 `false`를 보낸다. aiserver는 `remake: true` 주문을 맨 앞으로 옮기는데, 그러면 고정칸이 바뀌어 teamktb 검증에서 응답이 버려진다. | 재제조 배치를 teamktb만 맡는다고 확정하고 aiserver에서 `remake` 처리를 뺄지 |
| `feed` | teamktb는 `feed[]`(aiserver main README 초안)도 받아 팁으로 보여 주지만 aiserver `feat/ai-skeleton`은 보내지 않는다. | `tips`와 `feed` 중 하나로 정리 |
| `Move.confidence` | aiserver는 항상 보내고 teamktb는 선택으로 받는다. | 필수로 맞출지 |
| `eta` | 응답에 있지만 teamktb 화면은 자체 계산(앞 주문 남은 시간 누적, 1인 기준)을 쓴다. | 손님 화면 ETA를 aiserver 값으로 바꿀지, 인원 수 반영 여부 |
| 타임아웃 | teamktb 기본 1500ms, aiserver의 Zoro 대기 3초(`/ai/pick-next`도 같음). Zoro가 느리면 aiserver가 답하기 전에 teamktb가 끊는다. | GPU 서버 기준 값으로 둘을 맞출지 (시연 로컬 설정은 teamktb 3000ms, Zoro 5초) |
