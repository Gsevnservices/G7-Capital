# G7 Capital — Claude Code Project Brief
**Read this file at the start of every session before touching any code.**
**Last updated: March 2026**

---

## 1. WHO I AM AND HOW I WORK

I am Pallav — the solo founder of G7 Capital. I have zero coding background. I use Claude as my development partner to build everything. This means:

- Always give me ONE complete file — never fragments or snippets
- If updating an existing file, give me the full updated file
- Tell me the exact filename and whether to create or update
- Never use terminal commands beyond what is absolutely necessary — and if you must, explain each one in plain English
- Add comments inside every code file explaining what each section does
- Test your code mentally before writing it — it must work first try
- Always make everything fully mobile responsive
- If you are unsure about anything, ask me before writing code

---

## 2. WHAT I AM BUILDING — COMPLETE PRODUCT VISION

**G7 Capital** is an AI-native investment ecosystem. The full platform has these pillars:

**PILLAR 1 — G7 WORKSPACE (Currently Building)**
Named AI employees for PE/VC/IB firms. Each employee has persistent memory, a defined role, and structured output format. Firms interact with AI employees via chat and receive structured professional reports.

Active employees for prototype:
- **Alex** — Deal Analyst (screens deals, writes first-pass notes, morning digest)
- **Maya** — DD Associate (full due diligence, investment memos) — PIPELINE
- **David** — Research Analyst (sector reports, market sizing) — PIPELINE
- **Sofia** — Compliance Officer (reviews all outputs, background only, not user-facing)

Descoped for now: James (Portfolio Monitor), Priya (LP Relations), Marcus (IB Analyst)

**PILLAR 2 — G7 CAPITAL OS** — merged into G7 Workspace. The employees ARE the product. Modules are their built-in capabilities.

**PILLAR 3 — G7 COMMUNITY** — in pipeline, not building yet

**DISCARDED:** G7 Apply, G7 Network

**THE CORE DIFFERENTIATOR vs generic AI tools:**
1. Persistent memory — Alex remembers every deal the firm has ever seen
2. Firm configuration — firm uploads thesis, past deals, format preferences. All outputs match firm standards.
3. Structured workflow — not a chat interface. Runs on cadences. Morning digest. Consistent output format. Always.

**COMPETITIVE CONTEXT:**
Main competitor is F2 (f2.ai) — YC-backed, $10M raised Sept 2025.
F2 = document intelligence tool (turns data rooms into structured analysis).
G7 = replaces the analyst team end-to-end. F2 is a faster scalpel. G7 is a surgical team.

---

## 3. TECH STACK — EXACTLY WHAT WE USE

```
Frontend:      HTML + CSS + Vanilla JavaScript (no frameworks)
Hosting:       GitHub Pages via Hostinger (auto-deploys from GitHub Desktop)
Code editor:   VS Code
AI Engine:     Anthropic Claude API — model: claude-sonnet-4-20250514
Storage:       localStorage (browser) — no database for prototype
Forms:         Formspree endpoint: https://formspree.io/f/xzdjwjqy
PDF parsing:   PDF.js (CDN — no install needed)
Fonts:         Google Fonts (Cormorant Garamond + Tenor Sans)
```

**NO:** No Node.js server. No Express. No React. No database. No backend.
Everything runs client-side. API calls go directly from the browser to Anthropic.

**Live URL:** https://gsevnservices.github.io/G7-Capital
**GitHub repo:** github.com/Gsevnservices/G7-Capital
**Contact email:** contact@gsevnservices.in

---

## 4. DESIGN SYSTEM — DO NOT DEVIATE FROM THIS

