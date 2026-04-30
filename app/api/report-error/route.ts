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

    // 콘솔 로그 (Vercel Functions 로그에서 확인 가능)
    console.log('=== B2B ERROR REPORT ===');
    console.log(JSON.stringify(errorData, null, 2));

    // 이메일 전송
    const notifyEmail = process.env.ERROR_NOTIFY_EMAIL;
    let emailSent = false;

    if (notifyEmail && process.env.RESEND_API_KEY) {
      emailSent = await sendViaResend(notifyEmail, errorData);
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

async function sendViaResend(to: string, data: any) {
  try {
    const subject = `[B2B Error] ${data.page || 'Unknown'} - ${data.step || 'Unknown'} (${data.customerName || 'Unknown'})`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#d32f2f;color:white;padding:20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">B2B Order Error Alert</h2>
          <p style="margin:5px 0 0;opacity:0.9;">${data.timestamp || new Date().toISOString()}</p>
        </div>
        <div style="border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px;padding:20px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;width:130px;">Page</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${data.page || '-'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Step</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${data.step || '-'}</td></tr>
            <tr style="background:#fff3f3;"><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Error</td>
                <td style="padding:8px;border-bottom:1px solid #eee;color:#d32f2f;">${data.message || '-'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Type</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${data.type || '-'}</td></tr>
            ${data.status ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">HTTP Status</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${data.status}</td></tr>` : ''}
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
            ${data.cartSummary ? `<tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;vertical-align:top;">Cart</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">
                  <div style="margin-bottom:6px;"><strong>${data.cartSummary.itemCount} items, ${data.cartSummary.totalQuantity} qty total</strong></div>
                  ${(data.cartSummary.items || []).length > 0 ? `
                    <table style="width:100%;border-collapse:collapse;font-size:12px;background:#fafafa;border:1px solid #eee;margin-top:4px;">
                      <thead>
                        <tr style="background:#f0f0f0;">
                          <th style="text-align:left;padding:6px;border-bottom:1px solid #ddd;">Product</th>
                          <th style="text-align:center;padding:6px;border-bottom:1px solid #ddd;width:50px;">Qty</th>
                          <th style="text-align:left;padding:6px;border-bottom:1px solid #ddd;width:90px;">Variant ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${data.cartSummary.items.map((item: any) => `
                          <tr>
                            <td style="padding:6px;border-bottom:1px solid #eee;">${item.title || '-'}</td>
                            <td style="padding:6px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;">${item.qty || 0}</td>
                            <td style="padding:6px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;">${item.variant_id || '-'}</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                    ${data.cartSummary.itemCount > data.cartSummary.items.length ? `<p style="font-size:11px;color:#999;margin:4px 0 0;">(showing first ${data.cartSummary.items.length} of ${data.cartSummary.itemCount} items)</p>` : ''}
                  ` : ''}
                </td></tr>` : ''}
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">URL</td>
                <td style="padding:8px;border-bottom:1px solid #eee;word-break:break-all;font-size:11px;">${data.pageUrl || '-'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #eee;">Browser</td>
                <td style="padding:8px;border-bottom:1px solid #eee;font-size:11px;">${data.userAgent || '-'}</td></tr>
          </table>
        </div>
      </div>
    `;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'B2B Alerts <onboarding@resend.dev>',
        to: [to],
        subject,
        html
      })
    });

    return response.ok;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
}
