// ─── Onboard — LP Onboarding Platform ────────────────────────────────────────
// Roles: admin | gp | lp
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const jwt          = require("jsonwebtoken");
const bcrypt       = require("bcryptjs");
const cookieParser = require("cookie-parser");
const { Client }   = require("@notionhq/client");
const Anthropic    = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "onboard-jwt-secret-2026";

// ── Clients ──────────────────────────────────────────────────────────────────
const notion = process.env.NOTION_TOKEN
  ? new Client({ auth: process.env.NOTION_TOKEN })
  : null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

// ── DB IDs ───────────────────────────────────────────────────────────────────
const DB = {
  LP:    formatId(process.env.NOTION_DB_LP_PIPELINE      || "3f253f1689b74b58a5344ccd76600b49"),
  TASKS: formatId(process.env.NOTION_DB_COMPLIANCE_TASKS || "928b845946e649758dcb57ce4c1e16bc"),
  FUNDS: formatId(process.env.NOTION_DB_FUNDS            || "72f762bcff594eca8d95a44d1218b5aa"),
};

function formatId(id) {
  if (id.includes("-")) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Data helpers ─────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, "data");
const QUEUE_FILE = path.join(DATA_DIR, "submissions.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readQueue()     { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { return []; } }
function writeQueue(d)   { fs.writeFileSync(QUEUE_FILE, JSON.stringify(d, null, 2)); }
function addToQueue(r)   { const q = readQueue(); q.push(r); writeQueue(q); return r; }
function updateInQueue(id, patch) {
  const q = readQueue();
  const i = q.findIndex(r => r.id === id);
  if (i !== -1) { q[i] = { ...q[i], ...patch }; writeQueue(q); return q[i]; }
  return null;
}

function readUsers()     { try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return []; } }
function writeUsers(d)   { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }

// ── Seed admin ────────────────────────────────────────────────────────────────
function seedAdmin() {
  const users = readUsers();
  if (!users.find(u => u.email === "peter_fe@icloud.com")) {
    users.push({
      id:           "user-admin-001",
      email:        "peter_fe@icloud.com",
      name:         "Peter",
      role:         "admin",
      passwordHash: bcrypt.hashSync("Onboard2026!", 10),
      createdAt:    new Date().toISOString(),
    });
    writeUsers(users);
    console.log("  🔐 Admin seeded: peter_fe@icloud.com / Onboard2026!");
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "24h" });
}