### Colours
```
Background primary:    #080808  (pure near-black)
Background cards:      #0F0F0F  (dark charcoal)
Background sections:   #161616  (slightly lighter)
Background hover:      #1E1E1E  (subtle lift)
Gold primary:          #C9A84C  (antique gold)
Gold hover/light:      #E2C97E  (lighter gold)
Gold muted:            #A8873A  (darker gold)
White primary:         #FAFAF8  (warm white)
White secondary:       #F0EFE9  (off white)
Grey body text:        #8A8880  (warm mid-grey)
Grey subtle:           #5A5855  (dark grey)
Border gold tint:      rgba(201,168,76,0.15)
Border white tint:     rgba(250,250,248,0.08)
```

### Fonts
```html
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Tenor+Sans&display=swap" rel="stylesheet">
```
- Headlines: Cormorant Garamond weight 300
- Italic emphasis: Cormorant Garamond italic
- Labels/nav/tags/captions: Tenor Sans, ALL CAPS, letter-spacing 0.15-0.25em
- Body text: Tenor Sans, normal case, 13-15px, line-height 1.9

### Style Rules
- Background: Pure black #080808 always
- Grain texture overlay on every page (CSS SVG filter, opacity 0.4)
- Custom gold cursor with trailing ring on desktop
- Generous white space — never cramped
- Thin gold horizontal lines as section dividers
- Section numbers: `01 — Section Name` (gold, Tenor Sans)
- Gold is NEVER used as background for large areas
- No bright colours — black, white, gold ONLY

### Animations
- Page load: staggered fade-up on hero elements (0.2s delays)
- Scroll: elements fade up using IntersectionObserver
- Hover on cards: translateY(-4px) + border brightens
- Loading states: horizontal gold progress bar animation

### Navigation (same on every page)
- Background: rgba(8,8,8,0.92) with backdrop-filter blur 24px
- Height: 80px, fixed top, z-index: 999
- Left: "G7 Capital" — Cormorant Garamond weight 300, letter-spacing 0.25em, "7" in gold
- Right: "Sign In" (grey) + "Request Access" (gold bg, black text)
- Mobile: hamburger → full-screen black overlay, z-index: 998

### Language Rules
- Never "sign up" — always "apply for access"
- Never "users" — always "members" or "firms"
- Never "AI tool" — always "AI employees" or "your AI team"
- Never "chatbot" — Alex is an analyst, not a chatbot

---

## 5. FILE STRUCTURE — CURRENT STATE

```
g7capital/
│
├── index.html              ✅ LIVE — Homepage
├── for-firms.html          ✅ BUILT — For PE/VC/IB firms page
│
├── workspace/              🔨 BUILDING NOW
│   ├── index.html          → Workspace dashboard (Step 7)
│   ├── onboard.html        → Firm setup page (Step 2)
│   ├── submit.html         → Deal submission (Step 3)
│   ├── result.html         → Alex's screening note output (Step 5)
│   └── history.html        → Deal history and search (Step 6)
│
├── assets/
│   ├── alex-master-v1.js   → Alex's complete system prompt as JS constant (Step 1)
│   ├── workspace.css       → Workspace-specific styles (built alongside pages)
│   └── workspace.js        → Shared JS functions including API call (Step 4)
│
└── config/
    └── firm-config.js      → Firm knowledge base template and localStorage helpers
```

### Known Issues to Avoid (learned from previous builds)
- Grain overlay: use `body::after` with z-index:1 NOT `body::before` with z-index:1000
- Hero animations: use `both` keyword not `forwards` in animation-fill-mode
- Reveal sections: use inline styles via JS, not class toggling
- Cursor: starts at left:-100px top:-100px, appears on first mousemove
- Mobile cursor: hide at max-width:480px not 768px
- Nav z-index: 999. Mobile menu: 998
- Always include calcSaving() function when calculator is present

---

## 6. ALEX — THE AI EMPLOYEE

### What Alex Is
Alex is a Deal Analyst AI employee. He is not a chatbot. He screens investment deals to institutional PE/VC standard and produces structured screening notes in a consistent professional format.

### The Three Training Files
Alex's brain lives in three files that have been combined into one master document:

**File: `assets/alex-master-v1.js`** (✅ BUILT)

