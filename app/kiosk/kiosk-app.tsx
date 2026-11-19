'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { callApi, createRequestId } from '../client/api.ts';
import {
  exclusiveGroupLabels, exclusiveOptionGroups, formatDuration, formatPrice, formatWaitMinutes, lineName, maxLineQuantity, optionNames, orderWorkSeconds, toggleOption, unitPrice,
  type MenuCatalog, type MenuDrink,
} from '../domain/menu.ts';
import type { OrderLine, SizeId } from '../domain/types.ts';
import type { OrderView } from '../domain/views.ts';

type KioskChannel = 'dine-in' | 'takeout';
type CartLine = OrderLine & { key: string };

type Method = 'card' | 'easy-pay' | 'gift';
const methods: { id: Method; label: string; detail: string; instruction: string }[] = [
  { id: 'card', label: '신용·체크카드', detail: 'IC 카드, 삼성페이', instruction: '카드를 단말기에 꽂아주세요' },
  { id: 'easy-pay', label: '간편결제', detail: '카카오페이, 네이버페이, 토스페이', instruction: '휴대폰 결제 바코드를 스캐너에 보여주세요' },
  { id: 'gift', label: '모바일 상품권', detail: '기프티콘, 매장 쿠폰', instruction: '상품권 바코드를 스캐너에 보여주세요' },
];

type Payment = {
  step: 'review' | 'processing' | 'done' | 'failed';
  method: Method;
  requestId: string;
  sending: boolean;
  total: number;
  order?: OrderView;
  waitSeconds?: number;
  error?: string;
};

const approveDelay = 1600;
const resetSeconds = 15;
const channelLabels: Record<KioskChannel, string> = { 'dine-in': '매장 식사', takeout: '포장' };
const temperatureLabels: Record<MenuDrink['temperature'], string> = { ICE: 'ICE', HOT: 'HOT', BLENDED: 'BLENDED' };

function lineKey(line: OrderLine): string {
  return [line.menu, line.size, ...line.options].join(':');
}