function requireAuth(...roles) {
  return (req, res, next) => {
    const token = req.cookies?.token || (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) {
      if (req.accepts("html")) return res.redirect(`/login?redirect=${encodeURIComponent(req.path)}`);
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: "Forbidden — insufficient role" });
      }
      req.user = decoded;
      next();
    } catch {
      if (req.accepts("html")) return res.redirect(`/login?redirect=${encodeURIComponent(req.path)}`);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

// ── Claude review ─────────────────────────────────────────────────────────────
function buildReviewPrompt(lp) {
  const jurisDoc = lp.jurisdiction === "UK" ? "FCA investor categorisation, CASS acknowledgment"
    : lp.jurisdiction === "CH" ? "FIDLEG suitability assessment, beneficial ownership declaration"
    : "AIFMD suitability assessment, FATCA/CRS self-certification";
  return `You are Onboard's AI compliance reviewer for a European alternative asset fund.

Review this LP onboarding submission and return a JSON object (no other text):

LP SUBMISSION:
- Name: ${lp.lpName}
- Email: ${lp.email}
- Nationality: ${lp.nationality}
- Jurisdiction: ${lp.jurisdiction || "EU"}
- Investor Type: ${lp.investorType}
- Committed Amount: €${lp.committedAmount}k
- Fund: ${lp.fund}
- Source of Wealth: ${lp.sourceOfWealth}
- PEP Declaration: ${lp.pepStatus}
- KYC Documents: ${lp.kycDocs ? "Confirmed" : "Not confirmed"}
- Proof of Address: ${lp.proofOfAddress ? "Provided" : "Missing"}
- Subscription Doc: ${lp.subDocSigned ? "Signed" : "Not signed"}
- Suitability Assessment: ${lp.suitabilityDone ? "Completed" : "Missing"}
- FATCA/CRS: ${lp.fatcaCrs ? "Provided" : "Missing"}
- Jurisdiction-specific docs: ${jurisDoc}
- Additional Notes: ${lp.notes || "None"}

Return ONLY this JSON (no markdown):
{
  "score": <0-100>,
  "pep_status": "<Not PEP|PEP|Pending Check>",
  "sanctions_clear": "<Clear|Flagged|Pending>",
  "missing_items": "<comma-separated list or 'None'>",
  "summary": "<2-3 sentence compliance summary>",
  "recommendation": "<Approve|Further Review Required|Reject>",
  "next_status": "<Under Review|Legal Check|Compliance Check|Rejected>"
}`;
}

async function reviewWithClaude(lp) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { score: 70, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "Claude review unavailable — add ANTHROPIC_API_KEY",
      summary: "Automated review pending. Please configure ANTHROPIC_API_KEY.",
      recommendation: "Further Review Required", next_status: "Under Review" };
  }
  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-6", max_tokens: 600,
      messages: [{ role: "user", content: buildReviewPrompt(lp) }]
    });
    return JSON.parse(msg.content[0].text.trim());
  } catch (e) {
    console.error("Claude review error:", e.message);
    return { score: 50, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "Review error: " + e.message,
      summary: "Automated review encountered an error. Manual review required.",
      recommendation: "Further Review Required", next_status: "Under Review" };
  }
}

// ── Notion helpers ────────────────────────────────────────────────────────────
async function createNotionLP(lp, review) {
  if (!notion) return null;
  try {
    const page = await notion.pages.create({
      parent: { database_id: DB.LP },
      properties: {
        "LP Name":                 { title: [{ text: { content: lp.lpName } }] },
        "Email":                   { email: lp.email },
        "Nationality":             { rich_text: [{ text: { content: lp.nationality } }] },
        "Investor Type":           { select: { name: lp.investorType } },
        "Committed Amount (€k)":   { number: parseFloat(lp.committedAmount) || 0 },
        "Fund":                    { rich_text: [{ text: { content: lp.fund } }] },
        "Status":                  { select: { name: review.next_status || "Under Review" } },
        "Onboarding Score":        { number: review.score || 0 },
        "Missing Items":           { rich_text: [{ text: { content: review.missing_items || "" } }] },
        "Claude Summary":          { rich_text: [{ text: { content: review.summary || "" } }] },
        "Source of Wealth":        { rich_text: [{ text: { content: lp.sourceOfWealth || "" } }] },
        "PEP Status":              { select: { name: review.pep_status || "Pending Check" } },
        "Sanctions Clear":         { select: { name: review.sanctions_clear || "Pending" } },
        "KYC Docs Received":       { checkbox: !!lp.kycDocs },
        "Subscription Doc Signed": { checkbox: !!lp.subDocSigned },
        "Submitted At":            { date: { start: new Date().toISOString().split("T")[0] } },
      }
    });
    return page.id;
  } catch (e) { console.error("Notion LP error:", e.message); return null; }
}

