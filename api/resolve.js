// /api/resolve.js
// Vercel serverless function. Holds the OpenAI API key server-side.
// Implements a 3-call pipeline grounded in the actual ResolveOS role/governance files:
//   Call 1: Business Analyst   -> understanding extraction (S1 -> S2)
//   Call 2: Strategic Product Director -> recommendation + roadmap (S2 -> S3)
//   Call 3: QA self-check      -> validates Call 2 against Call 1, regenerates if it invents facts

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { stage, projectInput, confirmedUnderstanding, gapAnswers } = req.body;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfigured: missing API key' });
  }

  try {
    if (stage === 'understand') {
      const result = await runUnderstandingCall(projectInput, apiKey);
      return res.status(200).json(result);
    }

    if (stage === 'recommend') {
      const draft = await runRecommendationCall(confirmedUnderstanding, gapAnswers, apiKey);
      const checked = await runQACheckCall(confirmedUnderstanding, gapAnswers, draft, apiKey);
      return res.status(200).json(checked);
    }

    return res.status(400).json({ error: 'Unknown stage' });
  } catch (err) {
    console.error('Resolve API error:', err);
    const isShapeError = err.name === 'ResolveShapeError';
    return res.status(isShapeError ? 502 : 500).json({
      error: isShapeError
        ? "Resolve's response didn't come back in the right shape. This is usually temporary — try again."
        : 'Resolve could not process this right now. Try again, or simplify your input.',
      detail: process.env.NODE_ENV === 'development' ? String(err) : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// SCHEMA VALIDATION
// Guards against malformed/incomplete JSON from the model before it ever
// reaches the frontend. If a call fails validation, it retries once with a
// stricter instruction before giving up and surfacing a clear error.
// ---------------------------------------------------------------------------
class ResolveShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolveShapeError';
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateUnderstandingShape(data) {
  const required = ['project', 'goal', 'state', 'uncertainty', 'gapQuestions', 'assumptions'];
  for (const key of required) {
    if (!(key in data)) {
      throw new ResolveShapeError(`Understanding response missing required field: ${key}`);
    }
  }
  for (const key of ['project', 'goal', 'state', 'uncertainty']) {
    if (!isNonEmptyString(data[key])) {
      throw new ResolveShapeError(`Understanding field "${key}" is empty or not a string`);
    }
  }
  if (!Array.isArray(data.gapQuestions) || data.gapQuestions.length < 1) {
    throw new ResolveShapeError('Understanding field "gapQuestions" must be a non-empty array');
  }
  if (!data.gapQuestions.every(isNonEmptyString)) {
    throw new ResolveShapeError('Understanding field "gapQuestions" contains an empty or non-string entry');
  }
  if (!Array.isArray(data.assumptions)) {
    throw new ResolveShapeError('Understanding field "assumptions" must be an array');
  }
  if (data.assumptions.length > 0 && !data.assumptions.every(isNonEmptyString)) {
    throw new ResolveShapeError('Understanding field "assumptions" contains an empty or non-string entry');
  }
  // Pad gapQuestions to 2 if the model only gave 1, so the frontend's two
  // fixed gap-question slots always have content rather than breaking.
  while (data.gapQuestions.length < 2) {
    data.gapQuestions.push('Is there anything else about this project Resolve should know?');
  }
  return data;
}

function validateRecommendationShape(data) {
  const required = ['recommendedAction', 'why', 'milestone', 'roadmap', 'openDecision'];
  for (const key of required) {
    if (!(key in data)) {
      throw new ResolveShapeError(`Recommendation response missing required field: ${key}`);
    }
  }
  for (const key of ['recommendedAction', 'why', 'milestone', 'openDecision']) {
    if (!isNonEmptyString(data[key])) {
      throw new ResolveShapeError(`Recommendation field "${key}" is empty or not a string`);
    }
  }
  if (!Array.isArray(data.roadmap) || data.roadmap.length < 3) {
    throw new ResolveShapeError('Recommendation field "roadmap" must be an array of at least 3 phases');
  }
  data.roadmap.slice(0, 3).forEach((phase, i) => {
    if (!phase || typeof phase !== 'object') {
      throw new ResolveShapeError(`Roadmap phase ${i} is not an object`);
    }
    for (const key of ['phase', 'action', 'output']) {
      if (!isNonEmptyString(phase[key])) {
        throw new ResolveShapeError(`Roadmap phase ${i} missing or empty field: ${key}`);
      }
    }
  });
  return data;
}

// Calls OpenAI, parses JSON, validates shape. Retries once with a stricter
// instruction if the first attempt fails parsing or validation.
async function callWithValidation(buildPrompt, apiKey, validateFn, attempt = 1) {
  const systemPrompt = buildPrompt(attempt > 1);
  const raw = await callOpenAI(systemPrompt, apiKey, { jsonMode: true });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (attempt >= 2) {
      throw new ResolveShapeError(`Response was not valid JSON after retry: ${e.message}`);
    }
    return callWithValidation(buildPrompt, apiKey, validateFn, attempt + 1);
  }

  try {
    return validateFn(parsed);
  } catch (e) {
    if (attempt >= 2) {
      throw e;
    }
    return callWithValidation(buildPrompt, apiKey, validateFn, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// CALL 1 — Business Analyst: understanding extraction
// Grounded in: 02-roles/business-analyst.md
// Core rules preserved verbatim from that file:
//   "Do not invent missing requirements. Do not guess missing acceptance criteria.
//    Do not infer stakeholder intent, priority, severity, data fields, business
//    rules, or workflow decisions when source context does not support them."
//   "Document assumptions explicitly rather than letting them become invisible
//    implementation constraints."
//   "If the source ticket, comments, feedback, or context needed to validate a
//    requirement is missing, stop or proceed only with an explicit limitation.
//    Do not infer missing project facts from memory."
// ---------------------------------------------------------------------------
async function runUnderstandingCall(projectInput, apiKey) {
  const buildPrompt = (isRetry) => `You are operating as the ResolveOS Business Analyst role.

Your job is requirements clarity: clarifying unclear input, identifying missing information, documenting assumptions explicitly, and reducing ambiguity — applied here to a messy project description instead of a formal requirement.

CORE RULES (do not violate these):
- Do not invent missing facts. Do not guess details the user did not provide.
- Do not infer intent, priority, urgency, or business rules the input does not support.
- Document assumptions explicitly rather than letting them become invisible. Every assumption you make must be labelled as an assumption, not stated as fact.
- If something genuinely needed to understand the project is missing, surface it as a question rather than filling it in yourself.
- Separate what is stated, what is implied, and what is assumed. Do not blur these together.
- Keep output concise and practical. No filler, no generic encouragement, no hype.

THE USER'S PROJECT (raw, unstructured input — may be messy, incomplete, or informal):
"""
${projectInput}
"""

TASK:
Produce a structured understanding of this project. Return ONLY valid JSON matching this EXACT shape — all six fields are REQUIRED, none may be omitted or empty, with no markdown fences, no commentary outside the JSON:

{
  "project": "one or two sentences naming what the project actually is, based only on what was stated",
  "goal": "what the user appears to be trying to achieve, based only on what was stated or clearly implied",
  "state": "where the project currently stands, based only on what was stated",
  "uncertainty": "the single biggest open question or unknown that the input does not resolve",
  "gapQuestions": [
    "one specific, useful question whose answer would materially change the recommendation",
    "a second specific, useful question whose answer would materially change the recommendation"
  ],
  "assumptions": [
    "an assumption you are making to proceed, stated plainly as an assumption, not as fact"
  ]
}

REQUIRED: "project", "goal", "state", and "uncertainty" must each be a non-empty string — if the input is too sparse for genuine confidence, write something like "Not enough detail provided to determine this" rather than leaving it blank or omitting the field. "gapQuestions" must contain at least 2 non-empty strings. "assumptions" must be an array (it may be empty only if truly no assumptions were needed).${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or had empty/missing fields. Follow the shape precisely this time — every field listed above must be present and non-empty (except assumptions, which may be an empty array).' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateUnderstandingShape);
}

// ---------------------------------------------------------------------------
// CALL 2 — Strategic Product Director: recommendation + roadmap
// Grounded in: 02-roles/strategic-product-director.md
// Core rules preserved verbatim from that file:
//   "Challenge weak assumptions directly... Prefer evidence over invention...
//    Do not invent market facts, user needs, business value, strategic priority,
//    or product direction when source context does not support them."
//   "Outcome before output. Evaluate work by user outcome, strategic value,
//    product coherence... not by activity volume."
//   "Define why and what... clear enough that [other roles] can act without
//    inventing strategic intent."
// ---------------------------------------------------------------------------
async function runRecommendationCall(confirmedUnderstanding, gapAnswers, apiKey) {
  const buildPrompt = (isRetry) => `You are operating as the ResolveOS Strategic Product Director role.

Your job is strategic judgement: deciding what matters most right now, challenging weak thinking, and giving ONE clear, opinionated recommendation with reasoning — not a menu of options.

CORE RULES (do not violate these):
- Prefer evidence over invention. Do not invent market facts, business value, or strategic priority that the input does not support.
- Evaluate by outcome, not activity. Do not recommend "more work" as a substitute for "the right work."
- Define why and what, clearly enough that someone else could act on it without having to guess your reasoning.
- Challenge weak assumptions directly if you see them in the confirmed understanding below — but do so within your output, not by refusing to answer.
- Give exactly ONE recommended next action. Do not hedge with multiple equally-weighted options.
- Be direct, practical, and free of generic startup hype ("game-changing," "unlock your potential," etc).

CONFIRMED PROJECT UNDERSTANDING (already reviewed and corrected by the user):
"""
${JSON.stringify(confirmedUnderstanding, null, 2)}
"""

ADDITIONAL CONTEXT FROM THE USER:
What would make this session a success: "${gapAnswers?.successDefinition || 'not provided'}"
Deadline or pressure: "${gapAnswers?.deadline || 'not provided'}"

TASK:
Produce ONE clear recommendation and a short roadmap. Return ONLY valid JSON matching this EXACT shape — all fields are REQUIRED, none may be omitted or empty, with no markdown fences, no commentary outside the JSON:

{
  "recommendedAction": "one clear, specific sentence describing the single most important thing to do next",
  "why": "2-3 sentences explaining why this is the right move now, grounded in the confirmed understanding above — not generic advice",
  "milestone": "what 'done' looks like for this recommended action — specific and observable",
  "roadmap": [
    {"phase": "Now", "action": "short phrase", "output": "what this phase produces"},
    {"phase": "Define", "action": "short phrase", "output": "what this phase produces"},
    {"phase": "Launch", "action": "short phrase", "output": "what this phase produces"}
  ],
  "openDecision": "one specific decision the user still needs to make, framed as a direct question, grounded in the confirmed understanding"
}

REQUIRED: "recommendedAction", "why", "milestone", and "openDecision" must each be a non-empty string. "roadmap" MUST contain exactly 3 phase objects, each with non-empty "phase", "action", and "output" string fields. Do not omit any field or leave any value empty.

If the deadline or success definition were not provided, do not invent urgency or goals that weren't stated — work from what's actually known.${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or had empty/missing fields, especially in the roadmap array. Every roadmap phase must have all three fields filled in. Follow the shape precisely this time.' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateRecommendationShape);
}

// ---------------------------------------------------------------------------
// CALL 3 — QA self-check
// Grounded in: 06-governance/project-readiness.md (Validation State Model)
//   "Evidence: a source-backed observation... that supports or weakens an
//    assumption." / "Do not hide uncertainty about readiness."
// And the cross-role anti-pattern repeated in every role file:
//   "approve fake functionality, fake workflow states, fake data, or fake
//    certainty" — applied here to catch the recommendation overreaching
//    beyond what the confirmed understanding actually supports.
// ---------------------------------------------------------------------------
async function runQACheckCall(confirmedUnderstanding, gapAnswers, draftRecommendation, apiKey) {
  const buildPrompt = (isRetry) => `You are operating as a ResolveOS QA self-check pass.

Your job is to check a draft recommendation against the original confirmed understanding it was supposed to be based on, and catch any case where the recommendation states something as fact that was not actually established.

CORE RULE: Do not approve fake certainty. If the draft recommendation asserts something the confirmed understanding does not support, flag and correct it. If the draft is well-grounded, pass it through unchanged.

CONFIRMED UNDERSTANDING (the source of truth):
"""
${JSON.stringify(confirmedUnderstanding, null, 2)}
"""

USER-PROVIDED CONTEXT:
Success definition: "${gapAnswers?.successDefinition || 'not provided'}"
Deadline: "${gapAnswers?.deadline || 'not provided'}"

DRAFT RECOMMENDATION TO CHECK:
"""
${JSON.stringify(draftRecommendation, null, 2)}
"""

TASK:
Check every claim in the draft recommendation against the confirmed understanding and user-provided context above. If everything is properly grounded, return the draft recommendation exactly as given. If something is invented, overstated, or not actually supported by the source material, correct ONLY that part — keep everything else from the draft unchanged.

Return ONLY valid JSON in this EXACT shape — all fields REQUIRED and non-empty, with no markdown fences, no commentary outside the JSON, and no notes about what you changed:

{
  "recommendedAction": "non-empty string",
  "why": "non-empty string",
  "milestone": "non-empty string",
  "roadmap": [
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"},
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"},
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"}
  ],
  "openDecision": "non-empty string"
}

The roadmap array must always contain exactly 3 phase objects, even if you are passing the draft through unchanged — copy them across completely, do not drop or truncate any field.${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or had empty/missing fields. Copy every field from the draft across completely unless you are specifically correcting it. Follow the shape precisely this time.' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateRecommendationShape);
}

// ---------------------------------------------------------------------------
// Shared OpenAI call helper
// ---------------------------------------------------------------------------
async function callOpenAI(systemPrompt, apiKey, { jsonMode = false } = {}) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: 0.4,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned an empty response');
  }
  return content;
}
