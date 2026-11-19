import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './globals.css';

export const metadata: Metadata = {
  title: '일머리 | 주방 운영 보드',
  description: '카페 주문과 다음 제조 작업을 한 화면에서 확인하는 주방 운영 보드',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
