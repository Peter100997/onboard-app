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

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

function readUsers()   { try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return []; } }
function writeUsers(d) { fs.writeFileSync(USERS_FILE, JSON.stringify(d, null, 2)); }

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

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE CHECKLIST SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// Base checklist by jurisdiction — deterministic, regulation-mapped
function buildBaseChecklist(lp) {
  const jur = lp.jurisdiction || "EU";
  const isInstitutional = ["Institutional", "Corporate", "Fund of Funds"].includes(lp.investorType);
  const isPEP = lp.pepStatus === "Yes";

  // Core items — all jurisdictions
  const items = [
    // ── Identity & KYC
    { id: "kyc-001", category: "Identity & KYC",    item: "Passport / National ID",                required: true,  ref: "EU 5th AMLD Art.13 / FATF R.10",    status: "Pending" },
    { id: "kyc-002", category: "Identity & KYC",    item: "Proof of Address",                      required: true,  ref: "EU 5th AMLD Art.13 / FATF R.10",    status: "Pending" },
    { id: "kyc-003", category: "Identity & KYC",    item: "Identity Verification Complete",         required: true,  ref: "AML Directive / FATF Rec. 10",       status: "Pending" },

    // ── Source of Wealth
    { id: "sow-001", category: "Source of Wealth",  item: "Source of Wealth Declaration",          required: true,  ref: "FATF Rec. 12 / AMLD Art.20",         status: "Pending" },
    { id: "sow-002", category: "Source of Wealth",  item: "Source of Wealth Evidence Reviewed",    required: true,  ref: "FATF Rec. 12",                       status: "Pending" },
    { id: "sow-003", category: "Source of Wealth",  item: "Funds Origin Verified",                 required: true,  ref: "FATF Rec. 12 / Art. 18 AMLD",        status: "Pending" },

    // ── AML / Sanctions
    { id: "aml-001", category: "AML & Sanctions",   item: "AML Risk Assessment",                   required: true,  ref: "EU 5th AMLD Art.6",                  status: "Pending" },
    { id: "aml-002", category: "AML & Sanctions",   item: "Sanctions Screening (EU/UN/OFAC/HMT)",  required: true,  ref: "EU Reg. 2580/2001 / OFAC",           status: "Pending" },
    { id: "aml-003", category: "AML & Sanctions",   item: "Adverse Media Check",                   required: true,  ref: "FATF Guidance / EBA AML Guidelines", status: "Pending" },

    // ── PEP
    { id: "pep-001", category: "PEP Screening",     item: "PEP Status Verified",                   required: true,  ref: "EU 5th AMLD Art.20",                 status: "Pending" },
    ...(isPEP ? [
      { id: "pep-002", category: "PEP Screening",   item: "Enhanced Due Diligence — PEP",          required: true,  ref: "EU 5th AMLD Art.20(2)",              status: "Pending" },
      { id: "pep-003", category: "PEP Screening",   item: "Senior Management Approval — PEP",      required: true,  ref: "EU 5th AMLD Art.20(2)(b)",           status: "Pending" },
    ] : []),

    // ── Subscription
    { id: "sub-001", category: "Subscription",      item: "Subscription Agreement Signed",         required: true,  ref: "Fund Constitution / LP Agreement",   status: "Pending" },
    { id: "sub-002", category: "Subscription",      item: "FATCA / CRS Self-Certification",        required: true,  ref: "OECD CRS / US IRC §1471",            status: "Pending" },
  ];

  // Institutional extras
  if (isInstitutional) {
    items.push(
      { id: "inst-001", category: "Corporate KYC",  item: "Certificate of Incorporation",          required: true,  ref: "EU 5th AMLD Art.13(1)(b)",           status: "Pending" },
      { id: "inst-002", category: "Corporate KYC",  item: "Register of Directors / UBOs",          required: true,  ref: "EU 5th AMLD Art.30",                 status: "Pending" },
      { id: "inst-003", category: "Corporate KYC",  item: "Beneficial Owner KYC (≥25% threshold)", required: true,  ref: "EU 5th AMLD Art.30",                 status: "Pending" },
      { id: "inst-004", category: "Corporate KYC",  item: "LEI Number",                            required: true,  ref: "EMIR Art.9 / AIFMD Reporting",       status: "Pending" },
      { id: "inst-005", category: "Corporate KYC",  item: "Board Resolution / Signing Authority",  required: true,  ref: "Fund Constitution",                  status: "Pending" },
    );
  }

  // Jurisdiction-specific items
  if (jur === "EU") {
    items.push(
      { id: "eu-001", category: "EU / AIFMD",        item: "AIFMD Suitability Assessment (Art.9)", required: true,  ref: "AIFMD 2011/61/EU Art.9",             status: "Pending" },
      { id: "eu-002", category: "EU / AIFMD",        item: "Investor Categorisation (Professional/Retail)", required: true, ref: "MiFID II / AIFMD",           status: "Pending" },
      { id: "eu-003", category: "EU / AIFMD",        item: "CSSF Suitability Questionnaire",       required: lp.nationality === "Luxembourg", ref: "CSSF Circular 18/698", status: "Pending" },
      { id: "eu-004", category: "EU / AIFMD",        item: "AIFMD Disclosure Documents Acknowledged", required: true, ref: "AIFMD Art.23",                    status: "Pending" },
      { id: "eu-005", category: "EU / AIFMD",        item: "GDPR Consent / Data Processing Agreement", required: true, ref: "GDPR Art.6 / Art.9",             status: "Pending" },
    );
  } else if (jur === "UK") {
    items.push(
      { id: "uk-001", category: "UK / FCA",           item: "FCA Investor Categorisation Form",    required: true,  ref: "FCA COBS 3.5",                       status: "Pending" },
      { id: "uk-002", category: "UK / FCA",           item: "Elective Professional Client Opt-Up", required: false, ref: "FCA COBS 3.5.3",                    status: "Pending" },
      { id: "uk-003", category: "UK / FCA",           item: "FSMA s.21 Financial Promotion Acknowledgment", required: true, ref: "FSMA 2000 s.21",            status: "Pending" },
      { id: "uk-004", category: "UK / FCA",           item: "CASS Client Money Protection Acknowledgment", required: true, ref: "FCA CASS 7",                status: "Pending" },
      { id: "uk-005", category: "UK / FCA",           item: "Appropriateness Assessment Complete", required: true,  ref: "FCA COBS 10",                        status: "Pending" },
      { id: "uk-006", category: "UK / FCA",           item: "UK GDPR Consent / Privacy Notice",   required: true,  ref: "UK GDPR / DPA 2018",                 status: "Pending" },
    );
  } else if (jur === "CH") {
    items.push(
      { id: "ch-001", category: "Switzerland / FINMA", item: "FIDLEG Suitability Assessment",       required: true,  ref: "FinSA Art.10 / FIDLEG",              status: "Pending" },
      { id: "ch-002", category: "Switzerland / FINMA", item: "Beneficial Ownership Form A (AMLA)",  required: true,  ref: "GwG Art.4 / Form A",                 status: "Pending" },
      { id: "ch-003", category: "Switzerland / FINMA", item: "CISA Art.10(3) Qualified Investor Declaration", required: true, ref: "CISA Art.10(3)(b)(c)",     status: "Pending" },
      { id: "ch-004", category: "Switzerland / FINMA", item: "FinSA Client Segmentation",          required: true,  ref: "FinSA Art.4",                        status: "Pending" },
      { id: "ch-005", category: "Switzerland / FINMA", item: "VQF / SELF Regulation Compliance",   required: false, ref: "GwG Art.24 VQF",                     status: "Pending" },
      { id: "ch-006", category: "Switzerland / FINMA", item: "AEOI / CRS Self-Certification (ESTV)", required: true, ref: "AIA-Gesetz / OECD CRS",             status: "Pending" },
    );
  } else {
    items.push(
      { id: "int-001", category: "International",     item: "AML/KYC Questionnaire",               required: true,  ref: "FATF Recommendations",               status: "Pending" },
      { id: "int-002", category: "International",     item: "Bank Reference Letter",               required: true,  ref: "FATF Rec. 10 / Internal Policy",     status: "Pending" },
      { id: "int-003", category: "International",     item: "W-8BEN or W-9 (US Tax)",             required: true,  ref: "US IRC §1441 / FATCA",               status: "Pending" },
      { id: "int-004", category: "International",     item: "Country Risk Assessment",             required: true,  ref: "FATF Country Risk / Internal Policy", status: "Pending" },
    );
  }

  // Mark already-confirmed items from submission
  return items.map(item => {
    let prefilled = "Pending";
    if (item.id === "kyc-001" && lp.kycDocs)          prefilled = "Received";
    if (item.id === "sub-001" && lp.subDocSigned)     prefilled = "Received";
    if (item.id === "sub-002" && lp.fatcaCrs)         prefilled = "Received";
    if (item.id === "pep-001")                        prefilled = lp.pepStatus === "No" ? "Verified" : "Received";
    if (item.id === "sow-001" && lp.sourceOfWealth)   prefilled = "Received";
    if (prefilled !== "Pending") item.status = prefilled;
    return { ...item, gpNotes: "", verifiedBy: null, verifiedAt: null };
  });
}

