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
| [주방 운영 보드](http://localhost:3000) | 왼쪽 일머리 마법사(재고·매장 알림), 오른쪽 위 주문 보드(1~7번 들어온 순서, 8번 빠른 주문 칸), 오른쪽 아래 일머리 팁(1번과 같이 만들 주문과 그 이유, 손 비는 시간에 먼저 낼 디저트). 상단에서 시연 장면을 불러오고 시연용 자동 주문을 켜고 끕니다 |
| [키오스크](http://localhost:3000/kiosk) | 매장·포장 주문과 목업 결제. 결제가 끝나면 서버가 매긴 주문 번호와 예상 대기시간을 보여줍니다 |
| [배달 목업](http://localhost:3000/delivery) | 배달앱 주문과 라이더 메시지(거의 다 왔어요, N분 뒤 도착, 도착) |

## 데이터 흐름

```text
키오스크 / 배달 목업 ──POST /api/orders──▶ 주문 저장소(Next.js 서버) ──SSE /api/orders/stream──▶ 주방 운영 보드
주방 운영 보드 ──PATCH /api/orders/:번호, POST /api/events──▶ 주문 저장소 ──POST /ai/pick-next (1번 완료 때), /ai/decide (팁)──▶ aiserver
```

- 재고는 SQLite(`INVENTORY_DB`, 기본 `.data/inventory.sqlite`)에 있습니다. 처음 실행할 때 [data/inventory.json](./data/inventory.json)으로 채우고, 주문이 완료되면 레시피 사용량만큼 빼며 주문 출처(kiosk, delivery_app, demo)를 남깁니다. 주문 접수 때 원두와 딸기 검사는 SQLite 재고에서 보드에 남은 주문이 쓸 양을 뺀 값으로 합니다. `INVENTORY_COUNT_DEMO=0`이면 시연용 자동 주문은 재고에서 빼지 않습니다.
- 보드 순서는 서버 주문 저장소가 정하고, 들어온 순서(FIFO, `cafe_db.json` `kds_board.fifo`)를 바꾸지 않습니다. 새 주문은 맨 뒤에 붙고, 요청사항·매장 이벤트는 카드 내용만 바꿉니다.
- 1번 기준 같이 만들기(Zoro): 위 4칸이 바뀔 때마다 `/ai/group-orders`에 1번(`anchor`)과 2~4번의 레시피를 보냅니다. Zoro가 비슷하다고 본 주문은 같은 색으로 표시하고, 함께 만들 수 있다고 본 메뉴만 아래 `지금 만들 작업`에 넣습니다. 디카페인·오트밀크와 고장 장비는 코드가 먼저 제외합니다. 아래 작업의 `제조 완료`는 관련 주문서의 해당 메뉴 줄만 가로선으로 표시합니다. 위 주문서 `완료`는 주문 전체를 보드에서 내보냅니다. `SC-W` 시연 장면에서 두 동작을 확인할 수 있습니다.
- 일머리 팁의 문장은 코드가 쉬운 말로 씁니다. 같이 만드는 이유는 레시피에서 같은 메뉴인지, 같이 쓰는 장비(에스프레소 샷, 우유 스팀, 블렌더 등)가 무엇인지로 정하고, Zoro 점수는 작은 글씨로 붙입니다.
- 8번 빠른 주문 칸(`kds_board.quick_lane`, 코드 규칙): FIFO는 1~7번만 쓰고, 8번에는 1~4번 밖(화면 밖 대기열 포함)에서 가장 먼저 들어온 매장·포장 디저트 전용 주문(아이스크림, 티라미수)을 띄웁니다. 기준 주문 레시피에 손이 비는 단계(`step_seconds`의 `attended: false`, 예: 샷 추출 30초)가 있고 그 시간이 디저트 손 시간보다 길면 "지금 내주세요"가 됩니다. 배달은 라이더가 올 때까지 녹아서 뺍니다. 내준 디저트는 바로 완료되고, 키오스크 예상 대기시간도 FIFO 차례가 아니라 이 기준으로 계산합니다.
- 4번 고르기(`/ai/pick-next`)와 작업창은 `fifo`를 끄면 다시 켜집니다. 설계는 [docs/pick-next-implementation.md](./docs/pick-next-implementation.md)입니다.
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
| SC-W | 시연용 | #126·#128 라떼 2잔과 #129 아이스 아메리카노 1잔을 별도 제조 블록으로 표시. 제조 완료는 해당 메뉴 줄에만 가로선 표시 |
| SC-Q | 시연용 | 1번 라떼와 #102 아이스 라떼는 같이(Zoro), #103 스무디는 따로(Zoro), #104 디카페인은 따로(코드). 화면 밖 10번째 #110 티라미수가 8번 칸에 올라와 샷 추출 30초 동안 먼저 나감. 입력 버튼으로 포장 아이스크림 추가 |

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
| POST | `/api/notes` | 8번 빠른 주문 칸 디저트를 내줬을 때 `{ note_id: "quick:#번호" }`. 8번 칸에 있는 주문만 완료한다 |
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

Zoro 서버 없이 화면 흐름을 끝까지 보려면 aiserver의 Zoro 대역(`scripts/stub_zoro.py`, 진짜 Zoro가 아니고 장비가 겹치면 비슷하다고 답함)을 씁니다. 대역으로 나온 묶음은 Zoro 정확도로 쓰면 안 됩니다.

```sh
# aiserver 폴더
uv run uvicorn scripts.stub_zoro:app --port 8090
ZORO_BASE_URL=http://127.0.0.1:8090 uv run uvicorn app.main:app --port 8001
# teamktb 폴더
AISERVER_URL=http://127.0.0.1:8001 npm run dev   # 상단 시연 장면에서 SC-Q를 고른다
```

GitHub Actions(`.github/workflows/ci.yml`)는 PR과 `main` 푸시마다 위 명령을 실행합니다. `AISERVER_REPO_TOKEN` 시크릿(aiserver 저장소 읽기 권한)이 있으면 aiserver를 체크아웃해 계약 테스트도 실행하며, 브랜치는 저장소 변수 `AISERVER_REF`(기본 `feat/ai-skeleton`)로 정합니다.
