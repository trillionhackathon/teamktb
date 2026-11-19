import type { EventCategory, RiderStatus, Tip } from './types.ts';

// 매장 상황 입력을 상태 변경으로 바꾸는 규칙. scenarios.md SC-02(쏟음), SC-03/SC-A(배달 메시지), SC-05(블렌더) 기준이다.
// 숫자 변환은 코드만 한다. 확인되지 않은 표현은 숫자로 바꾸지 않고 needs_confirmation으로 남긴다(INV-05).
export type EventEffect =
  | { type: 'rider_status'; order_id: string; status: RiderStatus }
  | { type: 'pickup_eta'; order_id: string; seconds: number }
  | { type: 'needs_confirmation'; order_id: string }
  | { type: 'tip'; tip: Tip }
  | { type: 'clear_tip'; tip_id: string }
  | { type: 'equipment'; equipment: string; status: 'ok' | 'broken' };

export type Interpretation = { category: EventCategory; order_id?: string; needs_confirmation: boolean; summary: string; effects: EventEffect[] };

export function findOrderId(text: string): string | undefined {
  const match = /#\s*(\d+)|(\d+)\s*번/.exec(text);
  return match ? `#${match[1] ?? match[2]}` : undefined;
}

const koreanNumbers: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };

export function parseEtaSeconds(text: string): number | undefined {
  const match = /(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*분\s*(?:뒤|후|있다가|안에|내로)?\s*(?:에\s*)?도착/.exec(text);
  if (!match) return undefined;
  const minutes = /^\d+$/.test(match[1]) ? Number(match[1]) : koreanNumbers[match[1]];
  return minutes > 0 && minutes <= 120 ? minutes * 60 : undefined;
}

export function interpretEvent(rawText: string, explicitOrderId?: string, hint?: EventCategory): Interpretation {
  const text = rawText.trim();
  const orderId = explicitOrderId ?? findOrderId(text);

  // SC-C: 대량 주문처럼 재고 판단이 필요한 입력은 규칙이 팁을 만들지 않고 AI(work_tip) 결과를 따른다.
  if (hint === 'stock_shortage' && !/원두|샷|딸기/.test(text)) {
    return { category: 'stock_shortage', order_id: orderId, needs_confirmation: false, summary: '재고 판단은 AI 팁 결과를 따라요', effects: [] };
  }

  if (/쏟/.test(text)) {
    const located = /통행로|입구|카운터|테이블|바닥|화장실|계단/.exec(text)?.[0];
    return {
      category: 'spill_cleanup',
      needs_confirmation: !located,
      summary: located ? `${located} 쏟음 - 청소 팁 표시` : '쏟은 위치 확인 필요',
      effects: [{ type: 'tip', tip: { id: 'spill', text: located ? `${located} 커피 쏟음 - 바닥 청소 필요` : '커피 쏟음 - 위치 확인 후 바닥 청소', source: 'rule' } }],
    };
  }

  if (/블렌더/.test(text)) {
    if (/복구|고쳤|고쳐|정상|다시\s*돼|돌아가/.test(text)) {
      return {
        category: 'equipment_recovered',
        needs_confirmation: false,
        summary: '블렌더 복구 - 스무디 주문 후보 복귀',
        effects: [{ type: 'equipment', equipment: 'blender', status: 'ok' }, { type: 'clear_tip', tip_id: 'blender' }],
      };
    }
    if (/고장|안\s*돼|멈|꺼졌|안\s*돌아/.test(text)) {
      return {
        category: 'equipment_failure',
        needs_confirmation: false,
        summary: '블렌더 고장 - 스무디 포함 주문 4번 후보에서 제외',
        effects: [
          { type: 'equipment', equipment: 'blender', status: 'broken' },
          { type: 'tip', tip: { id: 'blender', text: '블렌더 고장 - 스무디 포함 주문 보류', source: 'rule' } },
        ],
      };
    }
  }

  if (/원두|샷/.test(text) && /부족|없|떨어|모자|\d+\s*잔/.test(text)) {
    return {
      category: 'stock_shortage',
      needs_confirmation: false,
      summary: '원두 재고 확인 팁 후보',
      effects: [{ type: 'tip', tip: { id: 'beans', text: '원두 재고 확인 필수', source: 'rule' } }],
    };
  }

  if (/딸기/.test(text) && /부족|없|떨어|모자/.test(text)) {
    return {
      category: 'stock_shortage',
      needs_confirmation: false,
      summary: '딸기 재고 확인 팁 후보',
      effects: [{ type: 'tip', tip: { id: 'fruit', text: '딸기 재고 확인 - 스무디 판매 조절', source: 'rule' } }],
    };
  }

  if (/라이더|기사|배달|도착|픽업/.test(text)) {
    if (!orderId) {
      return { category: 'rider_message', needs_confirmation: true, summary: '대상 주문 번호 확인 필요', effects: [] };
    }
    const etaSeconds = parseEtaSeconds(text);
    if (etaSeconds !== undefined) {
      return {
        category: 'pickup_eta_update',
        order_id: orderId,
        needs_confirmation: false,
        summary: `${orderId} 픽업 ${etaSeconds}초 뒤로 확정`,
        effects: [{ type: 'pickup_eta', order_id: orderId, seconds: etaSeconds }, { type: 'rider_status', order_id: orderId, status: 'dispatched' }],
      };
    }
    const vague = /거의|곧|금방|조금|근처/.test(text);
    const quality = /녹|식지|안\s*식|따뜻하게|차갑게/.test(text);
    if (vague || quality) {
      return {
        category: quality ? 'quality_request' : 'rider_message',
        order_id: orderId,
        needs_confirmation: true,
        summary: `${orderId} 픽업 시간 확인 필요${quality ? ' · 품질 요청' : ''}`,
        effects: [{ type: 'needs_confirmation', order_id: orderId }],
      };
    }
    if (/도착했|도착\s*완료|왔어요|왔습니다|기다리고|대기\s*중/.test(text)) {
      return {
        category: 'rider_arrived',
        order_id: orderId,
        needs_confirmation: false,
        summary: `${orderId} 라이더 도착 - 다음 4번 고르기에서 반영`,
        effects: [{ type: 'rider_status', order_id: orderId, status: 'arrived' }],
      };
    }
  }

  return { category: 'unknown', order_id: orderId, needs_confirmation: true, summary: '분류하지 못한 입력 - 직원 확인 필요', effects: [] };
}