export default function KioskApp({ catalog, initialAvailability }: { catalog: MenuCatalog; initialAvailability: Record<string, string> }) {
  const [channel, setChannel] = useState<KioskChannel | null>(null);
  const [category, setCategory] = useState(catalog.categories[0]?.id ?? '');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<MenuDrink | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [countdown, setCountdown] = useState(resetSeconds);
  const [availability, setAvailability] = useState(initialAvailability);

  const cups = cart.reduce((sum, line) => sum + line.qty, 0);
  const total = cart.reduce((sum, line) => sum + unitPrice(catalog, line) * line.qty, 0);
  const visibleDrinks = catalog.drinks.filter((drink) => drink.category === category);
  const step = payment?.step;
  const requestId = payment?.requestId;

  // 품절·장비 점검 상태는 주문 저장소 기준이다. 처음 화면으로 돌아올 때마다 다시 확인한다.
  useEffect(() => {
    if (channel) return;
    void callApi<{ availability: Record<string, string> }>('/api/menu').then((result) => {
      if (result.ok) setAvailability(result.data.availability);
    });
  }, [channel]);

  // 목업 결제 승인 뒤 주문을 서버에 접수한다. 같은 requestId로 다시 보내면 같은 주문을 돌려받는다.
  useEffect(() => {
    if (step !== 'processing' || !requestId) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPayment((previous) => (previous ? { ...previous, sending: true } : previous));
      const result = await callApi<{ order: OrderView; wait_seconds: number }>('/api/orders', {
        body: { request_id: requestId, channel, source: 'kiosk', menu_items: cart.map(({ menu, qty, size, options }) => ({ menu, qty, size, options })) },
      });
      if (cancelled) return;
      if (result.ok) {
        setPayment((previous) => (previous?.requestId === requestId ? { ...previous, step: 'done', order: result.data.order, waitSeconds: result.data.wait_seconds } : previous));
        setCountdown(resetSeconds);
      } else {
        setPayment((previous) => (previous?.requestId === requestId ? { ...previous, step: 'failed', error: result.error } : previous));
      }
    }, approveDelay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, requestId]);

  useEffect(() => {
    if (step !== 'done') return;
    const interval = window.setInterval(() => setCountdown((previous) => previous - 1), 1000);
    return () => window.clearInterval(interval);
  }, [step]);

  useEffect(() => {
    if (step === 'done' && countdown <= 0) resetKiosk();
  }, [step, countdown]);

  function resetKiosk() {
    setPayment(null);
    setCart([]);
    setChannel(null);
    setCategory(catalog.categories[0]?.id ?? '');
  }

  function addToCart(line: OrderLine) {
    const key = lineKey(line);
    setCart((previous) => {
      const existing = previous.find((item) => item.key === key);
      if (!existing) return [...previous, { ...line, key }];
      return previous.map((item) => (item.key === key ? { ...item, qty: Math.min(maxLineQuantity, item.qty + line.qty) } : item));
    });
    setSelected(null);
  }

  function changeQuantity(key: string, delta: number) {
    setCart((previous) => previous
      .map((line) => (line.key === key ? { ...line, qty: Math.min(maxLineQuantity, line.qty + delta) } : line))
      .filter((line) => line.qty > 0));
  }

  function openPayment() {
    if (!channel || !cart.length) return;
    setPayment({ step: 'review', method: 'card', requestId: createRequestId('kiosk'), sending: false, total });
  }

  if (!channel) {
    return (
      <>
        <KioskTopbar />
        <main className="kiosk kiosk-welcome">
          <div className="welcome-heading">
            <p className="board-context">성수점 셀프 주문</p>
            <h1>어디에서 드시나요?</h1>
            <p className="welcome-sub">주문하신 음료는 바로 주방 운영 보드로 전달돼요.</p>
          </div>
          <div className="welcome-choices">
            <button type="button" className="welcome-choice" onClick={() => setChannel('dine-in')}>
              <span className="welcome-choice-label">매장에서 먹어요</span>
              <span className="welcome-choice-detail">머그잔과 유리잔에 담아드려요</span>
            </button>
            <button type="button" className="welcome-choice" onClick={() => setChannel('takeout')}>
              <span className="welcome-choice-label">포장해 가요</span>
              <span className="welcome-choice-detail">일회용 컵과 캐리어에 담아드려요</span>
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <KioskTopbar />
      <main className="kiosk">
        <div className="kiosk-layout">
          <section className="kiosk-menu" aria-labelledby="menu-title">
            <div className="board-heading">
              <div>
                <p className="board-context">성수점 셀프 주문 · {channelLabels[channel]}</p>
                <h1 id="menu-title">메뉴를 골라주세요</h1>
              </div>
              <button type="button" className="secondary-button kiosk-home" onClick={resetKiosk}>처음으로</button>
            </div>

            <div className="category-tabs" role="tablist" aria-label="메뉴 분류">
              {catalog.categories.map(({ id, name_kr: name }) => (
                <button key={id} type="button" role="tab" aria-selected={category === id} aria-controls="menu-grid" className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>
                  {name}
                </button>
              ))}
            </div>

            <div className="menu-grid" id="menu-grid" role="tabpanel" aria-label="메뉴">
              {visibleDrinks.map((drink) => {
                const inCart = cart.filter((line) => line.menu === drink.id).reduce((sum, line) => sum + line.qty, 0);
                const unavailable = availability[drink.id];
                return (
                  <button key={drink.id} type="button" className={`menu-card ${inCart ? 'in-cart' : ''}`} disabled={Boolean(unavailable)} onClick={() => setSelected(drink)}>
                    <MenuPhoto id={drink.id} className="menu-photo" />
                    <span className="menu-card-top">
                      <span>{temperatureLabels[drink.temperature]}</span>
                      {unavailable ? <span className="menu-badge sold-out">{unavailable}</span> : drink.is_mvp && <span className="menu-badge">대표 메뉴</span>}
                    </span>
                    <span className="menu-name">{drink.name_kr}</span>
                    <span className="menu-description">예상 제조 {formatDuration(drink.first_cup_sec)}{drink.timing_basis === 'tier_estimate' ? ' (추정)' : ''}</span>
                    <span className="menu-card-bottom">
                      <strong>{formatPrice(drink.price_krw)}</strong>
                      {inCart > 0 && <span className="menu-in-cart">{inCart}잔 담김</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="kiosk-cart" aria-labelledby="cart-title">
            <div className="panel cart-panel">
              <div className="panel-heading">
                <h2 id="cart-title">주문 내역</h2>
                <span className="panel-meta" aria-live="polite">{cups}잔</span>
              </div>
              <div className="channel-toggle" role="radiogroup" aria-label="식사 방법">
                {(['dine-in', 'takeout'] as KioskChannel[]).map((option) => (
                  <button key={option} type="button" role="radio" aria-checked={channel === option} className={channel === option ? 'active' : ''} onClick={() => setChannel(option)}>
                    {channelLabels[option]}
                  </button>
                ))}
              </div>
              {cart.length ? (
                <ol className="cart-list" aria-label="담은 음료" tabIndex={cart.length > 4 ? 0 : undefined}>
                  {cart.map((line) => {
                    const name = lineName(catalog, line);
                    const labels = optionNames(catalog, line.options);
                    return (
                      <li key={line.key} className="cart-line">
                        <div className="cart-line-info">
                          <p className="cart-line-name">{name}</p>
                          {labels.length > 0 && <p className="cart-line-options">{labels.join(', ')}</p>}
                          <p className="cart-line-price">{formatPrice(unitPrice(catalog, line) * line.qty)}</p>
                        </div>
                        <Stepper label={name} value={line.qty} onDecrease={() => changeQuantity(line.key, -1)} onIncrease={() => changeQuantity(line.key, 1)} decreaseLabel={line.qty === 1 ? '삭제' : '빼기'} />
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="cart-empty">메뉴를 누르면 여기에 담겨요.</p>
              )}
              {cart.length > 0 && (
                <div className="cart-controls">
                  <button type="button" className="secondary-button" onClick={() => setCart([])}>전체 삭제</button>
                </div>
              )}
            </div>

            <section className="action-panel checkout-panel" aria-label="결제">
              <h2>총 결제 금액</h2>
              <p className="checkout-total">{formatPrice(total)}</p>
              <p className="action-detail">
                <span>{cups}잔</span>
                {cart.length > 0 && <span>예상 제조 {formatDuration(orderWorkSeconds(catalog, cart))}</span>}
              </p>
              <button type="button" className="action-button checkout-button" disabled={!cart.length} onClick={openPayment}>
                {cart.length ? `${formatPrice(total)} 결제하기` : '메뉴를 담아주세요'}
              </button>
            </section>
          </aside>
        </div>
      </main>

      {selected && <OptionDialog catalog={catalog} drink={selected} onClose={() => setSelected(null)} onAdd={addToCart} />}
      {payment && (
        <PaymentDialog
          catalog={catalog}
          payment={payment}
          cart={cart}
          channel={channel}
          countdown={countdown}
          onMethodChange={(method) => setPayment({ ...payment, method })}
          onPay={() => setPayment({ ...payment, step: 'processing', sending: false, error: undefined })}
          onClose={() => (payment.step === 'done' ? resetKiosk() : setPayment(null))}
        />
      )}
    </>
  );
}

function KioskTopbar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">일머리</span>
        <span className="topbar-meta">키오스크 · 결제 목업 <Link className="topbar-link" href="/" target="_blank">주방 운영 보드 열기</Link></span>
      </div>
    </header>
  );
}

function Stepper({ label, value, onDecrease, onIncrease, decreaseLabel = '빼기', min = 0 }: {
  label: string; value: number; onDecrease: () => void; onIncrease: () => void; decreaseLabel?: string; min?: number;
}) {
  return (
    <div className="stepper" role="group" aria-label={`${label} 수량`}>
      <button type="button" onClick={onDecrease} disabled={value <= min} aria-label={`${label} ${decreaseLabel}`}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={onIncrease} disabled={value >= maxLineQuantity} aria-label={`${label} 한 잔 더`}>+</button>
    </div>
  );
}

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return { ref, onCancel: (e: SyntheticEvent) => { e.preventDefault(); onClose(); } };
}

// 메뉴 사진은 public/menu/<메뉴 id>.jpg. 파일이 없으면 칸을 그리지 않는다.
function MenuPhoto({ id, className }: { id: string; className: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={`/menu/${id}.jpg`} alt="" loading="lazy" onError={() => setMissing(true)} />;
}

function OptionDialog({ catalog, drink, onClose, onAdd }: { catalog: MenuCatalog; drink: MenuDrink; onClose: () => void; onAdd: (line: OrderLine) => void }) {
  const { ref, onCancel } = useModal(onClose);
  const [size, setSize] = useState<SizeId>(drink.sizes[0] ?? 'R');
  const [options, setOptions] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const line: OrderLine = { menu: drink.id, qty, size, options: [...options].sort() };
  const grouped = new Set(exclusiveOptionGroups.flat());
  const groups = exclusiveOptionGroups
    .map((group, index) => ({ label: exclusiveGroupLabels[index], ids: group.filter((id) => drink.options.includes(id)) }))
    .filter(({ ids }) => ids.length > 0);
  const singles = drink.options.filter((id) => !grouped.has(id));

  return (
    <dialog ref={ref} className="kiosk-dialog" aria-labelledby="option-title" onCancel={onCancel}>
      <div className="dialog-heading">
        <MenuPhoto id={drink.id} className="dialog-photo" />
        <p className="board-context">{catalog.categories.find(({ id }) => id === drink.category)?.name_kr} · {temperatureLabels[drink.temperature]}</p>
        <h2 id="option-title">{drink.name_kr}</h2>
        <p className="dialog-sub">{formatPrice(drink.price_krw)} · 첫 잔 {formatDuration(drink.first_cup_sec)}, 추가 잔 {formatDuration(drink.additional_cup_sec)}</p>
      </div>
      <div className="dialog-body">
        {drink.sizes.length > 1 && (
          <fieldset className="option-group">
            <legend className="option-legend">사이즈</legend>
            <div className="option-choices">
              {drink.sizes.map((id) => (
                <label key={id} className={`option-choice ${size === id ? 'selected' : ''}`}>
                  <input type="radio" name="size" value={id} checked={size === id} onChange={() => setSize(id)} />
                  <span>{catalog.sizes[id].name_kr}{catalog.sizes[id].price_delta_krw ? <small>+{formatPrice(catalog.sizes[id].price_delta_krw)}</small> : null}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {[...groups, ...(singles.length ? [{ label: '추가 요청', ids: singles }] : [])].map(({ label, ids }) => (
          <fieldset className="option-group" key={ids.join()}>
            <legend className="option-legend">{label}</legend>
            <div className="option-choices option-wrap">
              {ids.map((id) => {
                const option = catalog.options[id];
                const checked = options.includes(id);
                return (
                  <label key={id} className={`option-choice ${checked ? 'selected' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => setOptions((previous) => toggleOption(previous, id))} />
                    <span>{option?.name_kr ?? id}{option?.price_krw ? <small>+{formatPrice(option.price_krw)}</small> : null}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <div className="option-quantity">
          <span className="option-legend">수량</span>
          <Stepper label={drink.name_kr} value={qty} min={1} onDecrease={() => setQty((q) => Math.max(1, q - 1))} onIncrease={() => setQty((q) => Math.min(maxLineQuantity, q + 1))} />
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="dialog-secondary" onClick={onClose}>취소</button>
        <button type="button" className="action-button" onClick={() => onAdd(line)}>{qty}잔 담기 · {formatPrice(unitPrice(catalog, line) * qty)}</button>
      </div>
    </dialog>
  );
}

function PaymentDialog({ catalog, payment, cart, channel, countdown, onMethodChange, onPay, onClose }: {
  catalog: MenuCatalog; payment: Payment; cart: CartLine[]; channel: KioskChannel; countdown: number;
  onMethodChange: (method: Method) => void; onPay: () => void; onClose: () => void;
}) {
  const busy = payment.step === 'processing';
  const { ref, onCancel } = useModal(() => { if (!busy) onClose(); });
  const method = methods.find(({ id }) => id === payment.method) ?? methods[0];

  return (
    <dialog ref={ref} className="kiosk-dialog payment-dialog" aria-labelledby="payment-title" onCancel={onCancel}>
      {payment.step === 'review' && <>
        <div className="dialog-heading">
          <p className="board-context">{channelLabels[channel]} · {cart.reduce((sum, line) => sum + line.qty, 0)}잔</p>
          <h2 id="payment-title">결제 수단을 골라주세요</h2>
        </div>
        <div className="dialog-body">
          <ul className="payment-summary" aria-label="결제할 음료">
            {cart.map((line) => (
              <li key={line.key}>
                <span>{lineName(catalog, line)} <span>{line.qty}잔</span></span>
                <span>{formatPrice(unitPrice(catalog, line) * line.qty)}</span>
              </li>
            ))}
            <li className="payment-summary-total"><span>합계</span><span>{formatPrice(payment.total)}</span></li>
          </ul>
          <fieldset className="option-group">
            <legend className="option-legend">결제 수단</legend>
            <div className="method-choices">
              {methods.map((option) => (
                <label key={option.id} className={`method-choice ${payment.method === option.id ? 'selected' : ''}`}>
                  <input type="radio" name="method" value={option.id} checked={payment.method === option.id} onChange={() => onMethodChange(option.id)} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>이전</button>
          <button type="button" className="action-button" onClick={onPay}>{formatPrice(payment.total)} 결제하기</button>
        </div>
      </>}

      {payment.step === 'processing' && (
        <div className="payment-status" role="status" aria-live="polite">
          <p className="board-context">{method.label}</p>
          <h2 id="payment-title">{payment.sending ? '주방에 주문을 전달하고 있어요' : method.instruction}</h2>
          <p className="dialog-sub">{payment.sending ? '주문 번호를 받는 중이에요.' : `${formatPrice(payment.total)} 결제 승인을 기다리고 있어요.`}</p>
          <div className="payment-progress" aria-hidden="true"><span className={payment.sending ? 'sending' : ''} /></div>
        </div>
      )}

      {payment.step === 'done' && payment.order && <>
        <div className="payment-status" role="status" aria-live="polite">
          <p className="board-context">결제 완료 · {formatPrice(payment.total)}</p>
          <h2 id="payment-title">주문 번호</h2>
          <p className="payment-order-number">{payment.order.order_id}</p>
          <p className="dialog-sub">주방 운영 보드에 주문이 들어갔어요. 번호가 불리면 픽업대에서 받아주세요.</p>
          <dl className="payment-facts">
            <div><dt>음료</dt><dd>{payment.order.items.map(({ name, qty }) => `${name} ${qty}잔`).join(', ')}</dd></div>
            <div><dt>식사 방법</dt><dd>{payment.order.channel_label}</dd></div>
            <div><dt>예상 대기</dt><dd>{formatWaitMinutes(payment.waitSeconds ?? payment.order.remaining_work_seconds)}</dd></div>
          </dl>
        </div>
        <div className="dialog-actions">
          <button type="button" className="action-button" onClick={onClose}>처음으로 ({Math.max(0, countdown)})</button>
        </div>
      </>}

      {payment.step === 'failed' && <>
        <div className="payment-status" role="alert">
          <p className="board-context">주문 접수 실패</p>
          <h2 id="payment-title">주문을 접수하지 못했어요</h2>
          <p className="dialog-sub">{payment.error} 결제는 진행되지 않았어요.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-secondary" onClick={onClose}>닫기</button>
          <button type="button" className="action-button" onClick={onPay}>다시 시도</button>
        </div>
      </>}
    </dialog>
  );
}