This JS file exports a constant `ALEX_MASTER_PROMPT` containing:
1. System Prompt — Alex's identity, framework, 6-stage screening methodology, output format, scoring system, sector metrics library
2. Calibration System — 25 rules encoding experienced VC partner judgment (overrides generic analysis)
3. Training Library — 30 worked deals: 10 YES, 10 PASS, 10 WRONG CALLS with outcomes and lessons

The source text file is: `alex_master_v1.txt` (in outputs folder — 266KB, ~66,500 tokens)

### How the API Call Works
Every Alex API call has three parts assembled in this order:
```
SYSTEM PROMPT = ALEX_MASTER_PROMPT + '\n\n' + FIRM_KNOWLEDGE_BASE
USER MESSAGE  = Structured deal submission
```

`FIRM_KNOWLEDGE_BASE` is loaded from localStorage where it was saved during firm onboarding.

### The API Call Code Pattern
```javascript
async function callAlex(dealSubmission) {
  const systemPrompt = ALEX_MASTER_PROMPT + '\n\n' +
                       localStorage.getItem('g7_firm_knowledge_base');

  const userMessage = `
Please screen the following deal and produce a complete
G7 Workspace Deal Screening Note in your standard format.

COMPANY: ${dealSubmission.companyName}
SOURCE: ${dealSubmission.source}
SPECIFIC FOCUS: ${dealSubmission.partnerFocus || 'Standard full screening'}

DEAL MATERIALS:
${dealSubmission.content}
  `;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': localStorage.getItem('g7_api_key'),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-iab': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}
```

### localStorage Keys Used
```
g7_api_key              — Anthropic API key (entered by firm on first use)
g7_firm_knowledge_base  — Full firm KB text injected into every Alex call
g7_firm_config          — JSON object with firm configuration details
g7_deal_history         — JSON array of all deals screened with outputs
g7_calibration_log      — JSON array of partner corrections to Alex
g7_onboarded            — Boolean: has firm completed onboarding
```

---

## 7. FIRM KNOWLEDGE BASE — WHAT IT CONTAINS

When a firm completes onboarding, this text block is assembled and saved to localStorage as `g7_firm_knowledge_base`:

```
═══════════════════════════════════════════════════
FIRM KNOWLEDGE BASE — [FIRM NAME]
Injected into every Alex session
═══════════════════════════════════════════════════

FIRM NAME:            [firm name]
FIRM TYPE:            [PE / VC / IB / Merchant Bank]
FUND SIZE:            [amount]
STAGE FOCUS:          [stages]
SECTOR FOCUS:         [sectors]
GEOGRAPHY:            [regions]
TICKET SIZE:          [min] — [max]
RETURN TARGET:        [IRR or MOIC target]

INVESTMENT THESIS:
[Partner's own words]

HARD PASS CRITERIA:
[What firm will never invest in]

RECENT DEAL HISTORY:
[Up to 10 past deals with verdict and reason]

FIRM-SPECIFIC CALIBRATION NOTES:
[Partner corrections to Alex accumulated over time]

ACTIVE PIPELINE:
[Deals currently in process]
═══════════════════════════════════════════════════
```

---

## 8. BUILD SEQUENCE — ALL STEPS IN ORDER

### PHASE 1 — ALEX PROTOTYPE ✅ COMPLETE — 29 March 2026

**STEP 1 — Convert Alex Master to JS constant**
File: `assets/alex-master-v1.js`
Task: Create a JS file that exports `ALEX_MASTER_PROMPT` as a constant
containing the full text of `alex_master_v1.txt`
Status: ✅ COMPLETE — 29 March 2026

**STEP 2 — Firm Onboarding Page**
File: `workspace/onboard.html`
Task: Form page where firm enters their configuration.
Saves to localStorage on submit. Redirects to workspace dashboard.
Fields: firm name, type, stage, sector, geography, ticket size,
return target, investment thesis, hard pass criteria, recent deals
Status: ✅ COMPLETE — 29 March 2026

