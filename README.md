# 일머리

- [카페 관제탑 서비스 소개](./service.md)
- [사용자 시나리오](./scenarios.md) · [메뉴·AI 계약 데이터](./data/cafe_db.json)

카페 주문과 다음 제조 작업을 보여주는 주방 운영 보드입니다.

## 로컬 실행

```sh
npm ci
npm run dev
```

서버 하나에 화면 세 개가 붙습니다. 같은 주소(예: `localhost:3000`)라면 다른 브라우저나 기기에서 열어도 같은 주문을 봅니다.

| 화면 | 역할 |
| --- | --- |
| [주방 운영 보드](http://localhost:3000) | 왼쪽 일머리 마법사(재고·매장 알림), 오른쪽 위 4+4 주문 보드(1~4번 고정, 5~8번 들어온 순서로 대기), 오른쪽 아래 작업창(1~4번을 같이 보고 1번 완료까지 할 일, 마지막 줄이 완료 버튼). 4번 카드에는 누가 골랐는지(확인 중 · Zoro 0.78 · 룰)를 붙입니다. 상단 버튼으로 시연용 자동 주문을 켜고 끕니다 |
| [키오스크](http://localhost:3000/kiosk) | 매장·포장 주문과 목업 결제. 결제가 끝나면 서버가 매긴 주문 번호와 예상 대기시간을 보여줍니다 |
| [배달 목업](http://localhost:3000/delivery) | 배달앱 주문과 라이더 메시지(거의 다 왔어요, N분 뒤 도착, 도착) |

## 데이터 흐름

```text
키오스크 / 배달 목업 ──POST /api/orders──▶ 주문 저장소(Next.js 서버) ──SSE /api/orders/stream──▶ 주방 운영 보드
주방 운영 보드 ──PATCH /api/orders/:번호, POST /api/events──▶ 주문 저장소 ──POST /ai/pick-next (1번 완료 때), /ai/decide (팁)──▶ aiserver
```

- 재고는 SQLite(`INVENTORY_DB`, 기본 `.data/inventory.sqlite`)에 있습니다. 처음 실행할 때 [data/inventory.json](./data/inventory.json)으로 채우고, 주문이 완료되면 레시피 사용량만큼 빼며 주문 출처(kiosk, delivery_app, demo)를 남깁니다. 주문 접수 때 원두와 딸기 검사는 SQLite 재고에서 보드에 남은 주문이 쓸 양을 뺀 값으로 합니다. `INVENTORY_COUNT_DEMO=0`이면 시연용 자동 주문은 재고에서 빼지 않습니다.
- 보드 순서는 서버 주문 저장소가 정합니다. 1번(고정칸) 완료 때만 2~4번을 당기고 대기 5~8번 중 하나를 골라 4번에 넣습니다. 새 주문은 맨 뒤에 붙고, 요청사항·매장 이벤트는 카드 내용만 바꿉니다. 설계는 [docs/pick-next-implementation.md](./docs/pick-next-implementation.md)입니다.
- 4번 고르기: 코드가 후보마다 사실 문장을 계산하고([app/domain/facts.ts](./app/domain/facts.ts)), 룰 선택을 먼저 넣은 뒤 Zoro가 [data/owner_rules.json](./data/owner_rules.json)의 사장님 기준을 보고 고릅니다. Zoro 확신이 0.7보다 낮거나 응답이 없으면 룰 선택(3번 밀린 주문 → 밀리면 기준 넘게 늦는 배달 → 가장 오래 기다린 주문)이 남습니다.
- 작업창([app/domain/work-window.ts](./app/domain/work-window.ts))은 같은 메뉴를 묶고, 디카페인·오트밀크처럼 묶을 수 없는 옵션은 따로, 스무디는 1~2번이면 갈기·3~4번이면 재료만 준비로 씁니다. 완료를 누르면 작업창에서 같이 만든 주문은 '만듦'이 되어 다음에는 포장만 남습니다.
- 메뉴·가격·옵션은 [data/recipe.json](./data/recipe.json), 제조 시간·보드 규칙·신뢰도 기준은 [data/cafe_db.json](./data/cafe_db.json), 시나리오는 [data/scenarios.json](./data/scenarios.json)과 [scenarios.md](./scenarios.md)를 읽습니다. 화면 쪽 하드코딩 메뉴는 없습니다.
- 주문 형식은 `cafe_db.json`의 `signals_schema.order`를 따릅니다(`order_id: "#101"`, `menu_items: [{menu, qty, size, options}]`, `channel: dine-in | takeout | delivery`).
- 제조 시간은 `remaining_work_formula`(첫 잔 + (수량-1)×추가 잔 + 옵션 `prep_delta_sec`)로 계산합니다. MVP 3종 외 음료는 같은 `complexity_tier` MVP 메뉴 값을 추정치로 씁니다(키오스크에 `(추정)` 표시).
- 주문은 Next.js 서버 메모리에 저장합니다. 서버를 다시 띄우면 공통 보드(#101~#110)로 돌아갑니다. 서버리스처럼 인스턴스가 여러 개인 환경에서는 주문이 공유되지 않습니다.

## 시나리오

매장 상황 패널에서 시나리오를 불러온 뒤 입력 버튼으로 한 단계씩 재생합니다.

| ID | 출처 | 재생 내용 |
| --- | --- | --- |
| SC-A | scenarios.json | `#108` 기사 메시지 "거의 다 왔어요" → 픽업 시간 확인 필요, "5분 뒤 도착" → 300초 확정 |
| SC-B | scenarios.json | `#108` 라이더 도착 → 보드는 그대로, 다음 1번 완료 때 4번으로(룰 ②) |
| SC-C | scenarios.json | 원두 12샷 + 대량 주문 → 팁은 AI 판단(work_tip) 결과만 표시 |
| SC-D | scenarios.json | 딸기 8인분 → 재고만큼만 스무디 주문 가능 |
| SC-01 | scenarios.md | `#111` 아이스 아메리카노 3잔 접수 → 대기열, 예상 대기시간 |
| SC-02 | scenarios.md | 쏟음 → 청소 팁(위치가 없으면 확인 필요) |
| SC-05 | scenarios.md | 블렌더 고장 → 스무디 포함 주문은 보드에 남고 4번 후보·신규 주문에서 제외, 작업창에는 보류로 표시 |

같은 입력을 두 번 눌러도 한 번만 처리합니다(INV-03). 상황 입력창에 `108번 라이더 도착했어요`, `블렌더 고장`처럼 직접 입력해도 같은 규칙으로 처리합니다.

## AI 서버 연결

```sh
cp .env.example .env.local   # AISERVER_URL을 aiserver 주소로 바꾼다
npm run dev
```

- 고정칸 주문이 완료되면 aiserver `POST /ai/pick-next`로 4번 후보의 사실 문장과 사장님 기준을 보냅니다. 응답이 `AISERVER_TIMEOUT_MS`(기본 1500ms) 안에 오고 Zoro 선택이면 4번을 바꿉니다. 기다리는 사이 또 완료됐으면 늦게 온 응답은 버립니다.
- 상태가 바뀔 때마다 보드 8칸을 `POST /ai/decide`로 보내 팁만 받습니다. 응답의 보드 순서는 반영하지 않습니다. 판단 중 상태가 바뀌면 늦게 온 응답은 버립니다(INV-04).
- 상황 입력은 `POST /ai/operator-input` 분류 결과를 이벤트에 함께 기록합니다.
- `AISERVER_URL`이 없거나 응답하지 않으면 4번은 룰 선택으로 확정하고 `AI 서버 미설정`·`AI 서버 미응답`으로 표시합니다(INV-07).
- 요청·응답 형식은 [app/ai/contract.ts](./app/ai/contract.ts)에 aiserver `app/schemas.py`와 맞춰 두었고, aiserver README 초안의 `feed` 형식도 받습니다. 필드 설명·예시·폴백 규칙·미결 항목은 [docs/aiserver-api.md](./docs/aiserver-api.md)에 정리했습니다.

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/orders` | 보드 스냅샷 |
| GET | `/api/orders/stream` | 스냅샷 SSE(`event: snapshot`) |
| POST | `/api/orders` | 주문 접수 `{ request_id?, channel, source, menu_items, request_note? }` — 같은 `request_id`는 같은 주문 반환 |
| PATCH | `/api/orders/:번호` | `{ action: 'start' \| 'complete' }` |
| POST | `/api/events` | 매장 상황·라이더 메시지 `{ event_id, raw_text, order_id? }` |
| DELETE | `/api/tips/:id` | 팁 해제 |
| GET, POST | `/api/scenarios` | 시나리오 목록, `{ scenario_id }` 불러오기, `{ scenario_id, trigger }` 재생 |
| GET | `/api/menu` | 메뉴 카탈로그와 주문 가능 여부 |
| POST | `/api/agent` | 일머리 마법사 메시지와 재고 소모량 목록. `{ order: 주문번호[] }`(화면에 보이는 순서)로 어느 주문에서 재고가 모자라는지 계산 |
| POST | `/api/inventory/restock` | `{ item_id }` 재고를 주문 단위만큼 채움. 마법사 대화의 "채웠어요" 버튼 |
| GET, POST | `/api/demo-feed` | 시연용 자동 주문 상태, `{ running: true \| false }`로 켜고 끄기. 5~12초마다 예시 주문을 넣고 보드에 16건이 쌓이면 잠시 멈춤. `DEMO_FEED=1`이면 서버 시작부터 켜짐 |

## 검증

```sh
npm run check
npm test
npm run build
```

`npm test`는 메뉴 계산, 보드 규칙, 이벤트 해석, 시나리오, 주문 저장소, aiserver 계약을 확인합니다. `AISERVER_URL`을 지정하면 실행 중인 aiserver로 SC-B(라이더 도착 → 1번 완료 → 4번 고르기)와 `/ai/pick-next`를 함께 확인합니다. aiserver는 Zoro 없이도 규칙 폴백으로 응답합니다.

```sh
AISERVER_URL=http://127.0.0.1:8000 npm test
```

GitHub Actions(`.github/workflows/ci.yml`)는 PR과 `main` 푸시마다 위 명령을 실행합니다. `AISERVER_REPO_TOKEN` 시크릿(aiserver 저장소 읽기 권한)이 있으면 aiserver를 체크아웃해 계약 테스트도 실행하며, 브랜치는 저장소 변수 `AISERVER_REF`(기본 `feat/ai-skeleton`)로 정합니다.
