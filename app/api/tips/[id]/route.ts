import { badRequest, errorResponse } from '../../../server/http.ts';
import { getOrderStore } from '../../../server/store-instance.ts';

// 직원이 처리한 팁을 내린다(SC-02 3단계).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w-]{1,40}$/.test(id)) return badRequest('팁 id 형식이 아니에요.');
  const error = getOrderStore().dismissTip(id);
  return error ? errorResponse(error) : new Response(null, { status: 204 });
}