// ── Claude review ─────────────────────────────────────────────────────────────
function buildReviewPrompt(lp) {
  const jurisDoc = lp.jurisdiction === "UK" ? "FCA investor categorisation, CASS acknowledgment, FSMA s.21"
    : lp.jurisdiction === "CH" ? "FIDLEG suitability, AMLA beneficial ownership form, CISA Art.10 QIA"
    : lp.jurisdiction === "CH" ? "FIDLEG suitability, AMLA BO Form, CISA Art.10 QIA"
    : "AIFMD Art.23 suitability, CSSF questionnaire, FATCA/CRS";
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
- KYC Documents: ${lp.kycDocs ? "Confirmed by LP" : "Not yet confirmed"}
- Subscription Doc: ${lp.subDocSigned ? "Signed" : "Not yet signed"}
- Jurisdiction docs required: ${jurisDoc}
- Additional Notes: ${lp.notes || "None"}

Return ONLY this JSON (no markdown, no explanation):
{
  "score": <0-100>,
  "pep_status": "<Not PEP|PEP — Enhanced DD Required|Pending Check>",
  "sanctions_clear": "<Clear|Flagged|Pending>",
  "missing_items": "<comma-separated list of missing items, or 'None'>",
  "summary": "<2-3 sentence professional compliance summary>",
  "recommendation": "<Approve|Further Review Required|Reject>",
  "next_status": "<Under Review|Legal Check|Compliance Check|Rejected>"
}`;
}

async function reviewWithClaude(lp) {
  if (!anthropic) {
    return {
      score: 65, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "ANTHROPIC_API_KEY not configured — manual review required",
      summary: "Automated AI review is unavailable. Please configure the ANTHROPIC_API_KEY environment variable in Railway settings.",
      recommendation: "Further Review Required", next_status: "Under Review"
    };
  }
  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-6", max_tokens: 600,
      messages: [{ role: "user", content: buildReviewPrompt(lp) }]
    });
    const text = msg.content[0].text.trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Claude review error:", e.message);
    // Don't expose raw API errors to client
    return {
      score: 50, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "Automated review failed — manual review required",
      summary: "AI review encountered a configuration error. Please verify the ANTHROPIC_API_KEY in Railway environment variables and retry.",
      recommendation: "Further Review Required", next_status: "Under Review"
    };
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

app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

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

app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth(), (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role });
});

// ── User management (admin only) ──────────────────────────────────────────────

app.get("/api/users", requireAuth("admin"), (req, res) => {
  const users = readUsers().map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt }));
  res.json(users);
});

app.post("/api/users", requireAuth("admin"), async (req, res) => {
  const { email, name, role, password } = req.body;
  if (!email || !name || !role || !password) return res.status(400).json({ error: "Missing fields" });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Email already exists" });
  }
  const user = {
    id: "user-" + Date.now(), email, name, role,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  res.json({ ok: true, id: user.id });
});

app.put("/api/users/:id", requireAuth("admin"), (req, res) => {
  const users = readUsers();
  const i = users.findIndex(u => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "User not found" });
  if (req.body.role)     users[i].role = req.body.role;
  if (req.body.name)     users[i].name = req.body.name;
  if (req.body.password) users[i].passwordHash = bcrypt.hashSync(req.body.password, 10);
  writeUsers(users);
  res.json({ ok: true });
});

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

app.get("/",       (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/status", (req, res) => res.sendFile(path.join(__dirname, "public", "status.html")));
app.get("/gp",     requireAuth("gp", "admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "gp.html")));
app.get("/admin",  requireAuth("admin"),        (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMISSION ROUTE
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/submit", async (req, res) => {
  const lp = {
    id:              "LP-" + Date.now(),
    submittedAt:     new Date().toISOString(),
    lpName:          req.body.lpName || "",
    email:           req.body.email || "",
    nationality:     req.body.nationality || "",
    jurisdiction:    req.body.jurisdiction || "EU",
    investorType:    req.body.investorType || "",
    committedAmount: req.body.committedAmount || "0",
    fund:            req.body.fund || "Felten Capital Fund I",
    sourceOfWealth:  req.body.sourceOfWealth || "",
    pepStatus:       req.body.pepStatus || "No",
    kycDocs:         req.body.kycDocs === "on" || req.body.kycDocs === true || req.body.kycDocs === "true",
    subDocSigned:    req.body.subDocSigned === "on" || req.body.subDocSigned === true || req.body.subDocSigned === "true",
    fatcaCrs:        req.body.fatcaCrs === "on" || req.body.fatcaCrs === true || req.body.fatcaCrs === "true",
    notes:           req.body.notes || "",
    status:          "Form Submitted",
    review:          null,
    complianceChecklist: [],
  };

  console.log(`\n[${new Date().toLocaleTimeString()}] New LP: ${lp.lpName} (${lp.email}) — ${lp.jurisdiction}`);

  // 1. Build jurisdiction-specific compliance checklist
  lp.complianceChecklist = buildBaseChecklist(lp);
  console.log(`  Checklist: ${lp.complianceChecklist.length} items generated for ${lp.jurisdiction}`);

  // 2. Claude AI review
  const review = await reviewWithClaude(lp);
  lp.review = review;
  lp.status = review.next_status || "Under Review";
  console.log(`  Claude: score=${review.score}, rec=${review.recommendation}`);

  addToQueue(lp);

  // 3. Auto-create LP user account
  const users = readUsers();
  if (!users.find(u => u.email.toLowerCase() === lp.email.toLowerCase())) {
    const tempPwd = "LP-" + lp.id.slice(-6);
    users.push({
      id: "user-lp-" + Date.now(), email: lp.email, name: lp.lpName,
      role: "lp", lpId: lp.id,
      passwordHash: bcrypt.hashSync(tempPwd, 10),
      createdAt: new Date().toISOString()
    });
    writeUsers(users);
    lp.tempPassword = tempPwd;
    console.log(`  LP user account: ${lp.email} / ${tempPwd}`);
  }

  // 4. Notion sync
  const notionPageId = await createNotionLP(lp, review);
  if (notionPageId) {
    updateInQueue(lp.id, { notionId: notionPageId });
    await createComplianceTasks(lp, notionPageId);
    console.log(`  Notion synced + ${lp.complianceChecklist.length} compliance items routed`);
  }

  res.json({
    success: true, lpId: lp.id, status: lp.status,
    score: review.score, recommendation: review.recommendation,
    summary: review.summary, missingItems: review.missing_items,
    checklistCount: lp.complianceChecklist.length,
    notionCreated: !!notionPageId, tempPassword: lp.tempPassword || null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// All LPs with full checklist data
app.get("/api/all-lps", requireAuth("gp", "admin"), (req, res) => res.json(readQueue()));

// Dashboard stats
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

// Single LP detail (GP/admin)
app.get("/api/lp/:id", requireAuth("gp", "admin"), (req, res) => {
  const lp = readQueue().find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  res.json(lp);
});

// Update LP status
app.put("/api/lp/:id/status", requireAuth("gp", "admin"), (req, res) => {
  const updated = updateInQueue(req.params.id, { status: req.body.status });
  if (!updated) return res.status(404).json({ error: "LP not found" });
  res.json({ ok: true, status: updated.status });
});

// Update compliance checklist item — the core new feature
app.put("/api/lp/:id/checklist/:itemId", requireAuth("gp", "admin"), (req, res) => {
  const q = readQueue();
  const lpIdx = q.findIndex(r => r.id === req.params.id);
  if (lpIdx === -1) return res.status(404).json({ error: "LP not found" });

  const lp = q[lpIdx];
  if (!lp.complianceChecklist) lp.complianceChecklist = buildBaseChecklist(lp);

  const itemIdx = lp.complianceChecklist.findIndex(i => i.id === req.params.itemId);
  if (itemIdx === -1) return res.status(404).json({ error: "Checklist item not found" });

  // Patch the item
  const { status, gpNotes } = req.body;
  if (status)   lp.complianceChecklist[itemIdx].status = status;
  if (gpNotes !== undefined) lp.complianceChecklist[itemIdx].gpNotes = gpNotes;
  if (status && status !== "Pending") {
    lp.complianceChecklist[itemIdx].verifiedBy = req.user.name;
    lp.complianceChecklist[itemIdx].verifiedAt = new Date().toISOString();
  }

  // Auto-update LP status based on checklist progress
  const required = lp.complianceChecklist.filter(i => i.required);
  const allVerified = required.every(i => i.status === "Verified" || i.status === "Waived");
  const anyFailed   = required.some(i => i.status === "Failed");
  if (anyFailed)    lp.status = "Compliance Check";
  else if (allVerified) lp.status = "Approved";

  writeQueue(q);

  // Compute progress stats
  const verified = lp.complianceChecklist.filter(i => i.status === "Verified" || i.status === "Received").length;
  const total    = lp.complianceChecklist.length;

  res.json({ ok: true, item: lp.complianceChecklist[itemIdx], lpStatus: lp.status, progress: { verified, total } });
});

// Batch update checklist — bulk save
app.put("/api/lp/:id/checklist", requireAuth("gp", "admin"), (req, res) => {
  const q = readQueue();
  const lpIdx = q.findIndex(r => r.id === req.params.id);
  if (lpIdx === -1) return res.status(404).json({ error: "LP not found" });

  const lp = q[lpIdx];
  if (!lp.complianceChecklist) lp.complianceChecklist = buildBaseChecklist(lp);

  const updates = req.body.updates || []; // [{ id, status, gpNotes }]
  updates.forEach(u => {
    const i = lp.complianceChecklist.findIndex(item => item.id === u.id);
    if (i !== -1) {
      if (u.status)   lp.complianceChecklist[i].status = u.status;
      if (u.gpNotes !== undefined) lp.complianceChecklist[i].gpNotes = u.gpNotes;
      if (u.status && u.status !== "Pending") {
        lp.complianceChecklist[i].verifiedBy = req.user.name;
        lp.complianceChecklist[i].verifiedAt = new Date().toISOString();
      }
    }
  });

  const required = lp.complianceChecklist.filter(i => i.required);
  const allVerified = required.every(i => i.status === "Verified" || i.status === "Waived");
  const anyFailed   = required.some(i => i.status === "Failed");
  if (anyFailed)    lp.status = "Compliance Check";
  else if (allVerified) lp.status = "Approved";

  writeQueue(q);
  res.json({ ok: true, checklist: lp.complianceChecklist, lpStatus: lp.status });
});

// Public LP status
app.get("/api/status/:id", (req, res) => {
  const lp = readQueue().find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  const { id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review } = lp;
  res.json({ id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", notion: !!notion, claude: !!anthropic });
});

// ── Start ─────────────────────────────────────────────────────────────────────
seedAdmin();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Onboard is running → http://localhost:${PORT}`);
  console.log(`   Notion: ${notion ? "✅ connected" : "⚠️  not configured"}`);
  console.log(`   Claude: ${anthropic ? "✅ connected" : "⚠️  add ANTHROPIC_API_KEY to Railway env vars"}\n`);
});
