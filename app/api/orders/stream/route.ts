import { getOrderStore } from '../../../server/store-instance.ts';

export const dynamic = 'force-dynamic';

// 보드 스냅샷을 Server-Sent Events로 보낸다. 연결 직후 한 번, 이후 상태가 바뀔 때마다 보낸다.
export function GET(request: Request) {
  const store = getOrderStore();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const push = (snapshot: unknown) => send(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      const unsubscribe = store.subscribe(push);
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), 15000);
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
      request.signal.addEventListener('abort', () => {
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });
      send('retry: 2000\n\n');
      push(store.snapshot());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' },
  });
}
