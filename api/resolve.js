// /api/resolve.js
// Vercel serverless function. Holds the OpenAI API key server-side.
// Implements a 4-call pipeline grounded in the bundled ResolveOS role/governance files:
//   Call 1: Business Analyst -> understanding extraction (S1 -> S2)
//   Call 2: Strategic Product Director -> recommendation + roadmap (S2 -> S3)
//   Call 3: QA self-check -> validates Call 2 against Call 1 and gap answers
//   Call 4: Project plan -> fresh report sections assembled with prior output client-side

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTEXT_FILES = {
  businessAnalyst: 'roles/business-analyst.md',
  strategicProductDirector: 'roles/strategic-product-director.md',
  projectReadiness: 'governance/project-readiness.md',
};

const OUTPUT_TEMPLATES_FILE = 'resolve-output-templates.md';
const VALID_OUTPUT_TEMPLATE_IDS = new Set([
  'key-decision',
  'one-week-plan',
  'ai-continuation',
  'plain-english',
  'share-message',
  'project-brief',
  'stakeholder-update',
  'risk-summary',
  'notion-brief',
  'ai-handoff',
  'stop-list',
  'speculative-roadmap',
  'name-ideas',
  'elevator-pitch',
  'github-issue',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { stage, projectInput, confirmedUnderstanding, gapAnswers, recommendationData, confirmedTools } = req.body;

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
      const draft = await runRecommendationCall(confirmedUnderstanding, gapAnswers, confirmedTools, apiKey);
      const checked = await runQACheckCall(confirmedUnderstanding, gapAnswers, confirmedTools, draft, apiKey);
      return res.status(200).json(checked);
    }

    if (stage === 'plan') {
      const result = await runProjectPlanCall(confirmedUnderstanding, recommendationData, gapAnswers, confirmedTools, apiKey);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown stage' });
  } catch (err) {
    console.error('Resolve API error:', err);
    const isShapeError = err.name === 'ResolveShapeError';
    return res.status(isShapeError ? 502 : 500).json({
      error: isShapeError
        ? "Resolve's response didn't come back in the right shape. This is usually temporary - try again."
        : 'Resolve could not process this right now. Try again, or simplify your input.',
      detail: process.env.NODE_ENV === 'development' ? String(err) : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// SCHEMA VALIDATION
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

const TOOL_NAME_PATTERNS = [
  ['Notion', /\bnotion\b/i],
  ['GitHub', /\bgithub\b/i],
  ['Cursor', /\bcursor\b/i],
  ['Codex', /\bcodex\b/i],
  ['Claude', /\bclaude\b/i],
  ['ChatGPT', /\bchatgpt\b|\bchat gpt\b/i],
  ['Jira', /\bjira\b/i],
  ['Linear', /\blinear\b/i],
  ['Figma', /\bfigma\b/i],
  ['Slack', /\bslack\b/i],
  ['Trello', /\btrello\b/i],
  ['Asana', /\basana\b/i],
  ['Vercel', /\bvercel\b/i],
  ['Supabase', /\bsupabase\b/i],
  ['Zapier', /\bzapier\b/i],
  ['n8n', /\bn8n\b/i],
  ['Google Docs', /\bgoogle docs\b|\bgoogle doc\b/i],
  ['Google Sheets', /\bgoogle sheets\b|\bgoogle sheet\b/i],
  ['Airtable', /\bairtable\b/i],
  ['Coda', /\bcoda\b/i],
];

function detectMentionedTools(input = '') {
  return TOOL_NAME_PATTERNS
    .filter(([, pattern]) => pattern.test(input))
    .map(([name]) => name)
    .slice(0, 5);
}

function validateStringArray(data, key, { min = 1, max = Infinity } = {}) {
  if (!Array.isArray(data[key]) || data[key].length < min || data[key].length > max) {
    throw new ResolveShapeError(`Field "${key}" must contain ${min}-${max} entries`);
  }
  if (!data[key].every(isNonEmptyString)) {
    throw new ResolveShapeError(`Field "${key}" contains an empty or non-string entry`);
  }
}

function validateUnderstandingShape(data) {
  const required = ['project', 'goal', 'state', 'uncertainty', 'outcome', 'outcomeStated', 'outcomeQuestion', 'gapQuestions', 'assumptions'];
  for (const key of required) {
    if (!(key in data)) {
      throw new ResolveShapeError(`Understanding response missing required field: ${key}`);
    }
  }
  // "outcome" is required and non-empty so it can never silently arrive blank: it holds
  // either the outcome extracted from the input, or Call 1's best grounded provisional read.
  for (const key of ['project', 'goal', 'state', 'uncertainty', 'outcome']) {
    if (!isNonEmptyString(data[key])) {
      throw new ResolveShapeError(`Understanding field "${key}" is empty or not a string`);
    }
  }
  if (typeof data.outcomeStated !== 'boolean') {
    throw new ResolveShapeError('Understanding field "outcomeStated" must be a boolean');
  }
  if (typeof data.outcomeQuestion !== 'string') {
    throw new ResolveShapeError('Understanding field "outcomeQuestion" must be a string');
  }
  // When the founder did not already state the outcome, we must have a question to ask.
  if (!data.outcomeStated && !isNonEmptyString(data.outcomeQuestion)) {
    throw new ResolveShapeError('Understanding field "outcomeQuestion" is required when outcomeStated is false');
  }
  if (!Array.isArray(data.gapQuestions)) {
    throw new ResolveShapeError('Understanding field "gapQuestions" must be an array');
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
  if (!('mentionedTools' in data)) {
    data.mentionedTools = [];
  }
  validateStringArray(data, 'mentionedTools', { min: 0, max: 5 });
  return data;
}

function validateRecommendationShape(data) {
  const required = [
    'recommendedAction',
    'why',
    'milestone',
    'openDecision',
    'roadmap',
    'topPriorities',
    'doNotYet',
    'outputTemplates',
    'topCardType',
    'winSummary',
  ];
  for (const key of required) {
    if (!(key in data)) {
      throw new ResolveShapeError(`Recommendation response missing required field: ${key}`);
    }
  }
  for (const key of ['recommendedAction', 'why', 'milestone', 'openDecision', 'winSummary']) {
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
  validateStringArray(data, 'topPriorities', { min: 1, max: 3 });
  if (!Array.isArray(data.doNotYet) || data.doNotYet.length < 1 || data.doNotYet.length > 3) {
    throw new ResolveShapeError('Recommendation field "doNotYet" must contain 1-3 rows');
  }
  data.doNotYet.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new ResolveShapeError(`Do-not-yet item ${i} is not an object`);
    }
    for (const key of ['item', 'reason']) {
      if (!isNonEmptyString(row[key])) {
        throw new ResolveShapeError(`Do-not-yet item ${i} missing or empty field: ${key}`);
      }
    }
  });
  if (data.topCardType !== 'action' && data.topCardType !== 'decision') {
    throw new ResolveShapeError('Recommendation field "topCardType" must be "action" or "decision"');
  }
  if (!Array.isArray(data.outputTemplates) || data.outputTemplates.length !== 6) {
    throw new ResolveShapeError('Recommendation field "outputTemplates" must contain exactly 6 templates');
  }
  data.outputTemplates.forEach((template, i) => {
    if (!template || typeof template !== 'object') {
      throw new ResolveShapeError(`Output template ${i} is not an object`);
    }
    for (const key of ['templateId', 'label', 'description', 'icon']) {
      if (!isNonEmptyString(template[key])) {
        throw new ResolveShapeError(`Output template ${i} missing or empty field: ${key}`);
      }
    }
    if (!VALID_OUTPUT_TEMPLATE_IDS.has(template.templateId)) {
      throw new ResolveShapeError(`Output template ${i} has invalid templateId: ${template.templateId}`);
    }
  });
  return data;
}

function validateProjectPlanShape(data) {
  const required = ['longTermRoadmap', 'readiness', 'sharingParagraph', 'howToUseThis'];
  const allowedStatuses = ['Ready', 'Partially ready', 'Blocked', 'Not ready'];

  for (const key of required) {
    if (!(key in data)) {
      throw new ResolveShapeError(`Project plan response missing required field: ${key}`);
    }
  }
  if (!Array.isArray(data.longTermRoadmap) || data.longTermRoadmap.length < 1 || data.longTermRoadmap.length > 4) {
    throw new ResolveShapeError('Project plan field "longTermRoadmap" must contain 1-4 rows');
  }
  data.longTermRoadmap.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new ResolveShapeError(`Long-term roadmap row ${i} is not an object`);
    }
    for (const key of ['phase', 'direction', 'note']) {
      if (!isNonEmptyString(row[key])) {
        throw new ResolveShapeError(`Long-term roadmap row ${i} missing or empty field: ${key}`);
      }
    }
  });
  if (!Array.isArray(data.readiness) || data.readiness.length < 4) {
    throw new ResolveShapeError('Project plan field "readiness" must contain at least 4 rows');
  }
  data.readiness.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      throw new ResolveShapeError(`Readiness row ${i} is not an object`);
    }
    for (const key of ['area', 'status', 'note']) {
      if (!isNonEmptyString(row[key])) {
        throw new ResolveShapeError(`Readiness row ${i} missing or empty field: ${key}`);
      }
    }
    if (!allowedStatuses.includes(row.status)) {
      throw new ResolveShapeError(`Readiness row ${i} has invalid status: ${row.status}`);
    }
  });
  if ('risks' in data) {
    if (!Array.isArray(data.risks)) {
      throw new ResolveShapeError('Project plan field "risks" must be an array when present');
    }
    data.risks.forEach((row, i) => {
      if (!row || typeof row !== 'object') {
        throw new ResolveShapeError(`Risk row ${i} is not an object`);
      }
      for (const key of ['risk', 'whyItMatters', 'sourceSignal']) {
        if (!isNonEmptyString(row[key])) {
          throw new ResolveShapeError(`Risk row ${i} missing or empty field: ${key}`);
        }
      }
    });
  } else {
    data.risks = [];
  }
  for (const key of ['sharingParagraph', 'howToUseThis']) {
    if (!isNonEmptyString(data[key])) {
      throw new ResolveShapeError(`Project plan field "${key}" is empty or not a string`);
    }
  }
  return data;
}