async function createComplianceTasks(lp, lpNotionId) {
  if (!notion) return;
  const due = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const baseTasks = [
    { task: `KYC Verification — ${lp.lpName}`,         team: "Legal",      type: "KYC Verification",        priority: "High" },
    { task: `AML / Sanctions Check — ${lp.lpName}`,    team: "Compliance", type: "AML / Sanctions Check",   priority: "High" },
    { task: `PEP Screening — ${lp.lpName}`,            team: "Compliance", type: "PEP Screening",           priority: "High" },
    { task: `Subscription Doc Review — ${lp.lpName}`,  team: "Legal",      type: "Subscription Doc Review", priority: "Medium" },
    { task: `Source of Wealth Check — ${lp.lpName}`,   team: "Compliance", type: "Source of Wealth Check",  priority: "Medium" },
    { task: `Cap Table Update — ${lp.lpName}`,         team: "Finance",    type: "Cap Table Update",        priority: "Low" },
  ];
  // Add jurisdiction-specific tasks
  if (lp.jurisdiction === "UK") {
    baseTasks.push({ task: `FCA Categorisation — ${lp.lpName}`, team: "Legal", type: "FCA Categorisation", priority: "High" });
  } else if (lp.jurisdiction === "CH") {
    baseTasks.push({ task: `FIDLEG Suitability — ${lp.lpName}`, team: "Legal", type: "FIDLEG Assessment",  priority: "High" });
  } else {
    baseTasks.push({ task: `AIFMD Suitability — ${lp.lpName}`,  team: "Legal", type: "AIFMD Suitability",  priority: "High" });
  }

  for (const t of baseTasks) {
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
    } catch (e) { console.error("Task create error:", e.message); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /login
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.email?.toLowerCase() === email?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, maxAge: 86400000, sameSite: "lax" });
  res.json({ ok: true, role: user.role, name: user.name, redirect: req.body.redirect || "/" });
});

// POST /auth/logout
app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// GET /auth/me
app.get("/auth/me", requireAuth(), (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role });
});

// ── User management (admin only) ──────────────────────────────────────────────

// GET /api/users
app.get("/api/users", requireAuth("admin"), (req, res) => {
  const users = readUsers().map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt }));
  res.json(users);
});

// POST /api/users — create user
app.post("/api/users", requireAuth("admin"), async (req, res) => {
  const { email, name, role, password } = req.body;
  if (!email || !name || !role || !password) return res.status(400).json({ error: "Missing fields" });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Email already exists" });
  }
  const user = {
    id:           "user-" + Date.now(),
    email, name, role,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt:    new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  res.json({ ok: true, id: user.id });
});

// PUT /api/users/:id — update role
app.put("/api/users/:id", requireAuth("admin"), (req, res) => {
  const users = readUsers();
  const i = users.findIndex(u => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "User not found" });
  if (req.body.role)  users[i].role = req.body.role;
  if (req.body.name)  users[i].name = req.body.name;
  if (req.body.password) users[i].passwordHash = bcrypt.hashSync(req.body.password, 10);
  writeUsers(users);
  res.json({ ok: true });
});

