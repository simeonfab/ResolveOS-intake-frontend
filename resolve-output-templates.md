# Resolve Output Templates - Master Definitions (v1)
Generated: 2 July 2026
Author: Strategic Product Director framing
Status: v1 working definitions, not final copy

---

## How these work

Each template has:
- **ID** - used by the frontend to know how to render/generate it
- **Label pattern** - dynamic, project-specific. Never generic.
- **When to surface** - when Call 2 should select this template for a given project
- **Content shape** - what the output actually contains
- **Tone** - how it should feel

Call 2 selects the 6 most relevant templates for each project and returns them with project-specific label and description text. The frontend renders whatever 6 come back.

---

## Template 01 - Key Decision

**ID:** `key-decision`

**Label pattern:** "Decide: [the specific decision]"
Example: "Decide: which brand name to go with"
Example: "Decide: whether to build or validate first"

**When to surface:** when the project has a clear decision that is blocking meaningful progress. Specifically: when the recommended action depends on a choice not yet made.

**Content shape:**
- The decision in one sentence
- Why it's blocking (one sentence)
- 2-3 realistic options, each with a one-line trade-off
- A suggested lean if one is clearly stronger (optional, only if genuinely supportable from input)

**Tone:** Direct. Not wishy-washy. Gives the user a real steer if one exists.

---

## Template 02 - One-Week Action Plan

**ID:** `one-week-plan`

**Label pattern:** "Your plan for this week"
(stays relatively consistent - the specificity is in the content, not the label)

**When to surface:** almost always. Default inclusion unless the project is so early-stage that even a week plan would be invented.

**Content shape:**
- 3 specific actions for this week
- Each with: what to do, done-when condition, rough timebox
- Ordered by sequence (not importance - what to do first, second, third)

**Tone:** Concrete and achievable. Not aspirational. If it can't be done in a week, it shouldn't be on this list.

---

## Template 03 - Continue in AI

**ID:** `ai-continuation`

**Label pattern:** "Continue this in [tool]" if tool detected, otherwise "Pick this up in Claude / ChatGPT"

**When to surface:** always. One of the core handoff outputs. Should almost always be in the default six.

