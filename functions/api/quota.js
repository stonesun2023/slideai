export async function onRequestGet(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const monthKey = `quota:${clientIP}:${getMonthKey()}`;
    const freeQuota = parseInt(env.FREE_QUOTA || '3');
    const used = parseInt(await env.QUOTA_KV?.get(monthKey) || '0');
    return new Response(JSON.stringify({
      used,
      quota: freeQuota,
      remaining: Math.max(0, freeQuota - used),
      resetDate: getResetDate(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getResetDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d.toLocaleDateString('zh-CN');
}