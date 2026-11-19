'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { defaultOptions, menuItems, toOrderDetails } from '../kiosk/menu-data';
import { createOrderRequestId, openOrderChannel, type OrderSubmission } from '../order-channel';

const availableMenu = menuItems.filter((item) => !item.soldOut);

type Submission =
  | { phase: 'sending' | 'failed'; request: OrderSubmission }
  | { phase: 'accepted'; request: OrderSubmission; orderId: number };

export default function Delivery() {
  const [menuId, setMenuId] = useState(availableMenu[0].id);
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [submission, setSubmission] = useState<Submission>();
  const channelRef = useRef<ReturnType<typeof openOrderChannel>>(null);

  useEffect(() => {
    const channel = openOrderChannel((message) => {
      if (message.type !== 'order-accepted') return;
      setSubmission((current) => current?.request.requestId === message.requestId
        ? { phase: 'accepted', request: current.request, orderId: message.orderId }
        : current);
    });
    channelRef.current = channel;
    return () => {
      channel?.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (submission?.phase !== 'sending') return;
    const { request } = submission;
    channelRef.current?.post(request);
    const timer = window.setTimeout(() => {
      setSubmission((current) => current?.phase === 'sending' && current.request === request
        ? { phase: 'failed', request }
        : current);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [submission]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const item = availableMenu.find(({ id }) => id === menuId);
    const cups = Number(quantity);
    if (submission || !item || !Number.isInteger(cups) || cups < 1 || cups > 10) return;

    const details = toOrderDetails([{ key: item.id, item, options: defaultOptions(item), quantity: cups }], '배달');
    setSubmission({ phase: 'sending', request: {
      type: 'order-submitted',
      requestId: createOrderRequestId(),
      details: { ...details, note: note.trim() || undefined },
    } });
  }

  return (
    <>
      <header className="topbar"><div className="topbar-inner">
        <span className="brand">일머리</span>
        <div className="topbar-meta"><Link className="topbar-link" href="/" target="_blank">주방 운영 보드 열기</Link></div>
      </div></header>
      <main className="delivery-page">
        <h1>배달 주문 목업</h1>
        <form className="panel delivery-form" onSubmit={submit}>
          <fieldset disabled={Boolean(submission)}>
            <legend>배달 주문 내용</legend>
            <label>메뉴
              <select value={menuId} onChange={(e) => setMenuId(e.target.value)}>
                {availableMenu.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>수량
              <input type="number" min={1} max={10} required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <label>요청사항
              <textarea value={note} maxLength={200} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="예: 얼음은 반만 넣어 주세요" />
            </label>
            <button className="action-button" type="submit">배달 주문 보내기</button>
          </fieldset>
          {submission && (
            <div className="delivery-result" role="status">
              {submission.phase === 'sending' && <p>주방에 주문을 전달하고 있어요.</p>}
              {submission.phase === 'accepted' && <p>주문 <strong>#{submission.orderId}</strong>이 주방에 접수됐어요.</p>}
              {submission.phase === 'failed' && <p>접수 응답을 받지 못했어요. 같은 브라우저에서 주방 운영 보드가 열려 있는지 확인해 주세요.</p>}
            </div>
          )}
          {submission?.phase === 'failed' && <button className="secondary-button" type="button" onClick={() => setSubmission({ phase: 'sending', request: submission.request })}>다시 전송</button>}
          {submission?.phase === 'accepted' && <button className="secondary-button" type="button" onClick={() => { setSubmission(undefined); setQuantity('1'); setNote(''); }}>새 주문</button>}
        </form>
      </main>
    </>
  );
}
