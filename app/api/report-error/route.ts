import { NextRequest, NextResponse } from 'next/server';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const errorData = await request.json();

    if (!errorData || !errorData.message) {
      return NextResponse.json(
        { error: 'Missing error data' },
        { status: 400, headers: corsHeaders }
      );
    }

    const eventType: string = errorData.eventType || 'error';
    const isSuccess = eventType === 'order-submitted-success';
    const isOrderSubmit = eventType.startsWith('order-submitted');
    const isSlowLoad = eventType === 'slow-load';
    const isSlowPageLoad = eventType === 'slow-page-load';
    const isHeartbeat = eventType === 'heartbeat';

    // heartbeat은 이메일 X — 로그만 (서버 트레일 확보용, 페이지 진입 자체 여부 확인 가능)
    if (isHeartbeat) {
      console.log('[B2B HEARTBEAT]', JSON.stringify({
        ts: errorData.timestamp,
        page: errorData.page,
        customer: errorData.customerName || errorData.customerEmail || errorData.customerId,
        tier: errorData.customerTier,
        accountCode: errorData.accountCode,
        nav: errorData.navTimings,
        ua: errorData.userAgent,
        url: errorData.pageUrl,
      }));
      return NextResponse.json(
        { success: true, logged: true, emailed: false },
        { headers: corsHeaders }
      );
    }

    console.log('=== B2B REPORT ===', eventType);
    console.log(JSON.stringify(errorData, null, 2));

    const notifyEmail = process.env.ERROR_NOTIFY_EMAIL;
    let emailSent = false;

    if (notifyEmail && process.env.RESEND_API_KEY) {
      emailSent = await sendViaResend(notifyEmail, errorData, {
        isSuccess,
        isOrderSubmit,
        isSlowLoad,
        isSlowPageLoad,
      });
    }

    return NextResponse.json(
      { success: true, logged: true, emailed: emailSent },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error('Error in report-error handler:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}

type RenderOpts = {
  isSuccess: boolean;
  isOrderSubmit: boolean;
  isSlowLoad: boolean;
  isSlowPageLoad: boolean;
};

async function sendViaResend(to: string, data: any, opts: RenderOpts) {
  try {
    const { isSuccess, isOrderSubmit, isSlowLoad, isSlowPageLoad } = opts;

    const subjectPrefix = isSuccess
      ? '[B2B Order Placed]'
      : isOrderSubmit
        ? '[B2B Order Failed]'
        : isSlowLoad
          ? '[B2B Slow API]'
          : isSlowPageLoad
            ? '[B2B Slow Page]'
            : '[B2B Error]';

    const slowPageSecs = isSlowPageLoad && data.navTimings && data.navTimings.loadEventEndMs
      ? (data.navTimings.loadEventEndMs / 1000).toFixed(1)
      : '?';

    const subjectTail = isOrderSubmit
      ? (data.orderName || data.customerName || 'Unknown')
      : isSlowLoad
        ? `${data.page || 'Unknown'} - ${(data.durationMs / 1000).toFixed(1)}s (${data.customerName || 'Unknown user'})`
        : isSlowPageLoad
          ? `${data.page || 'Unknown'} - ${slowPageSecs}s (${data.customerName || 'Unknown user'})`
          : `${data.page || 'Unknown'} - ${data.step || 'Unknown'} (${data.customerName || 'Unknown user'})`;

    const subject = `${subjectPrefix} ${subjectTail}`;

    const html = buildEmailHtml(data, opts);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'B2B Alerts <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Resend error:', errText);
    }
    return response.ok;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
}

function buildEmailHtml(data: any, opts: RenderOpts) {
  const { isSuccess, isOrderSubmit, isSlowLoad, isSlowPageLoad } = opts;
  const time = data.timestamp || new Date().toISOString();

  const headerBg = isSuccess
    ? '#2e7d32'
    : (isSlowLoad || isSlowPageLoad)
      ? '#ed6c02'
      : '#d32f2f';

  const slowPageSecs = isSlowPageLoad && data.navTimings && data.navTimings.loadEventEndMs
    ? (data.navTimings.loadEventEndMs / 1000).toFixed(1)
    : '?';

  const headerTitle = isSuccess
    ? 'B2B Order Placed'
    : isOrderSubmit
      ? 'B2B Order Failed (cart preserved below)'
      : isSlowLoad
        ? `B2B Slow API (${(data.durationMs / 1000).toFixed(1)}s)`
        : isSlowPageLoad
          ? `B2B Slow Page Load (${slowPageSecs}s)`
          : 'B2B Order Error Alert';

  const orderRow = isOrderSubmit && (data.orderId || data.orderName)
    ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Order #</td>
          <td style="padding:8px;border-bottom:1px solid #eee;">${data.orderName || ''} ${data.orderId ? '(' + data.orderId + ')' : ''}</td></tr>`
    : '';

  const navTimingRow = (isSlowPageLoad && data.navTimings)
    ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Navigation Timing</td>
          <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;">
            response: ${data.navTimings.responseStartMs ?? '-'}ms,
            interactive: ${data.navTimings.domInteractiveMs ?? '-'}ms,
            DOMContentLoaded: ${data.navTimings.domContentLoadedMs ?? '-'}ms,
            load: ${data.navTimings.loadEventEndMs ?? '-'}ms
          </td></tr>`
    : '';

  const cs = data.cartSummary;
  const formatPrice = (cents: number | null | undefined, currency: string | null | undefined) => {
    if (cents == null) return '';
    const amt = (cents / 100).toFixed(2);
    return currency ? `${amt} ${currency}` : amt;
  };
  const formatOptions = (optsArr: any) => {
    if (!Array.isArray(optsArr) || optsArr.length === 0) return '';
    return optsArr.map((o: any) => `${o.name || ''}: ${o.value || ''}`).join(' / ');
  };
  const formatAddress = (a: any) => {
    if (!a || typeof a !== 'object') return '';
    return [a.name, a.company, a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone]
      .filter(Boolean)
      .join(', ');
  };

  const lineItemRows = cs && Array.isArray(cs.items)
    ? cs.items
        .map((i: any) => {
          const optStr = formatOptions(i.options);
          const sku = i.sku
            ? `<code style="background:#f5f5f5;padding:1px 4px;">${i.sku}</code>`
            : '<span style="color:#aaa;">no SKU</span>';
          const price = i.custom_unit_price != null
            ? `${i.custom_unit_price} ${cs.currency || ''}`
            : formatPrice(i.unit_price_cents, cs.currency);
          const lineTotal = formatPrice(i.line_total_cents, cs.currency);
          return `
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:6px 8px;font-size:12px;">${i.title || ''}${i.variant_title ? `<br><small style="color:#666;">${i.variant_title}</small>` : ''}${optStr ? `<br><small style="color:#888;">${optStr}</small>` : ''}</td>
              <td style="padding:6px 8px;font-size:12px;">${sku}</td>
              <td style="padding:6px 8px;font-size:12px;text-align:right;">${i.qty}</td>
              <td style="padding:6px 8px;font-size:12px;text-align:right;">${price || '-'}</td>
              <td style="padding:6px 8px;font-size:12px;text-align:right;">${lineTotal || '-'}</td>
            </tr>`;
        })
        .join('')
    : '';

  const cartInfo = cs
    ? `
      <tr><td colspan="2" style="padding:12px 8px 4px;font-weight:bold;font-size:14px;color:#1565c0;">Cart Contents (${cs.itemCount} items, ${cs.totalQuantity} qty${cs.customerTier ? ', tier: ' + cs.customerTier : ''}${cs.accountCode ? ', acct: ' + cs.accountCode : ''})</td></tr>
      <tr><td colspan="2" style="padding:0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
          <thead>
            <tr style="background:#f5f5f5;font-size:11px;">
              <th style="padding:6px 8px;text-align:left;">Product</th>
              <th style="padding:6px 8px;text-align:left;">SKU</th>
              <th style="padding:6px 8px;text-align:right;">Qty</th>
              <th style="padding:6px 8px;text-align:right;">Unit</th>
              <th style="padding:6px 8px;text-align:right;">Line</th>
            </tr>
          </thead>
          <tbody>${lineItemRows}</tbody>
        </table>
      </td></tr>
      ${cs.shippingAddress ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Ship To</td><td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;">${formatAddress(cs.shippingAddress)}</td></tr>` : ''}
      ${cs.billingAddress ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Bill To</td><td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;">${formatAddress(cs.billingAddress)}</td></tr>` : ''}`
    : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">
      <div style="background:${headerBg};color:white;padding:20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">${headerTitle}</h2>
        <p style="margin:5px 0 0;opacity:0.9;">${time}</p>
      </div>
      <div style="border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;padding:20px;">
        <table style="width:100%;border-collapse:collapse;">
          ${orderRow}
          ${navTimingRow}
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;width:140px;">Page</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.page || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Step</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.step || '-'}</td></tr>
          <tr style="background:#fff3f3;"><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Message</td>
              <td style="padding:8px;border-bottom:1px solid #eee;color:${headerBg};">${data.message || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Type</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.type || '-'}</td></tr>
          ${data.status ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">HTTP Status</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.status}</td></tr>` : ''}
          ${data.apiUrl ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">API URL</td>
              <td style="padding:8px;border-bottom:1px solid #eee;word-break:break-all;font-size:11px;">${data.apiUrl}</td></tr>` : ''}

          <tr><td colspan="2" style="padding:12px 8px 4px;font-weight:bold;color:#1565c0;">Customer</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Name</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.customerName || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Email</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.customerEmail || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Tier</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.customerTier || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Account</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.accountCode || '-'}</td></tr>
          ${data.isAgencyOrder ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Agency Store</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.agencyStore || '-'}</td></tr>` : ''}

          ${cartInfo}

          <tr><td colspan="2" style="padding:12px 8px 4px;font-weight:bold;color:#666;">Environment</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">URL</td>
              <td style="padding:8px;border-bottom:1px solid #eee;word-break:break-all;font-size:11px;">${data.pageUrl || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Browser</td>
              <td style="padding:8px;border-bottom:1px solid #eee;font-size:11px;">${data.userAgent || '-'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Screen</td>
              <td style="padding:8px;border-bottom:1px solid #eee;">${data.screenSize || '-'}</td></tr>
        </table>
      </div>
    </div>
  `;
}