**STEP 3 — Deal Submission Interface**
File: `workspace/submit.html`
Task: Two input methods — text description OR PDF upload.
Additional fields: company name, deal source, partner focus notes.
On submit: calls Alex API, redirects to result page with output.
Status: ✅ COMPLETE — 29 March 2026

**STEP 4 — API Call Function and Shared JS**
File: `assets/workspace.js`
Task: Core JS file with callAlex(), saveDeal(), loadHistory(),
addCalibration(), and all shared localStorage helpers.
Status: ✅ COMPLETE — 29 March 2026

**STEP 5 — Result Display Page**
File: `workspace/result.html`
Task: Renders Alex's screening note beautifully in G7 design system.
Shows: status badge, G7 score ring, all sections, risk flags,
Narrative Drift Check, Thesis Dependency Chain, Alex's Note.
Two action buttons: Partner Agrees / Partner Disagrees.
Disagree flow: small form, saves to calibration log.
Status: ✅ COMPLETE — 29 March 2026 (parsing engine audited and fixed — 34/34 checks pass)

**STEP 6 — Deal History Page**
File: `workspace/history.html`
Task: Searchable table of all deals. Filter by status/score/date.
Shows calibration log. Links to full notes.
Status: ✅ COMPLETE — 29 March 2026

**STEP 7 — Workspace Dashboard**
File: `workspace/index.html`
Task: Main workspace hub. Shows firm name, quick stats, recent deals,
action buttons. Entry point for returning firms.
Status: ✅ COMPLETE — 29 March 2026

### PHASE 2 — PIPELINE (After Phase 1 is tested)

- Maya system prompt and DD memo interface
- David research request interface
- Stripe payment integration
- Proper multi-firm onboarding flow
- Connect workspace to for-firms.html marketing page

### PHASE 3 — PIPELINE (Later)

- workspace.html full page on main site
- how-it-works.html
- pricing.html
- community.html

---

## 9. CURRENT SESSION — WHAT TO BUILD TODAY

**Phase 1 is complete as of 29 March 2026.**
All 7 files built and verified — 128/128 audit checks passed.
One critical bug found and fixed during audit:
result.html section parser replaced with 4-state machine.

**Next session task:** End-to-end browser testing on live URL.
Then: Update CLAUDE.md with any bugs found during testing.
Then: Begin Phase 2 planning.

---

## 10. IMPORTANT CONTEXT — THE BUSINESS SITUATION

This prototype exists for one primary purpose right now:
**To show Christian (senior IB partner, BofA + Credit Suisse background,
building a merchant bank) that Alex does something ChatGPT cannot.**

Christian's feedback: "It's generic — I can do this with ChatGPT."
The prototype must answer this objection by demonstration, not explanation.

The demo plan:
1. Open workspace. Show firm configuration loaded.
2. Submit a real deal Christian knows from his pipeline.
3. Show Alex's output. Point out: firm thesis applied, deal history referenced,
   consistent format, Single Point of Failure identified.
4. Open raw Claude in another tab. Ask the same question.
5. The difference is obvious. That is the product.

This context should inform every design and UX decision.
The product must feel like an institutional tool, not a startup demo.
It must feel like something a firm would trust with real deal flow.

---

## 11. HOW TO UPDATE THIS FILE

At the end of every build session, update Section 8 (Build Sequence)
to reflect what was completed and what the current status is.
Update Section 9 (Current Session) to reflect the next task.

This file is the single source of truth for the build.
If it is up to date, every new Claude Code session starts with
full context and zero ramp-up time.

---

## 12. BUILD LOG

### SESSION 1 — 29 March 2026
Built: alex-master-v1.js, onboard.html, workspace.js,
submit.html, result.html, history.html, index.html
Bugs found and fixed: 1 (result.html section parser — replaced 2-state machine with 4-state machine)
Status: Phase 1 complete, pushed to GitHub

---

*G7 Capital — Private Equity. Powered by Intelligence.*
*Built by Pallav, solo founder, Gsevn Services*
