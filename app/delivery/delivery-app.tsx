'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { callApi, createRequestId } from '../client/api.ts';
import { formatClock, useBoardSnapshot } from '../client/use-board.ts';
import { formatPrice, formatWaitMinutes, maxLineQuantity, unitPrice, type MenuCatalog } from '../domain/menu.ts';
import type { SizeId, StoreEvent } from '../domain/types.ts';
import type { BoardSnapshot, OrderView } from '../domain/views.ts';

// 배달앱 주문과 라이더 메시지를 흉내 낸다. 둘 다 주방 보드와 같은 주문 저장소 API로 들어간다.
const riderMessages = ['기사님 거의 다 왔어요. 스무디 안 녹게 부탁드려요.', '5분 뒤 도착합니다.', '라이더 도착했어요.'];

type Submission = { phase: 'sending' } | { phase: 'accepted'; order: OrderView; waitSeconds: number } | { phase: 'failed'; error: string };

export default function DeliveryApp({ catalog, initial }: { catalog: MenuCatalog; initial: BoardSnapshot }) {
  const { snapshot: live } = useBoardSnapshot(initial);
  const snapshot = live ?? initial;
  const [menuId, setMenuId] = useState(catalog.drinks.find(({ id }) => id === 'strawberry_smoothie')?.id ?? catalog.drinks[0].id);
  const [size, setSize] = useState<SizeId>('R');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');
  const [submission, setSubmission] = useState<Submission>();
  const [requestId, setRequestId] = useState(() => createRequestId('delivery'));
  const [riderResult, setRiderResult] = useState<{ text: string; error: boolean }>();

  const drink = catalog.drinks.find(({ id }) => id === menuId)!;
  const unavailable = snapshot.availability[menuId];
  const deliveryOrders = snapshot.history.filter(({ channel, status }) => channel === 'delivery' && status !== 'done');
  const cups = Number(qty);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send();
  }

  // 같은 requestId로 다시 보내면 서버가 같은 주문을 돌려줘 중복 접수되지 않는다.
  async function send() {
    if (!Number.isInteger(cups) || cups < 1 || cups > maxLineQuantity) return;
    setSubmission({ phase: 'sending' });
    const result = await callApi<{ order: OrderView; wait_seconds: number }>('/api/orders', {
      body: {
        request_id: requestId,
        channel: 'delivery',
        source: 'delivery_app',
        menu_items: [{ menu: menuId, qty: cups, size: drink.sizes.includes(size) ? size : 'R' }],
        request_note: note.trim() || undefined,
      },
    });
    setSubmission(result.ok ? { phase: 'accepted', order: result.data.order, waitSeconds: result.data.wait_seconds } : { phase: 'failed', error: result.error });
  }

  function reset() {
    setSubmission(undefined);
    setRequestId(createRequestId('delivery'));
    setQty('1');
    setNote('');
  }

  async function sendRiderMessage(order: OrderView, text: string) {
    const result = await callApi<{ event: StoreEvent }>('/api/events', { body: { event_id: createRequestId('rider'), raw_text: text, order_id: order.order_id } });
    setRiderResult(result.ok ? { text: `${order.order_id}: ${result.data.event.summary}`, error: false } : { text: result.error, error: true });
  }

  return (
    <>
      <header className="topbar"><div className="topbar-inner">
        <span className="brand">일머리</span>
        <div className="topbar-meta">배달앱 목업 <Link className="topbar-link" href="/" target="_blank">주방 운영 보드 열기</Link></div>
      </div></header>
      <main className="delivery-page">
        <h1>배달 주문 목업</h1>
        <form className="panel delivery-form" onSubmit={submit}>
          <fieldset disabled={Boolean(submission)}>
            <legend>배달 주문 내용</legend>
            <label>메뉴
              <select value={menuId} onChange={(e) => setMenuId(e.target.value)}>
                {catalog.categories.map((category) => (
                  <optgroup key={category.id} label={category.name_kr}>
                    {catalog.drinks.filter((item) => item.category === category.id).map((item) => (
                      <option key={item.id} value={item.id} disabled={Boolean(snapshot.availability[item.id])}>
                        {item.name_kr} · {formatPrice(item.price_krw)}{snapshot.availability[item.id] ? ` (${snapshot.availability[item.id]})` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="delivery-row">
              <label>사이즈
                <select value={size} onChange={(e) => setSize(e.target.value as SizeId)}>
                  {drink.sizes.map((id) => <option key={id} value={id}>{catalog.sizes[id].name_kr}</option>)}
                </select>
              </label>
              <label>수량
                <input type="number" min={1} max={maxLineQuantity} required value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>
            </div>
            <label>요청사항
              <textarea value={note} maxLength={200} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="예: 얼음은 반만 넣어 주세요" />
            </label>
            <p className="delivery-total">합계 {formatPrice(unitPrice(catalog, { menu: menuId, size: drink.sizes.includes(size) ? size : 'R', options: [] }) * (Number.isInteger(cups) ? cups : 0))}</p>
            <button className="action-button" type="submit" disabled={Boolean(unavailable)}>{unavailable ? unavailable : '배달 주문 보내기'}</button>
          </fieldset>
          {submission && (
            <div className="delivery-result" role="status">
              {submission.phase === 'sending' && <p>주방에 주문을 전달하고 있어요.</p>}
              {submission.phase === 'accepted' && <p>주문 <strong>{submission.order.order_id}</strong>이 주방에 접수됐어요. 예상 대기 {formatWaitMinutes(submission.waitSeconds)}.</p>}
              {submission.phase === 'failed' && <p>{submission.error}</p>}
            </div>
          )}
          {submission?.phase === 'failed' && <button className="secondary-button" type="button" onClick={() => { void send(); }}>다시 전송</button>}
          {submission?.phase === 'accepted' && <button className="secondary-button" type="button" onClick={reset}>새 주문</button>}
          {submission?.phase === 'failed' && <button className="secondary-button" type="button" onClick={reset}>새로 작성</button>}
        </form>

        <section className="panel delivery-status" aria-labelledby="delivery-status-title">
          <div className="panel-heading">
            <h2 id="delivery-status-title">배달 주문 현황</h2>
            <span className="panel-meta">진행 중 {deliveryOrders.length}건</span>
          </div>
          {deliveryOrders.length === 0 && <p className="delivery-empty">진행 중인 배달 주문이 없어요.</p>}
          <ul className="delivery-orders">
            {deliveryOrders.map((order) => (
              <li key={order.order_id}>
                <div className="delivery-order-head">
                  <strong>{order.order_id}</strong>
                  <span>{order.items.map(({ name, qty: count }) => `${name} ${count}잔`).join(', ')}</span>
                  <span>{formatClock(order.received_at)} 접수 · {order.status === 'in_progress' ? '제조 중' : '대기'}</span>
                </div>
                <p className="delivery-order-state">
                  {order.rider_label}
                  {order.needs_confirmation ? ' · 픽업 시간 확인 필요' : ''}
                  {order.eta_confirmed && order.pickup_eta_seconds != null ? ` · 픽업 ${Math.round(order.pickup_eta_seconds / 60)}분 뒤 확정` : ''}
                </p>
                <div className="event-examples" aria-label={`${order.order_id} 라이더 메시지`}>
                  {riderMessages.map((message) => <button key={message} type="button" onClick={() => sendRiderMessage(order, message)}>{message}</button>)}
                </div>
              </li>
            ))}
          </ul>
          {riderResult && <p className={`dashboard-notice${riderResult.error ? ' error' : ''}`} role="status">{riderResult.text}</p>}
        </section>
      </main>
    </>
  );
}
