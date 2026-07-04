const RESOLVE_PM_HANDOFF_URL = 'https://cap-pm-cockpit-alaria.vercel.app/api/project-handoffs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const upstream = await fetch(RESOLVE_PM_HANDOFF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });

    const body = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(body);
  } catch (err) {
    console.error('ResolvePM handoff proxy error:', err);
    return res.status(502).json({
      error: 'ResolvePM handoff is unavailable right now. Try again shortly.'
    });
  }
}
