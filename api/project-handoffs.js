const RESOLVE_PM_HANDOFF_URL = 'https://cap-pm-cockpit-alaria.vercel.app/api/project-handoffs';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// T1.4 — a total upstream failure must never be forwarded as an
// empty-but-valid-looking handoff. These are the fields a successful intake
// session always produces (validateRecommendationShape guarantees 1-3
// top_priorities and doNotYet rows, validateUnderstandingShape guarantees a
// non-empty outcome), so an empty one here means the client-side pipeline
// failed and the handoff must fail loudly, not land as a hollow record.
function findPayloadFault(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'payload is missing';
  }
  if (!payload.project_understanding || typeof payload.project_understanding !== 'object') {
    return 'project_understanding is missing';
  }
  if (!isNonEmptyString(payload.recommended_action)) {
    return 'recommended_action is missing';
  }
  if (!Array.isArray(payload.top_priorities) || payload.top_priorities.length === 0) {
    return 'top_priorities is empty';
  }
  if (!Array.isArray(payload.what_not_to_do) || payload.what_not_to_do.length === 0) {
    return 'what_not_to_do is empty';
  }
  if (!isNonEmptyString(payload.project_plan_report)) {
    return 'project_plan_report is missing';
  }
  if (!isNonEmptyString(payload.outcome)) {
    return 'outcome is missing';
  }
  if (typeof payload.outcome_confirmed !== 'boolean') {
    return 'outcome_confirmed is missing';
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const fault = findPayloadFault(req.body);
  if (fault) {
    console.error(`ResolvePM handoff rejected: ${fault}`);
    return res.status(400).json({
      error: `This session is incomplete and can't be handed to ResolvePM (${fault}). Go back and rebuild your path, then try again.`
    });
  }

  try {
    const upstream = await fetch(RESOLVE_PM_HANDOFF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
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
