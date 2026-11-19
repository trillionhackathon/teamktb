import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './delivery.css';

export const metadata: Metadata = { title: '일머리 | 배달 주문 목업' };

export default function DeliveryLayout({ children }: { children: ReactNode }) {
  return children;
}
