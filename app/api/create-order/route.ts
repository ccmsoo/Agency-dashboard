import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

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

type LineItem = {
  variant_id: number | string;
  quantity: number;
  title?: string;
};

type CreateOrderBody = {
  customerId?: number | string;
  customerEmail?: string;
  customerName?: string;
  accountCode?: string;
  lineItems: LineItem[];
  customerTier?: string;
  actualPrices?: Record<string, number>;
  shippingAddress?: Record<string, unknown>;
};

export async function POST(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request.headers.get('origin'));

  // 인증: App Proxy 서명(shop 파라미터) 또는 API 키 (하위 호환)
  const apiKey = request.headers.get('x-api-key');
  const url = new URL(request.url);
  const shopifyShop = url.searchParams.get('shop') || request.headers.get('x-shopify-shop-domain');

  const validApiKey = apiKey && apiKey === process.env.API_SECRET_KEY;
  if (!validApiKey && !shopifyShop) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized - No valid authentication' },
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

  let body: CreateOrderBody;
  try {
    body = (await request.json()) as CreateOrderBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400, headers: corsHeaders }
    );
  }

  const {
    customerId,
    customerEmail,
    customerName,
    accountCode,
    lineItems,
    customerTier,
    actualPrices,
    shippingAddress,
  } = body;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return NextResponse.json(
      { success: false, error: 'lineItems is required' },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    console.log('Received order request:', JSON.stringify(body, null, 2));

    // 고객 티어에서 통화 추출
    let currency = 'USD';
    if (customerTier) {
      const tierUpper = customerTier.toUpperCase();
      if (tierUpper.includes('EUR')) currency = 'EUR';
      else if (tierUpper.includes('JPY') || tierUpper.includes('YEN')) currency = 'JPY';
      else if (tierUpper.includes('KRW') || tierUpper.includes('WON')) currency = 'KRW';
      else if (tierUpper.includes('GBP')) currency = 'GBP';
      else if (tierUpper.includes('USD')) currency = 'USD';
    }

    const formatPrice = (amount: number, cur: string) => {
      const price = Math.round(amount);
      switch (cur) {
        case 'USD':
          return `$${price.toLocaleString('en-US')}`;
        case 'EUR':
          return `€${price.toLocaleString('de-DE')}`;
        case 'JPY':
          return `¥${price.toLocaleString('ja-JP')}`;
        default:
          return `${price.toLocaleString()} ${cur}`;
      }
    };

    // 주문 노트 생성
    let orderNote = '=== B2B 0원 주문 ===\n';
    orderNote += `고객명: ${customerName || 'N/A'}\n`;
    orderNote += `Account Code: ${accountCode || 'N/A'}\n`;
    orderNote += `고객 이메일: ${customerEmail || ''}\n`;
    orderNote += `고객 티어: ${customerTier || 'Standard'}\n`;
    orderNote += `통화: ${currency}\n`;
    orderNote += `주문 일시: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n\n`;
    orderNote += '실제 청구 내역:\n';

    let actualTotal = 0;
    lineItems.forEach((item) => {
      const price = actualPrices && actualPrices[String(item.variant_id)] != null
        ? actualPrices[String(item.variant_id)]
        : 0;
      const total = price * item.quantity;
      actualTotal += total;
      orderNote += `- ${item.title ?? ''} x ${item.quantity} = ${formatPrice(total, currency)}\n`;
    });

    orderNote += `\n총 청구 예정: ${formatPrice(actualTotal, currency)}`;

    const defaultShipping = {
      first_name: customerName?.split(' ')[0] || '고객',
      last_name: customerName?.split(' ')[1] || '주소',
      address1: '주소 정보 필요',
      city: '서울',
      province: '서울특별시',
      country: 'South Korea',
      zip: '00000',
      phone: '010-0000-0000',
    };

    const orderData = {
      order: {
        customer: customerId ? { id: customerId } : undefined,
        email: customerEmail,
        financial_status: 'pending',
        fulfillment_status: null,
        send_receipt: true,
        send_fulfillment_receipt: true,
        line_items: lineItems.map((item) => ({
          variant_id: item.variant_id,
          quantity: item.quantity,
          price: '0.00',
          requires_shipping: true,
        })),
        shipping_address: shippingAddress || defaultShipping,
        note: orderNote,
        tags: `B2B, Zero-Price, ${customerTier || 'Standard'}, Auto-Created`,
        note_attributes: [
          { name: 'B2B Order', value: 'true' },
          { name: 'Customer Name', value: customerName || 'N/A' },
          { name: 'Account Code', value: accountCode || 'N/A' },
          { name: 'Customer Tier', value: customerTier || 'Standard' },
          { name: 'Currency', value: currency },
          { name: 'Actual Total', value: actualTotal.toString() },
          { name: 'Actual Total Formatted', value: formatPrice(actualTotal, currency) },
          { name: 'Created Via', value: 'B2B API System' },
          { name: 'Created At', value: new Date().toISOString() },
        ],
      },
    };

    console.log('Creating order with payload:', JSON.stringify(orderData, null, 2));

    const createRes = await fetch(
      `https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/orders.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderData),
      }
    );

    const createText = await createRes.text();
    let createJson: any = null;
    try { createJson = JSON.parse(createText); } catch { /* keep raw text */ }

    if (!createRes.ok) {
      console.error('Shopify order create failed:', createRes.status, createText);
      const errorMessage = createJson?.errors
        ? (typeof createJson.errors === 'string' ? createJson.errors : JSON.stringify(createJson.errors))
        : createText || `HTTP ${createRes.status}`;
      return NextResponse.json(
        { success: false, error: errorMessage, details: createJson },
        { status: 500, headers: corsHeaders }
      );
    }

    const order = createJson?.order;
    console.log('Order created successfully:', order?.name);

    // 주문 생성 후 판매량 메타필드 업데이트 (실패해도 주문 자체는 성공으로 응답)
    updateProductSalesCount(lineItems, SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN).catch((err) => {
      console.error('Sales count update failed (non-fatal):', err);
    });

    return NextResponse.json(
      {
        success: true,
        order: {
          id: order.id,
          order_number: order.order_number,
          name: order.name,
          created_at: order.created_at,
          total_price: actualTotal,
          total_price_formatted: formatPrice(actualTotal, currency),
          currency,
        },
      },
      { headers: corsHeaders }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('create-order handler error:', message);
    return NextResponse.json(
      { success: false, error: message || 'Order creation failed' },
      { status: 500, headers: corsHeaders }
    );
  }
}

async function updateProductSalesCount(lineItems: LineItem[], storeUrl: string, token: string) {
  console.log('Updating sales count for products...');

  for (const item of lineItems) {
    try {
      // 1. variant → product id
      const variantRes = await fetch(
        `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/variants/${item.variant_id}.json`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      if (!variantRes.ok) {
        console.error(`variant lookup failed for ${item.variant_id}: ${variantRes.status}`);
        continue;
      }
      const variantJson = await variantRes.json();
      const productId = variantJson?.variant?.product_id;
      if (!productId) continue;

      // 2. 현재 판매량 메타필드 조회
      const metaListUrl = new URL(
        `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}/metafields.json`
      );
      metaListUrl.searchParams.set('namespace', 'custom');
      metaListUrl.searchParams.set('key', 'sales_count');

      const metaListRes = await fetch(metaListUrl.toString(), {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (!metaListRes.ok) {
        console.error(`metafield list failed for product ${productId}: ${metaListRes.status}`);
        continue;
      }
      const metaListJson = await metaListRes.json();
      const existing = (metaListJson?.metafields || [])[0];
      const currentCount = existing ? parseInt(existing.value, 10) || 0 : 0;
      const newCount = currentCount + item.quantity;

      // 3. 업데이트 또는 신규 생성
      if (existing?.id) {
        await fetch(
          `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/metafields/${existing.id}.json`,
          {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              metafield: { value: newCount.toString(), type: 'number_integer' },
            }),
          }
        );
      } else {
        await fetch(
          `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}/metafields.json`,
          {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              metafield: {
                namespace: 'custom',
                key: 'sales_count',
                value: newCount.toString(),
                type: 'number_integer',
              },
            }),
          }
        );
      }

      console.log(`Updated sales count for product ${productId}: ${currentCount} -> ${newCount}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error updating sales count for variant ${item.variant_id}:`, msg);
    }
  }
}
