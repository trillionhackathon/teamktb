# aiserver API 명세

`teamktb`(Next.js 서버)와 `aiserver`(FastAPI) 사이의 HTTP 계약이다. 기준 코드는 aiserver `feat/ai-skeleton` 브랜치의 `app/schemas.py`, `app/main.py`, `app/pipeline.py`와 teamktb의 [app/ai/contract.ts](../app/ai/contract.ts), [app/server/aiserver.ts](../app/server/aiserver.ts)다. 필드를 바꾸면 양쪽 코드, [tests/ai-contract.test.ts](../tests/ai-contract.test.ts), 이 문서를 함께 고친다.

## 구성

```text
브라우저 ──(SSE / REST)──▶ teamktb Next.js 서버 ──HTTP──▶ aiserver ──HTTP──▶ Zoro-1 서버
                           주문 저장·보드 상태        재배치·팁·입력 분류      POST /v1/systemone
```

- 브라우저는 aiserver 주소를 모른다. aiserver 호출은 Next.js 서버의 주문 저장소(`app/server/order-store.ts`)와 퀘스트 보드 중계 API(`app/api/quest/route.ts`)만 한다.
- aiserver는 상태를 저장하지 않는다. 요청마다 현재 보드 전체를 받아 판단만 돌려준다.
- 주문 상태 변경(시작·완료·재제조)과 최종 보드 순서 확정은 teamktb가 한다. aiserver 응답은 검증을 통과할 때만 반영한다.

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

## POST /ai/decide

보드 재배치, 예상 완료 시각, 일머리 팁을 한 번에 받는다.

**호출 시점:** 새 주문 접수, 시작·완료 버튼, 매장·배달·재고 이벤트, 시나리오 입력이 있을 때마다 호출한다. teamktb는 250ms 동안 들어온 변경을 묶어 한 번만 보내고(`decideDelayMs`), 응답이 오기 전에 상태가 바뀌면 늦게 온 응답을 버린다.

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
| `overtaken` | `int ≥ 0` | | 다른 주문에 추월당한 횟수. 현재 teamktb는 항상 `0`을 보낸다(아래 미결 항목 참고). |
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

(예시는 줄였다. 실제로는 1~5번 고정칸 주문까지 보드 순서대로 모두 보낸다.)

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

### teamktb의 응답 검증과 반영

`app/domain/board.ts` `applyAiOrder`가 아래를 모두 통과할 때만 순서를 반영한다. 하나라도 어기면 응답을 버리고 규칙 정렬을 쓴다.

1. `orders`가 요청한 1~10번 주문과 같은 집합이고 중복이 없다.
2. 앞 `locked_count`개가 요청 순서와 같다(고정칸 불변).
3. 6~10번 중 제조 중이거나 장비 고장으로 막힌 주문은 제자리를 지킨다. 재배치는 대기 중이고 만들 수 있는 주문끼리만 한다.

응답 형식이 계약과 다르면(`parseDecideResult` 실패) 연결 실패와 같게 처리한다. 화면 표시는 다음과 같다.

| 상황 | `decision.ai_status` | `decision.source` | 대시보드 문구 |
| --- | --- | --- | --- |
| `AISERVER_URL` 없음 | `disabled` | `rule` | 규칙 판단 · AI 서버 미설정 |
| 타임아웃·네트워크 오류·HTTP 오류·형식 오류 | `unavailable` | `rule` | 규칙 판단 · AI 서버 미응답 |
| 응답 반영, `moves`·`tips` 중 `source: "zoro"`가 있음 | `connected` | `zoro` | AI 서버 · Zoro 판단 |
| 응답 반영, Zoro 출처 판단 없음 또는 `fallback: true` | `connected` | `rule` | AI 서버 · 규칙 판단 |

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

## POST /ai/quest

일머리 퀘스트 보드(대시보드 4+4칸) 판단. 대시보드의 고정칸, 후보, 미리 만든 잔 수가 바뀔 때마다 브라우저가 teamktb `POST /api/quest`를 부르고, Next.js 서버가 이 요청을 만들어 보낸다. aiserver 쪽 구현은 `feat/quest-api` 브랜치의 `app/quest.py`다.

### 요청 — `QuestState`

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `fixed` | `QuestOrder[]` (최대 4) | 1~4번 칸, 칸 순서대로. `fixed[0]`이 지금 퀘스트 대상 |
| `candidates` | `QuestOrder[]` (최대 4) | 5~8번 후보, 서버 보드 순서 |
| `store` | `{ [이름]: 상태 }` | 고장 난 장비 (예: `{"블렌더": "고장"}`) |
| `inventory` | `{ [이름]: 값 }` | 원두, 딸기 남은 양 |

`QuestOrder`

| 필드 | 형식 | 설명 |
| --- | --- | --- |
| `id` | string | 주문 번호 |
| `items` | `{ key, label, qty }[]` | 아직 만들어야 하는 메뉴. 앞 주문 때 미리 만든 잔 수는 뺀 값. `key`가 같으면 같이 만들 수 있다 |
| `channel` | `"store" \| "delivery"` | |
| `created_at` | ISO 8601 | 접수 시각 |
| `prep_seconds` | int | 남은 작업 시간 |
| `rider_status` | `"none" \| "assigned" \| "arrived"` | |
| `overtaken` | int | 후보로 있는 동안 뒤 주문에게 앞질린 횟수 |
| `prepared_qty` | int | 앞 주문을 만들 때 같이 만들어 둔 잔 수 |

