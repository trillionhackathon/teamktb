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
| [주방 운영 보드](http://localhost:3000) | 일머리 퀘스트 보드(목업). 왼쪽 매장 알림, 오른쪽 위 4+4 주문 보드(1~4번 지금 만들 주문과 완료 버튼, 5~8번 Zoro가 고른 다음 주문), 오른쪽 아래 일머리 TIP(1번 주문을 끝내기 위한 할 일). 상단 버튼으로 시연용 자동 주문을 켜고 끕니다 |
| [키오스크](http://localhost:3000/kiosk) | 매장·포장 주문과 목업 결제. 결제가 끝나면 서버가 매긴 주문 번호와 예상 대기시간을 보여줍니다 |
| [배달 목업](http://localhost:3000/delivery) | 배달앱 주문과 라이더 메시지(거의 다 왔어요, N분 뒤 도착, 도착) |

## 데이터 흐름

```text
키오스크 / 배달 목업 ──POST /api/orders──▶ 주문 저장소(Next.js 서버) ──SSE /api/orders/stream──▶ 주방 운영 보드
주방 운영 보드 ──PATCH /api/orders/:번호, POST /api/events──▶ 주문 저장소 ──POST /ai/decide──▶ aiserver
```

- 주방 운영 보드는 서버 보드 순서를 받아 화면에서 4+4칸으로 다시 나눕니다. 후보 승격과 일머리 TIP은 Zoro 판단을 흉내 낸 목업 규칙([app/client/quest-board.ts](./app/client/quest-board.ts))이고, 고정칸과 미리 만든 잔 수는 브라우저 localStorage에 저장합니다.
- 메뉴·가격·옵션은 [data/recipe.json](./data/recipe.json), 제조 시간·보드 규칙·신뢰도 기준은 [data/cafe_db.json](./data/cafe_db.json), 시나리오는 [data/scenarios.json](./data/scenarios.json)과 [scenarios.md](./scenarios.md)를 읽습니다. 화면 쪽 하드코딩 메뉴는 없습니다.
- 주문 형식은 `cafe_db.json`의 `signals_schema.order`를 따릅니다(`order_id: "#101"`, `menu_items: [{menu, qty, size, options}]`, `channel: dine-in | takeout | delivery`).
- 제조 시간은 `remaining_work_formula`(첫 잔 + (수량-1)×추가 잔 + 옵션 `prep_delta_sec`)로 계산합니다. MVP 3종 외 음료는 같은 `complexity_tier` MVP 메뉴 값을 추정치로 씁니다(키오스크에 `(추정)` 표시).
- 주문은 Next.js 서버 메모리에 저장합니다. 서버를 다시 띄우면 공통 보드(#101~#110)로 돌아갑니다. 서버리스처럼 인스턴스가 여러 개인 환경에서는 주문이 공유되지 않습니다.

## 시나리오

매장 상황 패널에서 시나리오를 불러온 뒤 입력 버튼으로 한 단계씩 재생합니다.

| ID | 출처 | 재생 내용 |
| --- | --- | --- |
| SC-A | scenarios.json | `#108` 기사 메시지 "거의 다 왔어요" → 픽업 시간 확인 필요, "5분 뒤 도착" → 300초 확정 |
| SC-B | scenarios.json | `#108` 라이더 도착 → 6번 칸으로 이동 |
| SC-C | scenarios.json | 원두 12샷 + 대량 주문 → 팁은 AI 판단(work_tip) 결과만 표시 |
| SC-D | scenarios.json | 딸기 8인분 → 재고만큼만 스무디 주문 가능 |
| SC-01 | scenarios.md | `#111` 아이스 아메리카노 3잔 접수 → 대기열, 예상 대기시간 |
| SC-02 | scenarios.md | 쏟음 → 청소 팁(위치가 없으면 확인 필요) |
| SC-05 | scenarios.md | 블렌더 고장 → 스무디 포함 주문은 보드에 남고 재배치 후보·신규 주문에서 제외 |

같은 입력을 두 번 눌러도 한 번만 처리합니다(INV-03). 상황 입력창에 `108번 라이더 도착했어요`, `블렌더 고장`처럼 직접 입력해도 같은 규칙으로 처리합니다.

## AI 서버 연결

```sh
cp .env.example .env.local   # AISERVER_URL을 aiserver 주소로 바꾼다
npm run dev
```

- 주문 저장소는 상태가 바뀔 때마다 보드 10칸을 aiserver `POST /ai/decide`로 보내고, 응답이 1~5번 고정칸을 바꾸지 않고 보드에 있는 주문만 담았을 때 6~10번 순서를 적용합니다. 판단 중 상태가 바뀌면 늦게 온 응답은 버립니다(INV-04).
- 상황 입력은 `POST /ai/operator-input` 분류 결과를 이벤트에 함께 기록합니다.
- `AISERVER_URL`이 없거나 응답하지 않으면 `cafe_db.json` `fallback_rules`(FIFO + 라이더 도착 우선)로 정렬하고 `규칙 판단 · AI 서버 미응답`으로 표시합니다(INV-07).
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
| GET, POST | `/api/demo-feed` | 시연용 자동 주문 상태, `{ running: true \| false }`로 켜고 끄기. 5~12초마다 예시 주문을 넣고 보드에 16건이 쌓이면 잠시 멈춤. `DEMO_FEED=1`이면 서버 시작부터 켜짐 |

## 검증

```sh
npm run check
npm test
npm run build
```

`npm test`는 메뉴 계산, 보드 규칙, 이벤트 해석, 시나리오, 주문 저장소, aiserver 계약을 확인합니다. `AISERVER_URL`을 지정하면 실행 중인 aiserver로 SC-B를 재생해 계약을 함께 확인합니다. aiserver는 Zoro 없이도 규칙 폴백으로 응답합니다.

```sh
AISERVER_URL=http://127.0.0.1:8000 npm test
```

GitHub Actions(`.github/workflows/ci.yml`)는 PR과 `main` 푸시마다 위 명령을 실행합니다. `AISERVER_REPO_TOKEN` 시크릿(aiserver 저장소 읽기 권한)이 있으면 aiserver를 체크아웃해 계약 테스트도 실행하며, 브랜치는 저장소 변수 `AISERVER_REF`(기본 `feat/ai-skeleton`)로 정합니다.
