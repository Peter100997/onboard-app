// ─── Onboard — LP Onboarding Platform ────────────────────────────────────────
// Node.js / Express server
// Routes:  GET  /              → LP onboarding form
//          POST /submit        → save + Notion + Claude review
//          GET  /status        → LP status portal
//          GET  /gp            → GP dashboard
//          GET  /api/status/:id→ JSON status for LP
//          GET  /api/dashboard → JSON GP dashboard data
//          POST /api/review/:id→ trigger Claude review of LP record
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const { Client } = require("@notionhq/client");
const Anthropic  = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Clients ──────────────────────────────────────────────────────────────────
const notion = process.env.NOTION_TOKEN
  ? new Client({ auth: process.env.NOTION_TOKEN })
  : null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ── DB IDs ───────────────────────────────────────────────────────────────────
const DB = {
  LP:    formatId(process.env.NOTION_DB_LP_PIPELINE     || "3f253f1689b74b58a5344ccd76600b49"),
  TASKS: formatId(process.env.NOTION_DB_COMPLIANCE_TASKS || "928b845946e649758dcb57ce4c1e16bc"),
  FUNDS: formatId(process.env.NOTION_DB_FUNDS            || "72f762bcff594eca8d95a44d1218b5aa"),
};

function formatId(id) {
  // Convert 32-char hex to UUID format if needed
  if (id.includes("-")) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Local queue (fallback if no Notion token) ────────────────────────────────
const QUEUE_FILE = path.join(__dirname, "data", "submissions.json");
function readQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); }
  catch { return []; }
}
function writeQueue(data) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
}
function addToQueue(record) {
  const q = readQueue();
  q.push(record);
  writeQueue(q);
  return record;
}

// ── Claude review prompt ─────────────────────────────────────────────────────
function buildReviewPrompt(lp) {
  return `You are Onboard's AI compliance reviewer for a European alternative asset fund.

Review this LP onboarding submission and return a JSON object (no other text):

LP SUBMISSION:
- Name: ${lp.lpName}
- Email: ${lp.email}
- Nationality: ${lp.nationality}
- Investor Type: ${lp.investorType}
- Committed Amount: €${lp.committedAmount}k
- Fund: ${lp.fund}
- Source of Wealth: ${lp.sourceOfWealth}
- PEP Declaration: ${lp.pepStatus}
- KYC Documents: ${lp.kycDocs ? "Confirmed" : "Not confirmed"}
- Subscription Doc Signed: ${lp.subDocSigned ? "Yes" : "No"}
- Additional Notes: ${lp.notes || "None"}

Return ONLY this JSON (no markdown, no explanation):
{
  "score": <0-100 integer, completeness + risk score>,
  "pep_status": "<Not PEP|PEP|Pending Check>",
  "sanctions_clear": "<Clear|Flagged|Pending>",
  "missing_items": "<comma-separated list of missing or flagged items, or 'None'>",
  "summary": "<2-3 sentence professional compliance summary for the GP operations team>",
  "recommendation": "<Approve|Further Review Required|Reject>",
  "next_status": "<Under Review|Legal Check|Compliance Check|Rejected>"
}`;
}

// ── Claude review ─────────────────────────────────────────────────────────────
async function reviewWithClaude(lp) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      score: 70,
      pep_status: "Pending Check",
      sanctions_clear: "Pending",
      missing_items: "Claude review unavailable — add ANTHROPIC_API_KEY to .env",
      summary: "Automated review pending. Please configure ANTHROPIC_API_KEY.",
      recommendation: "Further Review Required",
      next_status: "Under Review"
    };
  }
  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: buildReviewPrompt(lp) }]
    });
    const text = msg.content[0].text.trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Claude review error:", e.message);
    return {
      score: 50,
      pep_status: "Pending Check",
      sanctions_clear: "Pending",
      missing_items: "Review error: " + e.message,
      summary: "Automated review encountered an error. Manual review required.",
      recommendation: "Further Review Required",
      next_status: "Under Review"
    };
  }
}

// ── Notion: create LP record ──────────────────────────────────────────────────
async function createNotionLP(lp, review) {
  if (!notion) return null;
  try {
    const page = await notion.pages.create({
      parent: { database_id: DB.LP },
      properties: {
        "LP Name":                  { title: [{ text: { content: lp.lpName } }] },
        "Email":                    { email: lp.email },
        "Nationality":              { rich_text: [{ text: { content: lp.nationality } }] },
        "Investor Type":            { select: { name: lp.investorType } },
        "Committed Amount (€k)":    { number: parseFloat(lp.committedAmount) || 0 },
        "Fund":                     { rich_text: [{ text: { content: lp.fund } }] },
        "Status":                   { select: { name: review.next_status || "Under Review" } },
        "Onboarding Score":         { number: review.score || 0 },
        "Missing Items":            { rich_text: [{ text: { content: review.missing_items || "" } }] },
        "Claude Summary":           { rich_text: [{ text: { content: review.summary || "" } }] },
        "Source of Wealth":         { rich_text: [{ text: { content: lp.sourceOfWealth || "" } }] },
        "PEP Status":               { select: { name: review.pep_status || "Pending Check" } },
        "Sanctions Clear":          { select: { name: review.sanctions_clear || "Pending" } },
        "KYC Docs Received":        { checkbox: !!lp.kycDocs },
        "Subscription Doc Signed":  { checkbox: !!lp.subDocSigned },
        "Submitted At":             { date: { start: new Date().toISOString().split("T")[0] } },
      }
    });
    return page.id;
  } catch (e) {
    console.error("Notion LP create error:", e.message);
    return null;
  }
}