**Content shape:**
A ready-to-paste prompt that includes:
- Full project context summary (what the project is, current state, what's been decided)
- What was recommended and why
- What the user should ask the AI to help with next
- Any open questions or decisions still outstanding

Formatted so the user can literally copy and paste it into another AI tool and continue immediately.

**Tone:** Functional. This isn't a document, it's a prompt. Should feel like a baton handoff.

---

## Template 04 - Plain English Explanation

**ID:** `plain-english`

**Label pattern:** "Explain [project name or 'this'] to someone else"

**When to surface:** almost always. Especially when the project description in the input was complex, technical, or hard to summarise.

**Content shape:**
One paragraph (4-6 sentences) that explains:
- What this project is
- Why it matters / what problem it solves
- Where it currently stands
- What's happening next

Written for someone with no prior knowledge of the project. Jargon-free.

**Tone:** Warm, clear, human. Written as if explaining to a smart friend who doesn't work in the same field.

---

## Template 05 - Share Message

**ID:** `share-message`

**Label pattern:** "Send this to someone"

**When to surface:** when the project owner appears to need external support, investment, collaboration, or just to explain the project to someone in their life. Surface alongside or instead of plain-english depending on context - these are variants of the same need.

**Content shape:**
2-3 sentences, casual and direct. Something you'd send on WhatsApp or iMessage. Explains what you're working on and what you need (feedback, support, a conversation, etc.).

**Tone:** Conversational. Sounds like a real person, not a press release.

---

## Template 06 - Project Brief

**ID:** `project-brief`

**Label pattern:** "Download your project brief"

**When to surface:** when the project has enough substance to warrant a structured document. Almost always in the default six - this is the "take this somewhere and use it" artifact.

**Content shape:**
Structured markdown document:
- Project name and one-liner
- What it is (expanded)
- Current state
- What exists already
- What's missing or unclear
- Recommended next direction
- Key assumptions
- What not to do yet

**Tone:** Professional but not corporate. Readable by a non-technical person.

---

## Template 07 - Stakeholder Update

**ID:** `stakeholder-update`

**Label pattern:** "Update your [co-founder / team / manager]"
Adapted based on context clues in the input.

**When to surface:** when the input suggests there are other people involved or who need to be kept informed. Don't surface if the project appears fully solo with no stakeholders.

**Content shape:**
Short structured message (3-4 short paragraphs):
- Where we are
- What we decided / what changed
- What's happening next
- What I need from you (if anything)

**Tone:** Professional, direct. Like a good Slack update.

---

## Template 08 - Risk Summary

**ID:** `risk-summary`

**Label pattern:** "What could go wrong"

**When to surface:** when genuine risks are identifiable from the input. Never surface if risks are invented. Particularly relevant when the project has a deadline, dependency, or stated uncertainty.

**Content shape:**
2-3 specific risks (not more):
- What the risk is (one sentence)
- Why it matters (one sentence)
- What to watch for / how to mitigate (one sentence)

**Tone:** Calm and practical. Not catastrophising. Treats the user as an adult.

---

## Template 09 - Notion Brief

**ID:** `notion-brief`

**Label pattern:** "Copy as Notion page"

**When to surface:** when Notion was mentioned or detected in the user's input/confirmed tools.

**Content shape:**
Same as project brief (#06) but formatted for Notion:
- Proper heading hierarchy (H1, H2, H3)
- Bullet points where appropriate
- Callout block for the key decision or main risk
- Property-style summary at the top (Status, Phase, Owner, Last updated)

**Tone:** Structured and clean. Looks good in Notion without manual reformatting.

---

## Template 10 - Claude/ChatGPT Handoff

**ID:** `ai-handoff`

**Label pattern:** "Start fresh in [Claude / ChatGPT]"
Distinct from Template 03 (continue) - this is for starting a new conversation, not continuing the current one.

**When to surface:** when the user appears to want to start a structured new conversation elsewhere rather than continue the current thread.

**Content shape:**
A context-setting document for a new AI conversation:
- Full project brief (compressed)
- What's been decided
- What role to ask the AI to play
- What to work on in this new conversation

**Tone:** Structured. Reads like a project onboarding document for an AI assistant.

---

## Template 11 - What Not To Do

**ID:** `stop-list`

**Label pattern:** "What to avoid right now"

**When to surface:** when the input contains clear scope creep risks, premature decisions, or actions that would waste time given current project state. Don't surface if nothing specific to warn against is identifiable.

**Content shape:**
3-5 specific things not to do right now, each with a one-line reason why. No filler. Only genuinely applicable items.

**Tone:** Direct and protective. Feels like advice from someone who's seen this go wrong before.

---

## Template 12 - Speculative Roadmap

**ID:** `speculative-roadmap`

**Label pattern:** "Where this could go (if it works)"

**When to surface:** when the project has enough direction to extrapolate meaningfully. Label must always signal this is speculative, not a commitment.

**Content shape:**
3-4 phases beyond the current one:
- Phase name
- What it involves
- What "done" looks like
- Rough sequence dependency

Clearly prefaced with: "If the immediate priorities go well, here's a plausible longer-term direction. This is extrapolation, not a plan."

**Tone:** Optimistic but honest. Doesn't oversell.

---

## Template 13 - Project Name Ideas

**ID:** `name-ideas`

**Label pattern:** "Name ideas for this project"

**When to surface:** ONLY when no clear project name was detected in the input. If the project has a name, do not surface this.

**Content shape:**
5 name directions, each with:
- The name
- One sentence on what it communicates
- One sentence on what it doesn't capture

**Tone:** Creative but grounded. Names should actually fit the project, not be generic startup naming conventions.

---

## Template 14 - Elevator Pitch

**ID:** `elevator-pitch`

**Label pattern:** "Your elevator pitch"

**When to surface:** when the project has a clear enough direction to pitch, and the user appears to be at a stage where they'd need to explain it to a potential collaborator, investor, or partner.

**Content shape:**
2 sentences:
- What it is and who it's for
- Why now / why this matters

Plus optionally: a one-line hook version (under 10 words).

**Tone:** Confident and specific. Never vague. If the project isn't clear enough to pitch honestly, don't surface this template.

---

## Template 15 - GitHub Issue Draft

**ID:** `github-issue`

**Label pattern:** "Draft a GitHub issue"

**When to surface:** ONLY when GitHub was mentioned or detected in confirmed tools AND the recommended action is specific enough to become a ticket.

**Content shape:**
- Issue title
- Description (what and why)
- Acceptance criteria (done-when conditions)
- Labels suggestion

**Tone:** Technical and precise. Written for a developer to pick up and act on.

---

## Selection rules for Call 2

When selecting the 6 templates to return for a given project:

1. Template 03 (Continue in AI) is almost always included
2. Template 04 or 05 (Plain English / Share Message) is almost always included
3. Template 06 (Project Brief) is almost always included
4. Templates 09, 10, 15 (Notion, AI Handoff, GitHub) only if relevant tools were confirmed
5. Template 13 (Name Ideas) only if no project name detected
6. Template 08 (Risk Summary) only if genuine risks are identifiable
7. Never surface a template if the content would have to be invented to fill it
8. If in doubt between two templates, pick the one whose output the user can act on most immediately
