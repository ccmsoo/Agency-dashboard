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

// note에서 Total Amount Due 추출하는 함수
function extractTotalFromNote(note: string | null): { amount: number; display: string } | null {
  if (!note || !note.includes('Total Amount Due:')) {
    return null;
  }
  
  const afterTotal = note.split('Total Amount Due:')[1]?.trim() || '';
  const parts = afterTotal.split(' ');
  
  for (const part of parts) {
    if (part.includes('¥') || part.includes('$') || part.includes('€')) {
      const currencyMatch = part.match(/([¥$€])([\d,]+)/);
      if (currencyMatch) {
        const amount = parseInt(currencyMatch[2].replace(/,/g, ''), 10);
        return {
          amount: amount,
          display: part
        };
      }
    }
  }
  return null;
}

// ========================================
// 시즌 태그 추출 함수
// 패턴: 26PS, 26FW, 25SS, 25FW, SS25, FW25, etc.
// ========================================
function extractSeasonFromTags(tags: string[]): string | null {
  if (!tags || tags.length === 0) return null;
  
  // 시즌 태그 패턴들
  const seasonPatterns = [
    /^(\d{2})(PS|SS|FW|AW|RS)$/i,  // 26PS, 26FW, 25SS
    /^(PS|SS|FW|AW|RS)(\d{2})$/i,  // PS26, FW26, SS25
    /^(Pre-Spring|Spring|Summer|Fall|Winter|Resort)\s*(\d{2,4})$/i,  // Spring 2026
  ];
  
  for (const tag of tags) {
    const trimmedTag = tag.trim();
    for (const pattern of seasonPatterns) {
      if (pattern.test(trimmedTag)) {
        return trimmedTag.toUpperCase();
      }
    }
  }
  
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const customerId = searchParams.get('customer_id');

    if (!customerId) {
      return NextResponse.json(
        { error: 'customer_id is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const query = `
      query GetCustomerOrders($customerId: ID!) {
        customer(id: $customerId) {
          id
          displayName
          metafields(first: 10) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          orders(first: 100, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                cancelledAt
                tags
                displayFulfillmentStatus
                displayFinancialStatus
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      sku
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      image {
                        url
                      }
                      variant {
                        sku
                        image {
                          url
                        }
                      }
                    }
                  }
                }
                note
              }
            }
          }
        }
      }
    `;

    const variables = { customerId };
    const data = await shopifyAdminAPI(query, variables);

    if (!data.customer) {
      return NextResponse.json(
        { error: 'Customer not found' },
        { status: 404, headers: corsHeaders }
      );
    }

    // price_tier에서 통화 추출
    const getMetafield = (key: string) => {
      const edge = data.customer.metafields.edges.find(
        (e: any) => e.node.namespace === 'custom' && e.node.key === key
      );
      return edge?.node?.value || null;
    };

    const priceTier = getMetafield('price_tier') || '';
    
    // price_tier에서 통화 기호 결정
    let currencySymbol = '';
    if (priceTier.includes('USD')) {
      currencySymbol = '$';
    } else if (priceTier.includes('EUR')) {
      currencySymbol = '€';
    } else if (priceTier.includes('JPY')) {
      currencySymbol = '¥';
    }

    // 취소된 주문 제외 + 데이터 매핑
    const orders = data.customer.orders.edges
      .filter((edge: any) => !edge.node.cancelledAt)
      .map((edge: any) => {
        const order = edge.node;
        
        // note에서 실제 금액 추출
        const noteTotal = extractTotalFromNote(order.note);
        
        // 태그에서 시즌 추출
        const season = extractSeasonFromTags(order.tags || []);
        
        return {
          id: order.id,
          name: order.name,
          created_at: order.createdAt,
          fulfillment_status: order.displayFulfillmentStatus,
          financial_status: order.displayFinancialStatus,
          tags: order.tags || [],
          season: season,  // 시즌 필드 추가
          total: {
            amount: noteTotal ? noteTotal.amount : parseFloat(order.totalPriceSet.shopMoney.amount),
            currencyCode: order.totalPriceSet.shopMoney.currencyCode,
            display: noteTotal ? noteTotal.display : null
          },
          item_count: order.lineItems.edges.reduce(
            (sum: number, item: any) => sum + item.node.quantity,
            0
          ),
          line_items: order.lineItems.edges.map((item: any) => {
            // 이미지 URL 우선순위: lineItem.image > variant.image
            const imageUrl = item.node.image?.url || item.node.variant?.image?.url || null;
            
            // 단가
            const unitPrice = parseFloat(item.node.originalUnitPriceSet?.shopMoney?.amount || '0');
            
            return {
              title: item.node.title,
              quantity: item.node.quantity,
              sku: item.node.sku || item.node.variant?.sku || '',
              image: imageUrl,
              price: unitPrice
            };
          }),
          note: order.note,
        };
      });

    return NextResponse.json(
      { 
        customer_name: data.customer.displayName, 
        price_tier: priceTier,
        currency_symbol: currencySymbol,
        orders 
      },
      { headers: corsHeaders }
    );

  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch orders' },
      { status: 500, headers: corsHeaders }
    );
  }
}
