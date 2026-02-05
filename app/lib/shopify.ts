
// Shopify Admin API 호출 유틸리티

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// GraphQL API 호출 함수
export async function shopifyAdminAPI(query: string, variables = {}) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();

  if (data.errors) {
    console.error('Shopify API Error:', data.errors);
    throw new Error(data.errors[0]?.message || 'Shopify API Error');
  }

  return data.data;
}

// REST API 호출 함수 (필요시 사용)
export async function shopifyRestAPI(endpoint: string) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/${endpoint}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN!,
    },
  });

  return response.json();
}