function formatGapAnswers(gapAnswers) {
  const answers = Array.isArray(gapAnswers) ? gapAnswers : [];
  if (!answers.length) {
    return 'No gap answers were provided.';
  }
  return answers.map((item, index) => {
    const question = isNonEmptyString(item?.question) ? item.question : `Question ${index + 1}`;
    const answer = isNonEmptyString(item?.answer) ? item.answer : 'not answered';
    return `Q: ${question}\nA: ${answer}`;
  }).join('\n\n');
}

function readResolveOSContext(relativePath) {
  const candidates = [
    path.join(process.cwd(), 'resolveos-context', relativePath),
    path.join(__dirname, '..', 'resolveos-context', relativePath),
    path.join(__dirname, 'resolveos-context', relativePath),
  ];
  const filePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!filePath) {
    throw new Error(`Missing ResolveOS context file: ${relativePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readBundledRootFile(relativePath) {
  const candidates = [
    path.join(process.cwd(), relativePath),
    path.join(__dirname, '..', relativePath),
    path.join(__dirname, relativePath),
  ];
  const filePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!filePath) {
    throw new Error(`Missing bundled file: ${relativePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function loadContextBundle(keys) {
  return keys.map(key => {
    const filePath = CONTEXT_FILES[key];
    const content = readResolveOSContext(filePath);
    return `--- BEGIN REAL RESOLVEOS SOURCE: ${filePath} ---\n${content}\n--- END REAL RESOLVEOS SOURCE: ${filePath} ---`;
  }).join('\n\n');
}

function formatConfirmedTools(confirmedTools) {
  const tools = Array.isArray(confirmedTools)
    ? confirmedTools.filter(isNonEmptyString).slice(0, 10)
    : [];
  return tools.length ? tools.join(', ') : 'No tools confirmed.';
}

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
// CALL 1 - Business Analyst: understanding extraction
// ---------------------------------------------------------------------------
async function runUnderstandingCall(projectInput, apiKey) {
  const businessAnalystContext = loadContextBundle(['businessAnalyst']);
  const buildPrompt = (isRetry) => `You are operating as the ResolveOS Business Analyst role.

The following is the real ResolveOS Business Analyst role definition you are operating under. Follow it exactly, including all stated rules about not inventing information, separating stated facts from assumptions, and documenting assumptions explicitly.

${businessAnalystContext}

Your task-specific job here: apply that Business Analyst role to a messy project description rather than a formal requirement.

SESSION RULES:
- Do not invent missing facts. Do not guess details the user did not provide.
- Never ask for information that the user has already provided in the project input. If it is already stated, use it.
- If something genuinely needed to understand the project is missing, surface it as a question rather than filling it in yourself.
- Detect explicitly mentioned tools case-insensitively, but do not infer tools that are not named.
- Keep output concise and practical. No filler, no generic encouragement, no hype.

CRITICAL RULE FOR GAP QUESTIONS: Gap questions must only ask for information that is DIRECTLY needed to produce a clear, grounded project recommendation and execution path. Do not ask strategic business questions, market questions, pricing questions, or anything that goes beyond what's needed to understand this project's current state and immediate next step. Valid gap questions are things like: "What have you already tried?" or "Is there a deadline driving this?" or "Who else is involved in this project?" Invalid gap questions are things like: "What should your first paid offer be?" or "What assets can be used commercially?" - these are business strategy questions, not intake blockers. If you genuinely have everything needed to produce a good recommendation from the input provided, return an empty gapQuestions array. Do not pad with questions just to fill the slots. The outcome is handled separately via "outcome"/"outcomeStated"/"outcomeQuestion" below - do NOT also put an outcome question inside "gapQuestions".

OUTCOME (REQUIRED - the single most important thing to capture):
An outcome is WHO is different, and what they now observably do, experience, or measurably stop doing, if this project works. It is NOT an artifact ("the app is built", "the site is live", "the brand is refreshed") and NOT a restatement of the project or goal. A real outcome names a person or group and an observable change for them (for example: "returning customers reorder without being chased" or "the founder stops spending Sundays reconciling invoices by hand").
- If the founder's input ALREADY states a clear outcome, EXTRACT it into "outcome", set "outcomeStated" to true, and set "outcomeQuestion" to an empty string. Never ask a question we already have the answer to.
- If the outcome is ABSENT or VAGUE, set "outcomeStated" to false. Put your best grounded provisional read of the likely outcome in "outcome" (phrased as a plausible read of what they seem to want, never invented as fact), AND write a natural, project-specific "outcomeQuestion" that a non-technical founder can answer in one sentence. Shape it like "If this works, who is better off, and how would you know?" but phrased specifically for THIS project - do not paste that sentence verbatim as boilerplate.

THE USER'S PROJECT:
"""
${projectInput}
"""

TASK:
Produce a structured understanding of this project. Return ONLY valid JSON matching this EXACT shape:

{
  "project": "one or two sentences naming what the project actually is, based only on what was stated",
  "goal": "what the user appears to be trying to achieve, based only on what was stated or clearly implied",
  "state": "where the project currently stands, based only on what was stated",
  "uncertainty": "the single biggest open question or unknown that the input does not resolve",
  "outcome": "who is better off and the observable change for them: extracted from the input if the outcome was stated, otherwise your best grounded provisional read of what they seem to want",
  "outcomeStated": true or false - true ONLY if the input already clearly stated a real outcome (who is different and how), false if it is absent or vague,
  "outcomeQuestion": "when outcomeStated is false, a natural, project-specific outcome question a non-technical founder can answer in one sentence; when outcomeStated is true, an empty string",
  "gapQuestions": [
    "zero, one, or two OTHER specific intake-blocker questions whose answers are directly needed for a grounded recommendation - do NOT include an outcome question here"
  ],
  "assumptions": [
    "an assumption you are making to proceed, stated plainly as an assumption, not as fact"
  ],
  "mentionedTools": [
    "tool names explicitly mentioned in the raw project input"
  ]
}

REQUIRED: "project", "goal", "state", "uncertainty", and "outcome" must each be a non-empty string. If the input is too sparse for confidence, say that plainly rather than leaving fields blank. "outcomeStated" must be a boolean. "outcomeQuestion" must be a string, and must be a non-empty question whenever "outcomeStated" is false. "gapQuestions" must be an array containing 0-2 non-empty strings (excluding the outcome question); return [] if no other direct intake blockers remain. "assumptions" must be an array. "mentionedTools" must be an array; it may be empty. Include only tools explicitly named in the raw input, such as Notion, GitHub, Cursor, Codex, Claude, ChatGPT, Jira, Linear, Figma, Slack, Trello, Asana, Vercel, Supabase, Zapier, n8n, Google Docs, Google Sheets, Airtable, or Coda. Cap mentionedTools at 5.${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or had empty/missing fields. Follow the shape precisely this time.' : ''}`;

  const result = await callWithValidation(buildPrompt, apiKey, validateUnderstandingShape);
  result.mentionedTools = detectMentionedTools(projectInput);

  // The outcome question is ALWAYS asked first - unless the founder's input already stated a
  // clear outcome, in which case Call 1 extracted it into `outcome` and we do not ask redundantly.
  // Prepending here (rather than trusting the model to order gapQuestions) guarantees the outcome
  // question is gapQuestions[0] and matches `outcomeQuestion` exactly, so the frontend can pair the
  // founder's answer back to the outcome deterministically.
  if (result.outcomeStated) {
    result.outcomeQuestion = '';
    result.gapQuestions = result.gapQuestions.slice(0, 2);
  } else {
    result.gapQuestions = [result.outcomeQuestion, ...result.gapQuestions]
      .filter(isNonEmptyString)
      .slice(0, 2);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CALL 2 - Strategic Product Director: recommendation + roadmap
// ---------------------------------------------------------------------------
async function runRecommendationCall(confirmedUnderstanding, gapAnswers, confirmedTools, apiKey) {
  const strategicContext = loadContextBundle(['strategicProductDirector', 'projectReadiness']);
  const outputTemplateContext = readBundledRootFile(OUTPUT_TEMPLATES_FILE);
  const gapAnswerText = formatGapAnswers(gapAnswers);
  const confirmedToolText = formatConfirmedTools(confirmedTools);
  const buildPrompt = (isRetry) => `You are operating as the ResolveOS Strategic Product Director role.

The following are the real ResolveOS Strategic Product Director role definition and project-readiness governance model you are operating under. Follow them exactly, including all stated rules about evidence over invention, strategic challenge, readiness, fake certainty, and not approving padded or unsupported content.

${strategicContext}

The following is the full Resolve output template selection library. Use it as the source of truth for choosing exactly 6 output templates.

--- BEGIN RESOLVE OUTPUT TEMPLATE LIBRARY: ${OUTPUT_TEMPLATES_FILE} ---
${outputTemplateContext}
--- END RESOLVE OUTPUT TEMPLATE LIBRARY: ${OUTPUT_TEMPLATES_FILE} ---

Your task-specific job here: decide what matters most right now and give ONE clear, opinionated recommendation with reasoning. Do not give a menu of equally weighted options.

SESSION RULES:
- Prefer evidence over invention. Do not invent market facts, business value, urgency, constraints, users, or strategic priority that the input does not support.
- Never ask for information that has already been provided earlier in this same session, including the original project input, confirmed understanding, or gap-question answers below.
- Top priorities and do-not-yet items must be genuinely earned by the source material. Use 1-3 items only; do not pad to make a section look fuller.
- Select exactly 6 outputTemplates from the template library. Every label and description must be specific to this project, not generic.
- Template IDs that depend on confirmed tools (notion-brief, ai-handoff, github-issue) may only be selected when the relevant tool is listed in CONFIRMED TOOLS below.
- risk-summary may only be selected if genuine risks are identifiable. name-ideas may only be selected if no project name is detected.
- If in doubt, choose the template whose output the user can act on most immediately.
- Be direct, practical, and free of generic startup hype.

CONFIRMED PROJECT UNDERSTANDING:
"""
${JSON.stringify(confirmedUnderstanding, null, 2)}
"""

PAIRED GAP ANSWERS:
${gapAnswerText}

CONFIRMED TOOLS:
${confirmedToolText}

TASK:
Return ONLY valid JSON matching this EXACT shape:

{
  "recommendedAction": "one clear, specific sentence describing the single most important thing to do next",
  "why": "2-3 sentences explaining why this is the right move now, grounded in the confirmed understanding and gap answers",
  "milestone": "what 'done' looks like for this recommended action - specific and observable",
  "openDecision": "one specific decision that still matters, or the main decision implied by the next move",
  "roadmap": [
    {"phase": "Now", "action": "short phrase", "output": "what this phase produces"},
    {"phase": "Define", "action": "short phrase", "output": "what this phase produces"},
    {"phase": "Launch", "action": "short phrase", "output": "what this phase produces"}
  ],
  "topPriorities": [
    "a genuinely supported priority, stated as a concrete action or focus"
  ],
  "doNotYet": [
    {"item": "thing not to do yet", "reason": "one-line reason grounded in the source"}
  ],
  "outputTemplates": [
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"},
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"},
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"},
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"},
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"},
    {"templateId": "one of the 15 valid template IDs", "label": "specific project-relevant label", "description": "one sentence explaining why this is relevant for this project", "icon": "single relevant emoji"}
  ],
  "topCardType": "action | decision",
  "winSummary": "one sentence in this style: A messy [specific project situation] - turned into a focused path forward. That's the hard part done."
}

REQUIRED: topPriorities must contain 1-3 strings. doNotYet must contain 1-3 objects. Do not pad either list. roadmap must contain exactly 3 phase objects. outputTemplates must contain exactly 6 objects using valid template IDs from the library. topCardType must be "action" or "decision". If an answer was not provided for a gap question, do not invent it.${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or had unsupported/padded content. Follow the shape precisely and include only genuinely earned top priorities, do-not-yet items, and output templates.' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateRecommendationShape);
}

// ---------------------------------------------------------------------------
// CALL 3 - QA self-check
// ---------------------------------------------------------------------------
async function runQACheckCall(confirmedUnderstanding, gapAnswers, confirmedTools, draftRecommendation, apiKey) {
  const readinessContext = loadContextBundle(['projectReadiness']);
  const outputTemplateContext = readBundledRootFile(OUTPUT_TEMPLATES_FILE);
  const gapAnswerText = formatGapAnswers(gapAnswers);
  const confirmedToolText = formatConfirmedTools(confirmedTools);
  const buildPrompt = (isRetry) => `You are operating as a ResolveOS QA self-check pass.

The following is the real ResolveOS project-readiness governance model you must use as your validation source. Follow it exactly, including rules about evidence, fake certainty, readiness state, and not hiding uncertainty.

${readinessContext}

The following is the Resolve output template library. Use it to verify whether each selected output template is allowed and genuinely earned.

--- BEGIN RESOLVE OUTPUT TEMPLATE LIBRARY: ${OUTPUT_TEMPLATES_FILE} ---
${outputTemplateContext}
--- END RESOLVE OUTPUT TEMPLATE LIBRARY: ${OUTPUT_TEMPLATES_FILE} ---

Your job is to check a draft recommendation against the confirmed understanding and paired gap answers it was supposed to be based on.

CORE RULES:
- Do not approve fake certainty. If the draft recommendation asserts something unsupported, correct it.
- Do not approve padding. For variable-length list sections, keep only the count genuinely earned by the source material. If a section is conditional and the content is not genuinely supported, remove it or reduce it rather than letting thin placeholders through.
- Do not approve an output template whose selection rules are not met. Replace it with a better supported template from the library while keeping exactly 6 outputTemplates.
- notion-brief, ai-handoff, and github-issue require the relevant confirmed tool. risk-summary requires genuine identifiable risk. name-ideas requires no detected project name.
- Never ask for information that has already been provided earlier in this same session.
- For fixed UI fields required by the schema, correct unsupported generic content into grounded content instead of inventing new facts.

CONFIRMED UNDERSTANDING:
"""
${JSON.stringify(confirmedUnderstanding, null, 2)}
"""

PAIRED GAP ANSWERS:
${gapAnswerText}

CONFIRMED TOOLS:
${confirmedToolText}

DRAFT RECOMMENDATION TO CHECK:
"""
${JSON.stringify(draftRecommendation, null, 2)}
"""

TASK:
Check every claim and list item in the draft recommendation. If everything is properly grounded, return the draft recommendation exactly as given. If something is invented, overstated, padded, or unsupported, correct only that part.

Return ONLY valid JSON in this EXACT shape:

{
  "recommendedAction": "non-empty string",
  "why": "non-empty string",
  "milestone": "non-empty string",
  "openDecision": "non-empty string",
  "roadmap": [
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"},
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"},
    {"phase": "non-empty string", "action": "non-empty string", "output": "non-empty string"}
  ],
  "topPriorities": [
    "1-3 genuinely supported priorities only"
  ],
  "doNotYet": [
    {"item": "1-3 genuinely supported do-not-yet items only", "reason": "grounded reason"}
  ],
  "outputTemplates": [
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"},
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"},
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"},
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"},
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"},
    {"templateId": "valid template ID", "label": "non-empty string", "description": "non-empty string", "icon": "non-empty string"}
  ],
  "topCardType": "action | decision",
  "winSummary": "non-empty string"
}

topPriorities and doNotYet must each contain 1-3 genuinely supported entries. roadmap must always contain exactly 3 phases. outputTemplates must always contain exactly 6 valid, genuinely relevant template objects. topCardType must be "action" or "decision".${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or still had unsupported/padded content. Copy every grounded field from the draft and correct only unsupported parts.' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateRecommendationShape);
}

// ---------------------------------------------------------------------------
// CALL 4 - Fresh report sections only
// ---------------------------------------------------------------------------
async function runProjectPlanCall(confirmedUnderstanding, recommendationData, gapAnswers, confirmedTools, apiKey) {
  const fullContext = loadContextBundle(['businessAnalyst', 'strategicProductDirector', 'projectReadiness']);
  const gapAnswerText = formatGapAnswers(gapAnswers);
  const confirmedToolText = formatConfirmedTools(confirmedTools);
  const buildPrompt = (isRetry) => `You are operating as Resolve's project-plan handoff writer.

The following are the real ResolveOS Business Analyst role, Strategic Product Director role, and project-readiness governance files. Follow them exactly, especially the rules about evidence over invention, documenting assumptions, not approving fake certainty, and not padding optional sections.

${fullContext}

This is an assembly call. Sections 1-4 of the final report are NOT yours to regenerate:
1. Project identity / objective / phase comes verbatim from confirmedUnderstanding.project, confirmedUnderstanding.goal, and confirmedUnderstanding.state.
2. Highest-leverage next action comes verbatim from recommendationData.recommendedAction and recommendationData.why.
3. Top priorities come verbatim from recommendationData.topPriorities.
4. What not to do yet comes verbatim from recommendationData.doNotYet.

Your task is to generate ONLY sections 5-9:
5. Speculative long-term roadmap, explicitly labelled as reasoned extrapolation rather than fact.
6. Readiness table for a no-repo/no-codebase project context.
7. Risks, inferred only from the existing understanding, recommendation, and gap answers. If no genuine risk is supported, return an empty risks array.
8. Sharing paragraph for someone outside the project.
9. How to use this, with practical direction and an explicit mention that the user can copy relevant parts into another AI tool such as ChatGPT or Claude.

CONFIRMED PROJECT UNDERSTANDING:
"""
${JSON.stringify(confirmedUnderstanding, null, 2)}
"""

RECOMMENDATION DATA:
"""
${JSON.stringify(recommendationData, null, 2)}
"""

PAIRED GAP ANSWERS:
${gapAnswerText}

CONFIRMED TOOLS:
${confirmedToolText}

TASK:
Return ONLY valid JSON matching this EXACT shape:

{
  "longTermRoadmap": [
    {"phase": "short future-facing phase name", "direction": "plain-language possible direction", "note": "make clear this is reasoned extrapolation if the immediate priorities go well, not a present fact"}
  ],
  "readiness": [
    {"area": "Direction is clear", "status": "Ready | Partially ready | Blocked | Not ready", "note": "one genuine explanatory sentence"},
    {"area": "Planning is usable", "status": "Ready | Partially ready | Blocked | Not ready", "note": "one genuine explanatory sentence"},
    {"area": "Ready to act", "status": "Ready | Partially ready | Blocked | Not ready", "note": "one genuine explanatory sentence"},
    {"area": "Evidence is strong enough", "status": "Ready | Partially ready | Blocked | Not ready", "note": "one genuine explanatory sentence"}
  ],
  "risks": [
    {"risk": "specific inferred risk", "whyItMatters": "plain-language consequence", "sourceSignal": "what in the provided context supports this risk"}
  ],
  "sharingParagraph": "one short paragraph written for someone outside the project, not as a recap to the owner",
  "howToUseThis": "practical, concrete direction on what to literally do with this document next, explicitly mentioning copying relevant parts into ChatGPT, Claude, or another AI tool"
}

REQUIRED: longTermRoadmap must contain 1-4 rows. readiness must contain at least 4 rows with statuses exactly Ready, Partially ready, Blocked, or Not ready. risks may be an empty array if no genuine risk is supported. Do not include a closing question or any 10th section.${isRetry ? '\n\nIMPORTANT: Your previous response did not match this exact shape or included unsupported/padded content. Return only the fresh sections above, and leave risks empty if not genuinely earned.' : ''}`;

  return callWithValidation(buildPrompt, apiKey, validateProjectPlanShape);
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