// ── Notion: create compliance tasks ──────────────────────────────────────────
async function createComplianceTasks(lp, lpNotionId) {
  if (!notion) return;
  const today = new Date().toISOString().split("T")[0];
  const due = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const tasks = [
    { task: `KYC Verification — ${lp.lpName}`,          team: "Legal",      type: "KYC Verification",          priority: "High" },
    { task: `AML / Sanctions Check — ${lp.lpName}`,     team: "Compliance", type: "AML / Sanctions Check",     priority: "High" },
    { task: `PEP Screening — ${lp.lpName}`,             team: "Compliance", type: "PEP Screening",             priority: "High" },
    { task: `Subscription Doc Review — ${lp.lpName}`,   team: "Legal",      type: "Subscription Doc Review",   priority: "Medium" },
    { task: `Source of Wealth Check — ${lp.lpName}`,    team: "Compliance", type: "Source of Wealth Check",    priority: "Medium" },
    { task: `Cap Table Update — ${lp.lpName}`,          team: "Finance",    type: "Cap Table Update",          priority: "Low" },
  ];

  for (const t of tasks) {
    try {
      await notion.pages.create({
        parent: { database_id: DB.TASKS },
        properties: {
          "Task":      { title: [{ text: { content: t.task } }] },
          "LP Name":   { rich_text: [{ text: { content: lp.lpName } }] },
          "LP ID":     { rich_text: [{ text: { content: lpNotionId || lp.id || "" } }] },
          "Team":      { select: { name: t.team } },
          "Task Type": { select: { name: t.type } },
          "Status":    { select: { name: "Pending" } },
          "Priority":  { select: { name: t.priority } },
          "Due Date":  { date: { start: due } },
        }
      });
    } catch (e) {
      console.error("Task create error:", e.message);
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET / → serve LP form
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// GET /status → serve status portal
app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "status.html"));
});

// GET /gp → serve GP dashboard
app.get("/gp", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "gp.html"));
});

// POST /submit → process LP submission
app.post("/submit", async (req, res) => {
  const lp = {
    id:               "LP-" + Date.now(),
    submittedAt:      new Date().toISOString(),
    lpName:           req.body.lpName || "",
    email:            req.body.email || "",
    nationality:      req.body.nationality || "",
    investorType:     req.body.investorType || "",
    committedAmount:  req.body.committedAmount || "0",
    fund:             req.body.fund || "Felten Capital Fund I",
    sourceOfWealth:   req.body.sourceOfWealth || "",
    pepStatus:        req.body.pepStatus || "No",
    kycDocs:          req.body.kycDocs === "on" || req.body.kycDocs === true,
    subDocSigned:     req.body.subDocSigned === "on" || req.body.subDocSigned === true,
    notes:            req.body.notes || "",
    status:           "Form Submitted",
    review:           null,
  };

  console.log(`\n[${new Date().toLocaleTimeString()}] New LP submission: ${lp.lpName} (${lp.email})`);

  // 1. Claude review (async, non-blocking for UX)
  const review = await reviewWithClaude(lp);
  lp.review = review;
  lp.status = review.next_status || "Under Review";
  console.log(`  Claude review: score=${review.score}, rec=${review.recommendation}`);

  // 2. Save to local queue
  addToQueue(lp);

  // 3. Create Notion record
  const notionPageId = await createNotionLP(lp, review);
  if (notionPageId) {
    lp.notionId = notionPageId;
    console.log(`  Notion LP created: ${notionPageId}`);
    // 4. Create compliance tasks
    await createComplianceTasks(lp, notionPageId);
    console.log(`  Compliance tasks routed to Legal / Compliance / Finance`);
  } else {
    console.log("  Notion not configured — saved to local queue");
  }

  res.json({
    success: true,
    lpId: lp.id,
    status: lp.status,
    score: review.score,
    recommendation: review.recommendation,
    summary: review.summary,
    missingItems: review.missing_items,
    notionCreated: !!notionPageId,
  });
});

// GET /api/status/:id → JSON for LP status portal
app.get("/api/status/:id", (req, res) => {
  const q = readQueue();
  const lp = q.find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  res.json(lp);
});

// GET /api/all-lps → full LP list for GP dashboard
app.get("/api/all-lps", (req, res) => {
  res.json(readQueue());
});

// GET /api/dashboard → JSON for GP dashboard
app.get("/api/dashboard", (req, res) => {
  const submissions = readQueue();
  const stats = {
    total: submissions.length,
    byStatus: {},
    avgScore: 0,
    recentSubmissions: submissions.slice(-5).reverse(),
  };
  submissions.forEach(s => {
    stats.byStatus[s.status] = (stats.byStatus[s.status] || 0) + 1;
    stats.avgScore += (s.review?.score || 0);
  });
  if (submissions.length) stats.avgScore = Math.round(stats.avgScore / submissions.length);
  res.json(stats);
});

// ── Health check (Railway) ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", notion: !!notion, claude: !!process.env.ANTHROPIC_API_KEY });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Onboard is running → http://localhost:${PORT}`);
  console.log(`   LP Form:       http://localhost:${PORT}/`);
  console.log(`   LP Status:     http://localhost:${PORT}/status?id=LP-xxxxx`);
  console.log(`   GP Dashboard:  http://localhost:${PORT}/gp`);
  console.log(`\n   Notion: ${notion ? "✅ connected" : "⚠️  not configured (add NOTION_TOKEN to .env)"}`);
  console.log(`   Claude: ${process.env.ANTHROPIC_API_KEY ? "✅ connected" : "⚠️  not configured (add ANTHROPIC_API_KEY to .env)"}\n`);
});
