import crypto from 'crypto';
import { shopifyAdminAPI } from '@/app/lib/shopify';

/**
 * Shopify App Proxy 인증 + 소유권 검증.
 *
 * 왜 필요한가:
 *  - App Proxy 는 "로그인한 고객만 통과시키는 장치"가 아니다. 비로그인 방문자의 요청도
 *    그대로 포워딩하면서 shop / timestamp / signature 를 붙인다.
 *  - 게다가 Vercel 배포 URL 은 인터넷에 직접 노출되어 있어서, 프록시를 건너뛴 직접 호출이 가능하다.
 *  → 따라서 (1) 요청이 진짜 우리 프록시를 거쳤는지(signature), (2) 실제 로그인 고객인지
 *    (logged_in_customer_id), (3) 그 고객이 요청한 데이터의 주인인지(소유권) 를 모두 확인해야 한다.
 */

const APP_SECRET = process.env.SHOPIFY_APP_SECRET || '';
const MAX_SIGNATURE_AGE_SECONDS = 300;

export interface CustomerContext {
  id: string;
  gid: string;
  email: string;
  name: string;
  accountCode: string;
  agencyCode: string;
  belongsToAgency: string;
  priceTier: string;
  isAgencyMaster: boolean;
}

export type AuthResult =
  | { ok: true; customer: CustomerContext }
  | { ok: false; status: number; error: string };

/** App Proxy 서명 검증 (Shopify 문서: signature 제외 파라미터를 key 정렬 후 "k=v" 연결, HMAC-SHA256) */
export function verifyProxySignature(url: URL): { ok: boolean; reason?: string } {
  if (!APP_SECRET) return { ok: false, reason: 'app_secret_not_configured' };

  const params = new URLSearchParams(url.search);
  const signature = params.get('signature');
  if (!signature) return { ok: false, reason: 'missing_signature' };
  params.delete('signature');

  const grouped = new Map<string, string[]>();
  for (const [key, value] of params.entries()) {
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(value);
  }

  const message = [...grouped.keys()]
    .sort()
    .map((key) => `${key}=${grouped.get(key)!.join(',')}`)
    .join('');

  const digest = crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
  const expected = Buffer.from(digest, 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // 재전송(replay) 방지
  const timestamp = Number(params.get('timestamp'));
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  return { ok: true };
}

const CUSTOMER_QUERY = `
  query ProxyCustomer($id: ID!) {
    customer(id: $id) {
      id
      displayName
      email
      metafields(first: 20, namespace: "custom") {
        edges { node { key value } }
      }
    }
  }
`;

function toContext(node: {
  id: string;
  displayName?: string | null;
  email?: string | null;
  metafields?: { edges?: { node: { key: string; value: string } }[] } | null;
}): CustomerContext {
  const meta: Record<string, string> = {};
  for (const edge of node.metafields?.edges || []) {
    meta[edge.node.key] = edge.node.value;
  }
  const rawMaster = (meta.is_agency_master || '').toLowerCase();
  return {
    id: String(node.id).split('/').pop() || '',
    gid: node.id,
    email: node.email || '',
    name: node.displayName || '',
    accountCode: meta.account_code || '',
    agencyCode: meta.agency_code || '',
    belongsToAgency: meta.belongs_to_agency || '',
    priceTier: meta.price_tier || '',
    isAgencyMaster: rawMaster === 'true' || rawMaster === '1',
  };
}

export async function loadCustomerContext(customerId: string): Promise<CustomerContext | null> {
  if (!/^\d+$/.test(customerId)) return null;
  const data = await shopifyAdminAPI(CUSTOMER_QUERY, {
    id: `gid://shopify/Customer/${customerId}`,
  });
  if (!data?.customer) return null;
  return toContext(data.customer);
}

/**
 * 모든 App Proxy 라우트의 공통 진입 검증.
 * SHOPIFY_APP_SECRET 이 설정되어 있으면 서명까지 강제한다(권장).
 * 설정 전에도 logged_in_customer_id + 소유권 검증은 항상 적용된다.
 */
export async function authenticateProxyRequest(request: Request): Promise<AuthResult> {
  const url = new URL(request.url);

  if (APP_SECRET) {
    const sig = verifyProxySignature(url);
    if (!sig.ok) {
      return { ok: false, status: 401, error: `Invalid app proxy request (${sig.reason})` };
    }
  } else {
    console.warn(
      '[proxyAuth] SHOPIFY_APP_SECRET is not set — app proxy signature verification is DISABLED. ' +
        'Direct calls to the Vercel URL can still forge logged_in_customer_id.'
    );
  }

  const rawCustomerId = url.searchParams.get('logged_in_customer_id') || '';
  if (!/^\d+$/.test(rawCustomerId)) {
    return { ok: false, status: 401, error: 'Login required' };
  }

  let customer: CustomerContext | null = null;
  try {
    customer = await loadCustomerContext(rawCustomerId);
  } catch (error) {
    console.error('[proxyAuth] failed to load customer', error);
    return { ok: false, status: 503, error: 'Authentication backend unavailable' };
  }

  if (!customer) {
    return { ok: false, status: 401, error: 'Unknown customer' };
  }

  return { ok: true, customer };
}

/** 에이전시 마스터가 해당 account_code 의 스토어를 대리할 수 있는지 Shopify 에서 직접 확인 */
async function agencyOwnsAccountCode(agencyCode: string, accountCode: string): Promise<boolean> {
  if (!agencyCode || !accountCode) return false;
  const data = await shopifyAdminAPI(
    `query AgencyOwnsStore($q: String!) {
       customers(first: 5, query: $q) {
         edges { node { id metafields(first: 20, namespace: "custom") { edges { node { key value } } } } }
       }
     }`,
    { q: `metafield:custom.belongs_to_agency:${agencyCode} AND metafield:custom.account_code:${accountCode}` }
  );
  const edges = data?.customers?.edges || [];
  return edges.some((edge: { node: Parameters<typeof toContext>[0] }) => {
    const ctx = toContext(edge.node);
    return ctx.accountCode === accountCode && ctx.belongsToAgency === agencyCode;
  });
}

/** account_code 로 식별되는 스토어 데이터에 접근할 권한이 있는가 */
export async function canAccessAccountCode(
  actor: CustomerContext,
  accountCode: string
): Promise<boolean> {
  if (!accountCode) return false;
  if (actor.accountCode && actor.accountCode === accountCode) return true;
  if (actor.isAgencyMaster && actor.agencyCode) {
    return agencyOwnsAccountCode(actor.agencyCode, accountCode);
  }
  return false;
}

/** 특정 customer_id 의 데이터에 접근할 권한이 있는가 */
export async function canAccessCustomerId(
  actor: CustomerContext,
  targetCustomerId: string
): Promise<boolean> {
  const target = String(targetCustomerId).split('/').pop() || '';
  if (!/^\d+$/.test(target)) return false;
  if (target === actor.id) return true;
  if (!actor.isAgencyMaster || !actor.agencyCode) return false;

  const targetCtx = await loadCustomerContext(target);
  return !!targetCtx && targetCtx.belongsToAgency === actor.agencyCode;
}

/** agency_code 단위 조회 권한이 있는가 (에이전시 마스터 본인 코드만) */
export function canAccessAgencyCode(actor: CustomerContext, agencyCode: string): boolean {
  if (!agencyCode) return false;
  return actor.isAgencyMaster && actor.agencyCode === agencyCode;
}

export function authFailureResponse(
  result: Extract<AuthResult, { ok: false }>,
  headers: Record<string, string>
) {
  return Response.json({ error: result.error }, { status: result.status, headers });
}
