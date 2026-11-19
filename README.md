# 일머리

- [카페 관제탑 서비스 소개](./service.md)
- [사용자 시나리오](./scenarios.md) · [메뉴·AI 계약 데이터](./data/cafe_db.json)

카페 주문과 다음 제조 작업을 보여주는 주방 운영 보드입니다.

## 로컬 실행

```sh
npm ci
npm run dev
```

[로컬 대시보드](http://localhost:3000)의 상단 주문 카드는 제조 우선순위순으로 표시됩니다. 예를 들어 `108번 포장 손님이 픽업대에서 기다려요`라고 입력하면 해당 대기 주문의 순위와 다음 작업이 갱신됩니다. 주문 접수 내역은 최신 접수순으로 표시됩니다. 현재 자연어 처리는 시연용 규칙을 사용하며 페이지를 새로고침하면 초기 상태로 돌아갑니다.

[키오스크](http://localhost:3000/kiosk)의 매장·포장 주문과 [배달 목업](http://localhost:3000/delivery)의 배달 주문은 같은 대시보드에 접수됩니다. 두 화면 모두 대시보드가 매긴 주문 번호를 받습니다. 결제는 목업이며, 세 화면은 같은 브라우저와 동일한 주소에서 `BroadcastChannel`로 연결됩니다. 한 주소에서 대시보드 탭을 하나 열어 둔 상태로 시연합니다.

## AI 서버 연결

대시보드는 Next.js 서버의 `/api/ai/decide`, `/api/ai/operator-input`을 거쳐 [aiserver](https://github.com/trillionhackathon/aiserver)의 `POST /ai/decide`, `POST /ai/operator-input`을 호출합니다. 요청·응답 형식은 [app/ai/contract.ts](./app/ai/contract.ts)에 aiserver `app/schemas.py`와 맞춰 두었습니다.

```sh
cp .env.example .env.local   # AISERVER_URL을 aiserver 주소로 바꾼다
npm run dev
```

- 응답이 오면 순위 패널에 `AI 서버 · Zoro 판단` 또는 `AI 서버 · 규칙 판단`이 표시되고, 1~5번은 접수순 고정, 6~10번은 aiserver 순서를 따릅니다.
- `AISERVER_URL`이 없거나 서버가 응답하지 않으면 `예시 판단 · AI 서버 미연결`로 표시하고 기존 예시 순위로 계속 동작합니다.
- 대기 주문이 바뀌면 이전 요청을 취소하고 마지막 상태의 응답만 반영합니다.

## 검증

```sh
npm run check
npm test
npm run build
```

`AISERVER_URL`을 지정하고 `npm test`를 실행하면 실행 중인 aiserver에 요청해 계약을 함께 확인합니다. aiserver는 Zoro 없이도 규칙 폴백으로 응답합니다.

```sh
AISERVER_URL=http://127.0.0.1:8000 npm test
```

GitHub Actions(`.github/workflows/ci.yml`)는 PR과 `main` 푸시마다 위 명령을 실행합니다. `AISERVER_REPO_TOKEN` 시크릿(aiserver 저장소 읽기 권한)이 있으면 aiserver를 체크아웃해 계약 테스트도 실행하며, 브랜치는 저장소 변수 `AISERVER_REF`(기본 `feat/ai-skeleton`)로 정합니다.
