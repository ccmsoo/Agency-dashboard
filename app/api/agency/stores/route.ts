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

    // ★ 메타필드 필터로 해당 에이전시 소속 고객만 조회 (성능 대폭 개선)
    // 기존: 전체 고객 조회 후 JS에서 필터 → 고객 3000명이면 API 30회 호출
    // 변경: GraphQL query 필터로 서버에서 바로 필터 → API 1~2회
    let allCustomers: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const query = `
        query GetAgencyStores($cursor: String, $agencyFilter: String!) {
          customers(first: 100, after: $cursor, query: $agencyFilter) {
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
                orders(first: 5, sortKey: CREATED_AT, reverse: true) {
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

      const variables = {
        cursor,
        agencyFilter: `metafield:custom.belongs_to_agency:${agencyCode}`
      };
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

    // 이미 서버에서 필터링됨 — 매핑만 하면 됨
    const stores = allCustomers
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