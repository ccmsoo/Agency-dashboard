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
// 시즌 태그 추출 함수 (fallback용)
// ========================================
function extractSeasonFromTags(tags: string[]): string | null {
  if (!tags || tags.length === 0) return null;
  
  const seasonPatterns = [
    /^(\d{2})(PS|SS|FW|AW|RS)$/i,
    /^(PS|SS|FW|AW|RS)(\d{2})$/i,
    /^(Pre-Spring|Spring|Summer|Fall|Winter|Resort)\s*(\d{2,4})$/i,
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
                        id
                        sku
                        image {
                          url
                        }
                        product {
                          metafield(namespace: "custom", key: "season") {
                            value
                          }
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

    const getMetafield = (key: string) => {
      const edge = data.customer.metafields.edges.find(
        (e: any) => e.node.namespace === 'custom' && e.node.key === key
      );
      return edge?.node?.value || null;
    };

    const priceTier = getMetafield('price_tier') || '';
    
    let currencySymbol = '';
    if (priceTier.includes('USD')) {
      currencySymbol = '$';
    } else if (priceTier.includes('EUR')) {
      currencySymbol = '€';
    } else if (priceTier.includes('JPY')) {
      currencySymbol = '¥';
    }

    const orders = data.customer.orders.edges
      .filter((edge: any) => !edge.node.cancelledAt)
      .map((edge: any) => {
        const order = edge.node;
        const noteTotal = extractTotalFromNote(order.note);
        
        // ★ line_items에서 모든 시즌 수집
        const seasonsSet = new Set<string>();
        
        const lineItems = order.lineItems.edges.map((item: any) => {
          const imageUrl = item.node.image?.url || item.node.variant?.image?.url || null;
          const unitPrice = parseFloat(item.node.originalUnitPriceSet?.shopMoney?.amount || '0');
          
          // variant_id 추출
          let variantId = '';
          if (item.node.variant?.id) {
            const match = item.node.variant.id.match(/ProductVariant\/(\d+)/);
            variantId = match ? match[1] : item.node.variant.id;
          }
          
          // ★ 제품 메타필드에서 시즌 추출
          const season = item.node.variant?.product?.metafield?.value || '';
          
          // 시즌이 있으면 Set에 추가
          if (season) {
            seasonsSet.add(season.toUpperCase());
          }
          
          return {
            title: item.node.title,
            quantity: item.node.quantity,
            sku: item.node.sku || item.node.variant?.sku || '',
            image: imageUrl,
            price: unitPrice,
            variant_id: variantId,
            season: season.toUpperCase() || ''  // ★ 각 아이템에 시즌 추가
          };
        });
        
        // ★ 주문 태그에서도 시즌 추출 (fallback)
        const tagSeason = extractSeasonFromTags(order.tags || []);
        if (tagSeason) {
          seasonsSet.add(tagSeason);
        }
        
        // Set을 배열로 변환
        const seasons = Array.from(seasonsSet);
        
        return {
          id: order.id,
          name: order.name,
          created_at: order.createdAt,
          fulfillment_status: order.displayFulfillmentStatus,
          financial_status: order.displayFinancialStatus,
          tags: order.tags || [],
          season: seasons[0] || null,      // ★ 첫 번째 시즌 (기존 호환)
          seasons: seasons,                 // ★ 모든 시즌 배열 (다중 시즌 지원)
          total: {
            amount: noteTotal ? noteTotal.amount : parseFloat(order.totalPriceSet.shopMoney.amount),
            currencyCode: order.totalPriceSet.shopMoney.currencyCode,
            display: noteTotal ? noteTotal.display : null
          },
          item_count: lineItems.reduce(
            (sum: number, item: any) => sum + item.quantity,
            0
          ),
          line_items: lineItems,
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
