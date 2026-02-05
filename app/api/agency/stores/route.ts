import { NextRequest, NextResponse } from 'next/server';
import { shopifyAdminAPI } from '@/app/lib/shopify';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const agencyCode = searchParams.get('agency_code');

    if (!agencyCode) {
      return NextResponse.json(
        { error: 'agency_code is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    // ★ 모든 고객 조회 (pagination)
    let allCustomers: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const query = `
        query GetCustomers($cursor: String) {
          customers(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                displayName
                email
                metafields(first: 10) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
                orders(first: 100) {
                  edges {
                    node {
                      id
                      name
                      createdAt
                      cancelledAt
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const variables = { cursor };
      const data = await shopifyAdminAPI(query, variables);

      allCustomers = [...allCustomers, ...data.customers.edges];
      hasNextPage = data.customers.pageInfo.hasNextPage;
      cursor = data.customers.pageInfo.endCursor;
    }

    // 메타필드 헬퍼 함수
    const getMetafield = (metafields: any[], key: string) => {
      const edge = metafields.find(
        (e: any) => e.node.namespace === 'custom' && e.node.key === key
      );
      return edge?.node?.value || null;
    };

    // ★ agency_code로 필터링 (대소문자 무시 + trim)
    const stores = allCustomers
      .filter((edge: any) => {
        const belongsTo = getMetafield(edge.node.metafields.edges, 'belongs_to_agency');
        if (!belongsTo) return false;
        
        // 대소문자 무시 + 앞뒤 공백 제거
        return belongsTo.trim().toLowerCase() === agencyCode.trim().toLowerCase();
      })
      .map((edge: any) => {
        const customer = edge.node;
        const metafields = customer.metafields.edges;
        
        // 취소되지 않은 주문만 필터링
        const validOrders = customer.orders.edges.filter(
          (o: any) => !o.node.cancelledAt
        );
        
        const lastOrder = validOrders[0]?.node;

        return {
          customer_id: customer.id,
          name: customer.displayName,
          email: customer.email,
          account_code: getMetafield(metafields, 'account_code'),
          belongs_to_agency: getMetafield(metafields, 'belongs_to_agency'),
          is_agency_master: getMetafield(metafields, 'is_agency_master'),
          territory: getMetafield(metafields, 'territory'),
          price_tier: getMetafield(metafields, 'price_tier'),
          order_count: validOrders.length,
          last_order_date: lastOrder?.createdAt || null,
          last_order_name: lastOrder?.name || null,
        };
      });

    return NextResponse.json(
      { stores, total: stores.length },
      { headers: corsHeaders }
    );

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stores' },
      { status: 500, headers: corsHeaders }
    );
  }
}