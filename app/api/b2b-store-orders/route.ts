import { NextRequest, NextResponse } from 'next/server';
import { authenticateProxyRequest, canAccessAccountCode } from '@/app/lib/proxyAuth';

export const maxDuration = 30;

// Returns orders for a given store, identified by account_code.
// No shared password / token: the request reaches this route only through
// the Shopify App Proxy (/apps/agency-api/...), which requires a logged-in
// storefront customer. The theme passes the store identity:
//   - individual store account: customer.metafields.custom.account_code
//   - agency master: the selected proxy store's account_code
// GET /api/b2b-store-orders?account_code=XXX[&store_name=YYY][&order_id=ZZZ]

const SHOPIFY_API_VERSION = '2024-01';

const ALLOWED_ORIGINS = [
  'https://cpnmmm-wb.myshopify.com',
  'https://amomentowholesale.com',
];

function corsHeadersFor(origin: string | null) {
  const safeOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': safeOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 200, headers: corsHeadersFor(request.headers.get('origin')) });
}

type StoreIdentity = {
  account_code: string;
  name: string;
};

export async function GET(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request.headers.get('origin'));

  try {
    const params = request.nextUrl.searchParams;
    const accountCode = (params.get('account_code') || '').trim();
    const storeName = (params.get('store_name') || '').trim();
    const requestedOrderId = (params.get('order_id') || '').trim();

    if (!accountCode) {
      return NextResponse.json({ error: 'Missing account_code' }, { status: 400, headers: corsHeaders });
    }

    // 인증: 로그인 고객 본인의 스토어, 또는 에이전시 마스터의 소속 스토어만 조회 가능
    // (store_name 만으로도 조회되던 경로는 상호명 추측만으로 남의 주문을 열 수 있어 제거함)
    const auth = await authenticateProxyRequest(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: corsHeaders });
    }
    if (!(await canAccessAccountCode(auth.customer, accountCode))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders });
    }

    const store: StoreIdentity = { account_code: accountCode, name: storeName };
    const orders = await fetchStoreOrders(store, requestedOrderId);

    if (requestedOrderId) {
      return NextResponse.json(
        { success: true, store, order: orders[0] || null },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json({ success: true, store, orders }, { headers: corsHeaders });
  } catch (error) {
    console.error('[b2b-store-orders]', error);
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500, headers: corsHeaders });
  }
}

async function fetchStoreOrders(store: StoreIdentity, requestedOrderId: string) {
  const domain = process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!domain || !token) {
    throw new Error('Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN');
  }

  const endpoint = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const query = `
    query B2BStoreOrders($cursor: String) {
      orders(first: 250, after: $cursor, reverse: true, query: "status:any") {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            createdAt
            cancelledAt
            displayFulfillmentStatus
            note
            customAttributes { key value }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  image { url }
                  variant {
                    id
                    legacyResourceId
                    title
                    sku
                    selectedOptions { name value }
                    product {
                      id
                      legacyResourceId
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const matched: ReturnType<typeof formatOrder>[] = [];
  let cursor: string | null = null;
  let page = 0;

  do {
    page += 1;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables: { cursor } }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await response.json();
    if (!response.ok || json.errors) {
      throw new Error(json.errors ? JSON.stringify(json.errors) : `Shopify API ${response.status}`);
    }

    const connection = json.data.orders;
    for (const edge of connection.edges || []) {
      const order = edge.node;
      if (order.cancelledAt) continue;
      if (requestedOrderId && extractNumericOrderId(order.id) !== requestedOrderId) continue;
      if (!matchesStore(order, store)) continue;
      matched.push(formatOrder(order));
    }

    if (requestedOrderId && matched.length > 0) break;
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor && page < 4);

  return matched;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function matchesStore(order: any, store: StoreIdentity) {
  const attrs = Array.isArray(order.customAttributes) ? order.customAttributes : [];
  const accountCode = attrs.find((attr: any) => attr.key === 'Account Code')?.value;
  const customerName = attrs.find((attr: any) => attr.key === 'Customer Name')?.value;

  return (
    (store.account_code && accountCode === store.account_code) ||
    (store.name && customerName === store.name)
  );
}

function formatOrder(order: any) {
  const attrs = Array.isArray(order.customAttributes) ? order.customAttributes : [];
  const totalItems = (order.lineItems?.edges || []).reduce((sum: number, edge: any) => {
    return sum + (edge.node?.quantity || 0);
  }, 0);

  return {
    id: extractNumericOrderId(order.id),
    admin_graphql_id: order.id,
    name: order.name,
    created_at: order.createdAt,
    fulfillment_status: order.displayFulfillmentStatus || 'Confirmed',
    total_items: totalItems,
    note: order.note || '',
    note_attributes: attrs.map((attr: any) => ({ name: attr.key, value: attr.value })),
    line_items: (order.lineItems?.edges || []).map((edge: any) => {
      const item = edge.node || {};
      const variant = item.variant || {};
      const product = variant.product || {};
      const options = Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [];
      return {
        title: item.title || product.title || '',
        product_title: product.title || item.title || '',
        quantity: item.quantity || 0,
        sku: item.sku || variant.sku || '',
        variant_id: variant.legacyResourceId || '',
        product_id: product.legacyResourceId || '',
        price: Math.round(Number(item.originalUnitPriceSet?.shopMoney?.amount || 0) * 100),
        currency: item.originalUnitPriceSet?.shopMoney?.currencyCode || '',
        image: item.image?.url || '',
        color: options[0]?.value || 'Default',
        size: options[1]?.value || options[0]?.value || 'One Size',
      };
    }),
  };
}

function extractNumericOrderId(id: unknown) {
  const match = String(id || '').match(/Order\/(\d+)$/);
  return match ? match[1] : String(id || '');
}
