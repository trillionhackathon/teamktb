import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './kiosk.css';

export const metadata: Metadata = {
  title: '일머리 | 키오스크',
  description: '음료를 고르고 결제하면 주방 운영 보드 주문 목록으로 바로 전달되는 셀프 주문 키오스크',
};

export default function KioskLayout({ children }: { children: ReactNode }) {
  return children;
}
