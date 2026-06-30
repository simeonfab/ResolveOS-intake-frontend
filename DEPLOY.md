# Resolve — Live App Deployment

## Guardrails — how malformed API responses are handled

Every response from OpenAI is checked against an exact schema before it ever reaches the frontend:

- All required fields must be present and non-empty strings
- `gapQuestions` must have at least 2 entries
- `roadmap` must have exactly 3 phases, each with `phase`, `action`, and `output` filled in

If a response fails validation (missing field, empty string, malformed JSON, wrong array length), the function automatically retries once with a stricter version of the prompt that explicitly flags what went wrong. If it still fails after the retry, the user sees a clear "something went wrong, try again" message on the processing screen — rather than the app silently rendering blank cards or crashing.

This means the frontend can always trust that if it receives data, that data is complete and correctly shaped — no defensive `|| '—'` guessing required at render time, though a few are still in place as a final safety net.

## What's in this folder


```
resolve-live-app/
├── api/
│   └── resolve.js       <- serverless function, holds the API key, runs the 3-call pipeline
├── public/
│   └── index.html        <- the frontend (same design as the mockup, now wired to real calls)
└── package.json
```

## How the pipeline works

**Call 1 — Business Analyst (understanding extraction)**
Triggered when you click "Build my path" on Screen 1. Takes your raw project text, returns the 4 understanding cards, 2 gap questions, and assumptions — grounded in the actual `business-analyst.md` rules (never invent facts, document assumptions explicitly, surface gaps as questions).

**Call 2 — Strategic Product Director (recommendation)**
Triggered when you click "Show my next move" on Screen 2. Takes your confirmed understanding plus your 2 gap answers, returns one recommended action, the why, the milestone, and a 3-phase roadmap — grounded in `strategic-product-director.md` (one clear recommendation, not a menu; evidence over invention).

**Call 3 — QA self-check (automatic, no separate button)**
Runs immediately after Call 2, before you see anything. Checks the draft recommendation against the confirmed understanding and corrects anything that overreaches or invents certainty — grounded in the project-readiness governance file's validation model.

Total: 3 API calls per full session through the flow.

## Deploying to Vercel

1. Push this folder to a GitHub repo (or a new one)
2. In Vercel, import the repo
3. **Before deploying**, add an environment variable:
   - Key: `OPENAI_API_KEY`
   - Value: your actual OpenAI API key
   - Set it for Production (and Preview if you want to test before merging)
4. Deploy. Vercel automatically detects `/api/resolve.js` as a serverless function — no extra config needed.

## Testing locally first (recommended before showing anyone)

If you have the Vercel CLI installed:
```
vercel dev
```
This runs the serverless function locally and lets you test the full flow before deploying. You'll need a `.env.local` file with `OPENAI_API_KEY=your-key-here` for local testing — do not commit that file.

## What to test before sending to anyone

1. Run it once with the seeded example ("Load an example project" button on Screen 1) — confirms the pipeline works end to end with known-good input
2. Run it once with your own real messy project — checks output quality on real input
3. Run it once with deliberately sparse/vague input — checks that it asks good gap questions rather than inventing detail
4. Check what happens if you leave Screen 1 empty and hit continue — should show an inline message, not break
5. If you have a moment, temporarily break the API key (wrong value) to see the error screen — confirms it fails gracefully rather than hanging or crashing

## Known limitations of this version (by design, not bugs)

- No persistence — refreshing the page loses everything. Fine for this test, not fine for real use.
- No accounts/auth — anyone with the link can use it and it'll burn your API credits. Don't share the link publicly yet.
- Screen 4's secondary action cards are still static (not AI-generated) — only the primary recommended action updates from the real data. This was a deliberate scope cut to keep the test focused on Calls 1-3 quality first.
- Cost: each full session is 3 GPT-4o calls. Monitor usage on platform.openai.com if you run this past a handful of sessions.
