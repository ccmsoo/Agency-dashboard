import { NextRequest, NextResponse } from 'next/server';
import { shopifyAdminAPI } from '@/app/lib/shopify';
import {
  authenticateProxyRequest,
  canAccessAccountCode,
  type CustomerContext,
} from '@/app/lib/proxyAuth';

export const maxDuration = 15;

/** 취소하려는 주문이 요청자의 것인지 Shopify 에서 직접 확인한다. */
async function canCancelOrder(actor: CustomerContext, orderId: string): Promise<boolean> {
  const numericId = String(orderId).split('/').pop() || '';
  if (!/^\d+$/.test(numericId)) return false;

  const data = await shopifyAdminAPI(
    `query OrderOwner($id: ID!) {
       order(id: $id) {
         id
         customer { id }
         customAttributes { key value }
       }
     }`,
    { id: `gid://shopify/Order/${numericId}` }
  );

  const order = data?.order;
  if (!order) return false;

  const ownerId = String(order.customer?.id || '').split('/').pop() || '';
  if (ownerId && ownerId === actor.id) return true;

  const attrs: { key: string; value: string }[] = order.customAttributes || [];
  const accountCode = attrs.find((a) => a.key === 'Account Code')?.value || '';
  if (!accountCode) return false;

  return canAccessAccountCode(actor, accountCode);
}

const SHOPIFY_API_VERSION = '2024-01';

const ALLOWED_ORIGINS = [
  'https://cpnmmm-wb.myshopify.com',
  'https://amomentowholesale.com',
];

function corsHeadersFor(origin: string | null) {
  const safeOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': safeOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,X-Idempotency-Key,X-Requested-With',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 200, headers: corsHeadersFor(request.headers.get('origin')) });
}

type CancelOrderBody = {
  orderId?: number | string;
  orderName?: string;
  customerId?: number | string;
};

export async function POST(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request.headers.get('origin'));

  // 인증: App Proxy 서명 + 로그인 고객 확인
  // (이전 방식은 ?shop= 값이 "있기만 하면" 통과해서 사실상 인증이 없었음)
  const auth = await authenticateProxyRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status, headers: corsHeaders }
    );
  }

  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
    console.error('Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN');
    return NextResponse.json(
      { success: false, error: 'Server misconfigured' },
      { status: 500, headers: corsHeaders }
    );
  }

  let body: CancelOrderBody;
  try {
    body = (await request.json()) as CancelOrderBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400, headers: corsHeaders }
    );
  }

  const { orderId, orderName, customerId } = body;
  if (!orderId) {
    return NextResponse.json(
      { success: false, error: 'orderId is required' },
      { status: 400, headers: corsHeaders }
    );
  }

  // 소유권 검증: 남의 주문을 취소할 수 없다
  let allowed = false;
  try {
    allowed = await canCancelOrder(auth.customer, String(orderId));
  } catch (error) {
    console.error('Ownership check failed:', error);
    return NextResponse.json(
      { success: false, error: 'Authorization check failed' },
      { status: 503, headers: corsHeaders }
    );
  }
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: 'Forbidden' },
      { status: 403, headers: corsHeaders }
    );
  }

  try {
    console.log(
      `Cancelling order: ${orderName || orderId} requested by customer ${auth.customer.id} (body customerId: ${customerId})`
    );

    const cancelRes = await fetch(
      `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/cancel.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    const cancelText = await cancelRes.text();
    let cancelJson: any = null;
    try { cancelJson = JSON.parse(cancelText); } catch { /* keep raw text */ }

    if (!cancelRes.ok) {
      console.error('Shopify order cancel failed:', cancelRes.status, cancelText);
      const errorMessage = cancelJson?.errors
        ? (typeof cancelJson.errors === 'string' ? cancelJson.errors : JSON.stringify(cancelJson.errors))
        : cancelText || `HTTP ${cancelRes.status}`;
      return NextResponse.json(
        { success: false, error: errorMessage },
        { status: cancelRes.status || 500, headers: corsHeaders }
      );
    }

    const order = cancelJson?.order;
    console.log(`Order ${orderName || orderId} cancelled successfully`);

    return NextResponse.json(
      {
        success: true,
        order: {
          id: order?.id,
          name: order?.name,
          cancelled_at: order?.cancelled_at,
        },
      },
      { headers: corsHeaders }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('cancel-order handler error:', message);
    return NextResponse.json(
      { success: false, error: message || 'Order cancellation failed' },
      { status: 500, headers: corsHeaders }
    );
  }
}
