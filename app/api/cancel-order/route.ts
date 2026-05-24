import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 15;

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

  const apiKey = request.headers.get('x-api-key');
  const url = new URL(request.url);
  const shopifyShop = url.searchParams.get('shop') || request.headers.get('x-shopify-shop-domain');

  const validApiKey = apiKey && apiKey === process.env.API_SECRET_KEY;
  if (!validApiKey && !shopifyShop) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: corsHeaders }
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

  try {
    console.log(`Cancelling order: ${orderName || orderId} for customer: ${customerId}`);

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