// DELETE /api/users/:id
app.delete("/api/users/:id", requireAuth("admin"), (req, res) => {
  if (req.params.id === "user-admin-001") return res.status(403).json({ error: "Cannot delete primary admin" });
  let users = readUsers();
  users = users.filter(u => u.id !== req.params.id);
  writeUsers(users);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /  → LP onboarding form (public — anyone can start onboarding)
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// GET /status → LP status portal (public with LP ID)
app.get("/status", (req, res) => res.sendFile(path.join(__dirname, "public", "status.html")));

// GET /gp → GP dashboard (requires gp or admin)
app.get("/gp", requireAuth("gp", "admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "gp.html")));

// GET /admin → Admin user management (requires admin)
app.get("/admin", requireAuth("admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMISSION ROUTE
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/submit", async (req, res) => {
  const lp = {
    id:               "LP-" + Date.now(),
    submittedAt:      new Date().toISOString(),
    lpName:           req.body.lpName || "",
    email:            req.body.email || "",
    nationality:      req.body.nationality || "",
    jurisdiction:     req.body.jurisdiction || "EU",
    investorType:     req.body.investorType || "",
    committedAmount:  req.body.committedAmount || "0",
    fund:             req.body.fund || "Felten Capital Fund I",
    sourceOfWealth:   req.body.sourceOfWealth || "",
    pepStatus:        req.body.pepStatus || "No",
    kycDocs:          req.body.kycDocs === "on" || req.body.kycDocs === true,
    proofOfAddress:   req.body.proofOfAddress === "on" || req.body.proofOfAddress === true,
    subDocSigned:     req.body.subDocSigned === "on" || req.body.subDocSigned === true,
    suitabilityDone:  req.body.suitabilityDone === "on" || req.body.suitabilityDone === true,
    fatcaCrs:         req.body.fatcaCrs === "on" || req.body.fatcaCrs === true,
    notes:            req.body.notes || "",
    status:           "Form Submitted",
    review:           null,
  };

  console.log(`\n[${new Date().toLocaleTimeString()}] New LP: ${lp.lpName} (${lp.email}) — ${lp.jurisdiction}`);

  const review = await reviewWithClaude(lp);
  lp.review = review;
  lp.status = review.next_status || "Under Review";
  console.log(`  Claude: score=${review.score}, rec=${review.recommendation}`);

  addToQueue(lp);

  // Auto-create LP user account
  const users = readUsers();
  if (!users.find(u => u.email.toLowerCase() === lp.email.toLowerCase())) {
    const tempPwd = "LP-" + lp.id.slice(-6);
    users.push({ id: "user-lp-" + Date.now(), email: lp.email, name: lp.lpName,
      role: "lp", lpId: lp.id, passwordHash: bcrypt.hashSync(tempPwd, 10), createdAt: new Date().toISOString() });
    writeUsers(users);
    lp.tempPassword = tempPwd;
    console.log(`  LP user account created: ${lp.email} / ${tempPwd}`);
  }

  const notionPageId = await createNotionLP(lp, review);
  if (notionPageId) {
    lp.notionId = notionPageId;
    await createComplianceTasks(lp, notionPageId);
    console.log(`  Notion synced + compliance tasks routed`);
  }

  res.json({
    success: true, lpId: lp.id, status: lp.status,
    score: review.score, recommendation: review.recommendation,
    summary: review.summary, missingItems: review.missing_items,
    notionCreated: !!notionPageId, tempPassword: lp.tempPassword || null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GP/admin: all LPs
app.get("/api/all-lps",   requireAuth("gp", "admin"), (req, res) => res.json(readQueue()));

// GP/admin: dashboard stats
app.get("/api/dashboard", requireAuth("gp", "admin"), (req, res) => {
  const submissions = readQueue();
  const stats = { total: submissions.length, byStatus: {}, avgScore: 0, recentSubmissions: submissions.slice(-5).reverse() };
  submissions.forEach(s => {
    stats.byStatus[s.status] = (stats.byStatus[s.status] || 0) + 1;
    stats.avgScore += (s.review?.score || 0);
  });
  if (submissions.length) stats.avgScore = Math.round(stats.avgScore / submissions.length);
  res.json(stats);
});

// Public: LP status by ID
app.get("/api/status/:id", (req, res) => {
  const lp = readQueue().find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  // Return safe subset for public
  const { id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review } = lp;
  res.json({ id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review });
});

// Admin: update LP status
app.put("/api/lp/:id/status", requireAuth("gp", "admin"), (req, res) => {
  const updated = updateInQueue(req.params.id, { status: req.body.status });
  if (!updated) return res.status(404).json({ error: "LP not found" });
  res.json({ ok: true, status: updated.status });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", notion: !!notion, claude: !!process.env.ANTHROPIC_API_KEY });
});

// ── Start ─────────────────────────────────────────────────────────────────────
seedAdmin();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Onboard is running → http://localhost:${PORT}`);
  console.log(`   LP Form:    http://localhost:${PORT}/`);
  console.log(`   GP Board:   http://localhost:${PORT}/gp`);
  console.log(`   Admin:      http://localhost:${PORT}/admin`);
  console.log(`   Login:      http://localhost:${PORT}/login`);
  console.log(`\n   Notion: ${notion ? "✅ connected" : "⚠️  not configured"}`);
  console.log(`   Claude: ${process.env.ANTHROPIC_API_KEY ? "✅ connected" : "⚠️  not configured"}\n`);
});