### 응답 — `QuestResult`

```json
{
  "candidates": [
    {"order_id": "#7", "reason_code": "rider_waiting", "reason": "라이더가 도착해서 먼저 올려요", "confidence": 1.0, "source": "rule"},
    {"order_id": "#6", "reason_code": "batch", "reason": "1, 4번 주문과 아이스 아메리카노를 같이 만들 수 있어요", "confidence": 1.0, "source": "rule"}
  ],
  "plan": {
    "head": "#1",
    "source": "rule",
    "lines": [
      {"kind": "make", "key": "아이스 아메리카노", "label": "아이스 아메리카노", "qty": 7, "parts": [{"order_id": "#1", "qty": 3}, {"order_id": "#4", "qty": 4}]},
      {"kind": "make", "key": "바닐라 라떼", "label": "아이스 바닐라 라떼", "qty": 1, "parts": [{"order_id": "#1", "qty": 1}]},
      {"kind": "complete", "order_id": "#1", "prepared_qty": 0}
    ]
  },
  "fallback": false
}
```

- `candidates`: 후보 순위. 첫 주문이 다음에 고정칸으로 올라간다. `reason_code`는 `overdue`, `rider_waiting`, `batch`, `short_job`, `fifo` 중 하나다.
- `plan`: `fixed[0]`의 퀘스트. 다른 고정칸과 겹치는 메뉴를 묶어 만들기, `fixed[0]`에만 있는 메뉴 만들기, 완료 누르기 순서다. `fixed`가 비면 `null`이다.
- `fallback: true`면 Zoro가 응답하지 않아 규칙으로만 판단했다는 뜻이다.

### aiserver의 판단 규칙 (기준이 정해지기 전 임시)

- 후보 순위는 오래 밀린 주문(`QUEST_MAX_OVERTAKES`, 기본 2번), 라이더 도착, 고정칸과 겹치는 잔 수, 짧은 작업(`QUEST_SHORT_JOB_S`, 기본 90초), 접수순 순서로 매긴다.
- Zoro에는 "고정칸이 비면 어떤 후보를 올릴까"를 `choice`로 묻는다. 확률이 `REORDER_THRESHOLD`(0.7) 이상이면 그 주문을 1순위로 올린다(`source: "zoro"`). 오래 밀린 주문은 Zoro 선택보다 앞선다.
- 퀘스트 줄은 코드 규칙으로 만든다(`source: "rule"`).
- 음료별 기준과 매장 상황별 판단은 아직 정하지 않았다. 정해지면 `app/quest.py`의 점수와 Zoro 질문을 바꾼다.

### teamktb의 응답 검증과 반영

- `app/ai/contract.ts` `parseQuestResult`가 형식을 검사한다. 형식이 다르면 쓰지 않는다.
- 응답은 요청했을 때와 고정칸, 후보, 미리 만든 잔 수가 같을 때만 쓴다. 후보 이유 문장은 고정칸까지 같을 때만 쓴다(칸 번호가 들어 있다).
- aiserver가 없거나(`AISERVER_URL` 미설정) 응답하지 않으면 같은 규칙을 화면에서 돌린다(`app/client/quest-board.ts`). 화면에는 판단 출처를 "Zoro 판단", "규칙 판단", "화면 규칙"으로 표시한다.
- teamktb `POST /api/quest`의 응답은 `{ status: "connected", result }` 또는 `{ status: "disabled" | "unavailable", error }`다.

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
| `overtaken` | teamktb가 항상 `0`을 보내서 aiserver의 추월 상한(`MAX_OVERTAKES` 3)이 동작하지 않는다. | teamktb가 주문별 추월 횟수를 저장해 보낼지, aiserver가 직전 요청과 비교해 셀지 |
| `remake` | teamktb는 재제조를 새 주문으로 만들어 직접 1번 칸에 넣고 `false`를 보낸다. aiserver는 `remake: true` 주문을 맨 앞으로 옮기는데, 그러면 고정칸이 바뀌어 teamktb 검증에서 응답이 버려진다. | 재제조 배치를 teamktb만 맡는다고 확정하고 aiserver에서 `remake` 처리를 뺄지 |
| `feed` | teamktb는 `feed[]`(aiserver main README 초안)도 받아 팁으로 보여 주지만 aiserver `feat/ai-skeleton`은 보내지 않는다. | `tips`와 `feed` 중 하나로 정리 |
| `Move.confidence` | aiserver는 항상 보내고 teamktb는 선택으로 받는다. | 필수로 맞출지 |
| `eta` | 응답에 있지만 teamktb 화면은 자체 계산(앞 주문 남은 시간 누적, 1인 기준)을 쓴다. | 손님 화면 ETA를 aiserver 값으로 바꿀지, 인원 수 반영 여부 |
| 타임아웃 | teamktb 기본 1500ms, aiserver의 Zoro 대기 3초. Zoro가 느리면 aiserver가 답하기 전에 teamktb가 끊는다. | GPU 서버 기준 값으로 둘을 맞출지 (시연 로컬 설정은 teamktb 3000ms, Zoro 5초) |
