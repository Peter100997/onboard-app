// ─── Onboard — LP Onboarding Platform ────────────────────────────────────────
// Roles: admin | gp | lp
// All data is stored locally. Notion & Claude are optional background services.
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const jwt          = require("jsonwebtoken");
const bcrypt       = require("bcryptjs");
const cookieParser = require("cookie-parser");

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "onboard-jwt-secret-2026";

// ── Optional background services (app works fully without these) ───────────────
let notion     = null;
let anthropic  = null;
let NotionClient, AnthropicSDK;

try { NotionClient = require("@notionhq/client").Client; } catch {}
try { AnthropicSDK = require("@anthropic-ai/sdk");       } catch {}

if (process.env.NOTION_TOKEN && NotionClient) {
  try { notion = new NotionClient({ auth: process.env.NOTION_TOKEN }); } catch {}
}
if (process.env.ANTHROPIC_API_KEY && AnthropicSDK) {
  try { anthropic = new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY }); } catch {}
}

// ── DB IDs ────────────────────────────────────────────────────────────────────
const DB = {
  LP:    formatId(process.env.NOTION_DB_LP_PIPELINE      || "3f253f1689b74b58a5344ccd76600b49"),
  TASKS: formatId(process.env.NOTION_DB_COMPLIANCE_TASKS || "928b845946e649758dcb57ce4c1e16bc"),
  FUNDS: formatId(process.env.NOTION_DB_FUNDS            || "72f762bcff594eca8d95a44d1218b5aa"),
};

function formatId(id) {
  if (id.includes("-")) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER — JSON file store (persists on Railway volume / ephemeral fallback)
// ═══════════════════════════════════════════════════════════════════════════════
const DATA_DIR        = path.join(__dirname, "data");
const QUEUE_FILE      = path.join(DATA_DIR, "submissions.json");
const USERS_FILE      = path.join(DATA_DIR, "users.json");
const TASKS_FILE      = path.join(DATA_DIR, "compliance-tasks.json");
const FUNDS_FILE      = path.join(DATA_DIR, "funds.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Generic helpers
function readJson(file)     { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } }
function writeJson(file, d) { fs.writeFileSync(file, JSON.stringify(d, null, 2)); }

const readQueue  = ()  => readJson(QUEUE_FILE);
const writeQueue = (d) => writeJson(QUEUE_FILE, d);
const readUsers  = ()  => readJson(USERS_FILE);
const writeUsers = (d) => writeJson(USERS_FILE, d);
const readTasks  = ()  => readJson(TASKS_FILE);
const writeTasks = (d) => writeJson(TASKS_FILE, d);
const readFunds  = ()  => readJson(FUNDS_FILE);
const writeFunds = (d) => writeJson(FUNDS_FILE, d);

function addToQueue(r)   { const q = readQueue(); q.push(r); writeQueue(q); return r; }
function updateInQueue(id, patch) {
  const q = readQueue(), i = q.findIndex(r => r.id === id);
  if (i !== -1) { q[i] = { ...q[i], ...patch }; writeQueue(q); return q[i]; }
  return null;
}

// ── Seed data ──────────────────────────────────────────────────────────────────
function seedAdmin() {
  const users = readUsers();
  if (!users.find(u => u.email === "peter_fe@icloud.com")) {
    users.push({
      id: "user-admin-001", email: "peter_fe@icloud.com", name: "Peter", role: "admin",
      passwordHash: bcrypt.hashSync("Onboard2026!", 10), createdAt: new Date().toISOString(),
    });
    writeUsers(users);
    console.log("  🔐 Admin seeded: peter_fe@icloud.com / Onboard2026!");
  }
}

function seedFunds() {
  const funds = readFunds();
  if (!funds.find(f => f.id === "fund-001")) {
    funds.push({
      id:           "fund-001",
      name:         "Felten Capital Fund I",
      strategy:     "Private Equity",
      aum:          350,
      aumCurrency:  "CHF",
      aumTarget:    500,
      vintage:      2024,
      domicile:     "Switzerland",
      regFramework: ["AIFMD", "GDPR", "FINMA"],
      minTicket:    500,
      status:       "Fundraising",
      notionId:     "72f762bcff594eca8d95a44d1218b5aa",
      createdAt:    new Date().toISOString(),
    });
    writeFunds(funds);
    console.log("  💼 Fund seeded: Felten Capital Fund I");
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────
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
      if (roles.length && !roles.includes(decoded.role)) return res.status(403).json({ error: "Forbidden" });
      req.user = decoded;
      next();
    } catch {
      if (req.accepts("html")) return res.redirect(`/login?redirect=${encodeURIComponent(req.path)}`);
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE CHECKLIST — Jurisdiction-specific regulatory items
// ═══════════════════════════════════════════════════════════════════════════════
function buildBaseChecklist(lp) {
  const jur = lp.jurisdiction || "EU";
  const isInstitutional = ["Institutional", "Corporate", "Fund of Funds"].includes(lp.investorType);
  const isPEP = lp.pepStatus === "Yes";

  const items = [
    // Core KYC/AML — all jurisdictions
    { id: "kyc-001", category: "Identity & KYC",   item: "Passport / National ID",              required: true,  ref: "EU 5th AMLD Art.13 / FATF R.10" },
    { id: "kyc-002", category: "Identity & KYC",   item: "Proof of Address",                    required: true,  ref: "EU 5th AMLD Art.13 / FATF R.10" },
    { id: "kyc-003", category: "Identity & KYC",   item: "Identity Verification Complete",       required: true,  ref: "AML Directive / FATF Rec. 10" },
    { id: "sow-001", category: "Source of Wealth", item: "Source of Wealth Declaration",         required: true,  ref: "FATF Rec. 12 / AMLD Art.20" },
    { id: "sow-002", category: "Source of Wealth", item: "Source of Wealth Evidence Reviewed",   required: true,  ref: "FATF Rec. 12" },
    { id: "sow-003", category: "Source of Wealth", item: "Funds Origin Verified",                required: true,  ref: "FATF Rec. 12 / Art. 18 AMLD" },
    { id: "aml-001", category: "AML & Sanctions",  item: "AML Risk Assessment",                  required: true,  ref: "EU 5th AMLD Art.6" },
    { id: "aml-002", category: "AML & Sanctions",  item: "Sanctions Screening (EU/UN/OFAC/HMT)", required: true,  ref: "EU Reg. 2580/2001 / OFAC" },
    { id: "aml-003", category: "AML & Sanctions",  item: "Adverse Media Check",                  required: true,  ref: "FATF Guidance / EBA AML Guidelines" },
    { id: "pep-001", category: "PEP Screening",    item: "PEP Status Verified",                  required: true,  ref: "EU 5th AMLD Art.20" },
    ...(isPEP ? [
      { id: "pep-002", category: "PEP Screening",  item: "Enhanced Due Diligence — PEP",         required: true,  ref: "EU 5th AMLD Art.20(2)" },
      { id: "pep-003", category: "PEP Screening",  item: "Senior Management Approval — PEP",     required: true,  ref: "EU 5th AMLD Art.20(2)(b)" },
    ] : []),
    { id: "sub-001", category: "Subscription",     item: "Subscription Agreement Signed",        required: true,  ref: "Fund Constitution / LP Agreement" },
    { id: "sub-002", category: "Subscription",     item: "FATCA / CRS Self-Certification",       required: true,  ref: "OECD CRS / US IRC §1471" },
  ];

  if (isInstitutional) {
    items.push(
      { id: "inst-001", category: "Corporate KYC", item: "Certificate of Incorporation",             required: true,  ref: "EU 5th AMLD Art.13(1)(b)" },
      { id: "inst-002", category: "Corporate KYC", item: "Register of Directors / UBOs",             required: true,  ref: "EU 5th AMLD Art.30" },
      { id: "inst-003", category: "Corporate KYC", item: "Beneficial Owner KYC (≥25% threshold)",    required: true,  ref: "EU 5th AMLD Art.30" },
      { id: "inst-004", category: "Corporate KYC", item: "LEI Number",                               required: true,  ref: "EMIR Art.9 / AIFMD Reporting" },
      { id: "inst-005", category: "Corporate KYC", item: "Board Resolution / Signing Authority",     required: true,  ref: "Fund Constitution" },
    );
  }

  if (jur === "EU") {
    items.push(
      { id: "eu-001", category: "EU / AIFMD",   item: "AIFMD Suitability Assessment (Art.9)",       required: true,  ref: "AIFMD 2011/61/EU Art.9" },
      { id: "eu-002", category: "EU / AIFMD",   item: "Investor Categorisation (Professional)",     required: true,  ref: "MiFID II / AIFMD" },
      { id: "eu-003", category: "EU / AIFMD",   item: "CSSF Suitability Questionnaire",             required: false, ref: "CSSF Circular 18/698" },
      { id: "eu-004", category: "EU / AIFMD",   item: "AIFMD Art.23 Disclosure Acknowledged",       required: true,  ref: "AIFMD Art.23" },
      { id: "eu-005", category: "EU / AIFMD",   item: "GDPR Consent / Data Processing Agreement",   required: true,  ref: "GDPR Art.6 / Art.9" },
    );
  } else if (jur === "UK") {
    items.push(
      { id: "uk-001", category: "UK / FCA",     item: "FCA Investor Categorisation Form",            required: true,  ref: "FCA COBS 3.5" },
      { id: "uk-002", category: "UK / FCA",     item: "Elective Professional Client Opt-Up",         required: false, ref: "FCA COBS 3.5.3" },
      { id: "uk-003", category: "UK / FCA",     item: "FSMA s.21 Financial Promotion Acknowledgment",required: true,  ref: "FSMA 2000 s.21" },
      { id: "uk-004", category: "UK / FCA",     item: "CASS Client Money Protection Acknowledgment", required: true,  ref: "FCA CASS 7" },
      { id: "uk-005", category: "UK / FCA",     item: "Appropriateness Assessment Complete",         required: true,  ref: "FCA COBS 10" },
      { id: "uk-006", category: "UK / FCA",     item: "UK GDPR Consent / Privacy Notice Issued",    required: true,  ref: "UK GDPR / DPA 2018" },
    );
  } else if (jur === "CH") {
    items.push(
      { id: "ch-001", category: "Switzerland / FINMA", item: "FIDLEG Suitability Assessment",        required: true,  ref: "FinSA Art.10 / FIDLEG" },
      { id: "ch-002", category: "Switzerland / FINMA", item: "Beneficial Ownership Form A (AMLA)",   required: true,  ref: "GwG Art.4 / Form A" },
      { id: "ch-003", category: "Switzerland / FINMA", item: "CISA Art.10(3) Qualified Investor Declaration", required: true, ref: "CISA Art.10(3)(b)(c)" },
      { id: "ch-004", category: "Switzerland / FINMA", item: "FinSA Client Segmentation",            required: true,  ref: "FinSA Art.4" },
      { id: "ch-005", category: "Switzerland / FINMA", item: "VQF / SELF Regulation Compliance",     required: false, ref: "GwG Art.24 VQF" },
      { id: "ch-006", category: "Switzerland / FINMA", item: "AEOI / CRS Self-Certification (ESTV)", required: true,  ref: "AIA-Gesetz / OECD CRS" },
    );
  } else {
    items.push(
      { id: "int-001", category: "International", item: "AML/KYC Questionnaire",                    required: true,  ref: "FATF Recommendations" },
      { id: "int-002", category: "International", item: "Bank Reference Letter",                    required: true,  ref: "FATF Rec. 10 / Internal Policy" },
      { id: "int-003", category: "International", item: "W-8BEN or W-9 (US Tax)",                  required: true,  ref: "US IRC §1441 / FATCA" },
      { id: "int-004", category: "International", item: "Country Risk Assessment",                  required: true,  ref: "FATF Country Risk / Internal Policy" },
    );
  }

  return items.map(item => {
    let status = "Pending";
    if (item.id === "kyc-001" && lp.kycDocs)        status = "Received";
    if (item.id === "sub-001" && lp.subDocSigned)    status = "Received";
    if (item.id === "sub-002" && lp.fatcaCrs)        status = "Received";
    if (item.id === "pep-001")                       status = lp.pepStatus === "No" ? "Verified" : "Received";
    if (item.id === "sow-001" && lp.sourceOfWealth)  status = "Received";
    return { ...item, status, gpNotes: "", verifiedBy: null, verifiedAt: null };
  });
}

// ── Compliance Tasks (local store) ────────────────────────────────────────────
function createLocalComplianceTasks(lp) {
  const tasks  = readTasks();
  const due    = new Date(Date.now() + 2 * 86400000).toISOString().split("T")[0];
  const baseTasks = [
    { task: `KYC Verification`,         team: "Legal",      type: "KYC Verification",        priority: "High" },
    { task: `AML / Sanctions Check`,    team: "Compliance", type: "AML / Sanctions Check",   priority: "High" },
    { task: `PEP Screening`,            team: "Compliance", type: "PEP Screening",           priority: "High" },
    { task: `Subscription Doc Review`,  team: "Legal",      type: "Subscription Doc Review", priority: "Medium" },
    { task: `Source of Wealth Check`,   team: "Compliance", type: "Source of Wealth Check",  priority: "Medium" },
    { task: `Cap Table Update`,         team: "Finance",    type: "Cap Table Update",        priority: "Low" },
  ];
  if (lp.jurisdiction === "UK") {
    baseTasks.push({ task: `FCA Categorisation`, team: "Legal", type: "FCA Categorisation", priority: "High" });
  } else if (lp.jurisdiction === "CH") {
    baseTasks.push({ task: `FIDLEG Suitability`, team: "Legal", type: "FIDLEG Assessment",  priority: "High" });
  } else {
    baseTasks.push({ task: `AIFMD Suitability`,  team: "Legal", type: "AIFMD Suitability",  priority: "High" });
  }

  const newTasks = baseTasks.map((t, idx) => ({
    id:          `task-${lp.id}-${idx}`,
    lpId:        lp.id,
    lpName:      lp.lpName,
    fund:        lp.fund,
    jurisdiction: lp.jurisdiction,
    task:        `${t.task} — ${lp.lpName}`,
    team:        t.team,
    type:        t.type,
    priority:    t.priority,
    status:      "Pending",
    dueDate:     due,
    assignedTo:  null,
    notes:       "",
    createdAt:   new Date().toISOString(),
    updatedAt:   null,
    notionId:    null,
  }));

  writeTasks([...tasks, ...newTasks]);
  return newTasks;
}

// ── Claude review ─────────────────────────────────────────────────────────────
async function reviewWithClaude(lp) {
  if (!anthropic) {
    return {
      score: 65, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "ANTHROPIC_API_KEY not configured — add it in Railway Variables",
      summary: "Automated AI review is unavailable. Add ANTHROPIC_API_KEY to Railway environment variables.",
      recommendation: "Further Review Required", next_status: "Under Review"
    };
  }
  const jurisDoc = lp.jurisdiction === "UK"
    ? "FCA investor categorisation, CASS acknowledgment, FSMA s.21"
    : lp.jurisdiction === "CH"
      ? "FIDLEG suitability, AMLA beneficial ownership form, CISA Art.10 QIA"
      : "AIFMD Art.23 suitability, CSSF questionnaire, FATCA/CRS";

  const prompt = `You are Onboard's AI compliance reviewer for a European alternative asset fund.

Review this LP onboarding submission. Return ONLY a JSON object (no markdown):

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
- Jurisdiction docs: ${jurisDoc}
- Notes: ${lp.notes || "None"}

Return this JSON only:
{"score":<0-100>,"pep_status":"<Not PEP|PEP — Enhanced DD Required|Pending Check>","sanctions_clear":"<Clear|Flagged|Pending>","missing_items":"<comma-separated or None>","summary":"<2-3 sentence compliance summary>","recommendation":"<Approve|Further Review Required|Reject>","next_status":"<Under Review|Legal Check|Compliance Check|Rejected>"}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-6", max_tokens: 600,
      messages: [{ role: "user", content: prompt }]
    });
    return JSON.parse(msg.content[0].text.trim());
  } catch (e) {
    console.error("Claude review error:", e.message);
    return {
      score: 50, pep_status: "Pending Check", sanctions_clear: "Pending",
      missing_items: "Automated review failed — manual review required",
      summary: "AI review encountered a configuration error. Verify ANTHROPIC_API_KEY in Railway environment variables.",
      recommendation: "Further Review Required", next_status: "Under Review"
    };
  }
}

// ── Notion helpers ─────────────────────────────────────────────────────────────
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

async function createNotionComplianceTasks(lp, lpNotionId, localTasks) {
  if (!notion) return;
  const due = new Date(Date.now() + 2 * 86400000).toISOString().split("T")[0];
  const tasks = readTasks();
  for (const t of localTasks) {
    try {
      const page = await notion.pages.create({
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
      // Store notion page ID back in local task
      const idx = tasks.findIndex(tk => tk.id === t.id);
      if (idx !== -1) tasks[idx].notionId = page.id;
    } catch (e) { console.error("Task create error:", e.message); }
  }
  writeTasks(tasks);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = readUsers().find(u => u.email?.toLowerCase() === email?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: "Invalid email or password" });
  const token = signToken(user);
  res.cookie("token", token, { httpOnly: true, maxAge: 86400000, sameSite: "lax" });
  res.json({ ok: true, role: user.role, name: user.name });
});

app.post("/auth/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });

app.get("/auth/me", requireAuth(), (req, res) =>
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }));

// ── User management (admin only) ──────────────────────────────────────────────
app.get("/api/users", requireAuth("admin"), (req, res) =>
  res.json(readUsers().map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt }))));

app.post("/api/users", requireAuth("admin"), (req, res) => {
  const { email, name, role, password } = req.body;
  if (!email || !name || !role || !password) return res.status(400).json({ error: "Missing fields" });
  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: "Email already exists" });
  const user = { id: "user-" + Date.now(), email, name, role,
    passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString() };
  users.push(user); writeUsers(users);
  res.json({ ok: true, id: user.id });
});

app.put("/api/users/:id", requireAuth("admin"), (req, res) => {
  const users = readUsers(), i = users.findIndex(u => u.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "User not found" });
  if (req.body.role)     users[i].role = req.body.role;
  if (req.body.name)     users[i].name = req.body.name;
  if (req.body.password) users[i].passwordHash = bcrypt.hashSync(req.body.password, 10);
  writeUsers(users); res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth("admin"), (req, res) => {
  if (req.params.id === "user-admin-001") return res.status(403).json({ error: "Cannot delete primary admin" });
  writeUsers(readUsers().filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/",           (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/status",     (req, res) => res.sendFile(path.join(__dirname, "public", "status.html")));
app.get("/gp",         requireAuth("gp", "admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "gp.html")));
app.get("/compliance", requireAuth("gp", "admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "compliance.html")));
app.get("/funds",      requireAuth("gp", "admin"), (req, res) => res.sendFile(path.join(__dirname, "public", "funds.html")));
app.get("/admin",      requireAuth("admin"),        (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMISSION
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

  // 1. Build compliance checklist
  lp.complianceChecklist = buildBaseChecklist(lp);

  // 2. Claude AI review
  const review = await reviewWithClaude(lp);
  lp.review = review;
  lp.status = review.next_status || "Under Review";
  console.log(`  Claude: score=${review.score}, rec=${review.recommendation}`);

  addToQueue(lp);

  // 3. Auto-create local compliance tasks
  const localTasks = createLocalComplianceTasks(lp);
  console.log(`  ${localTasks.length} compliance tasks created locally`);

  // 4. Update fund LP count
  const funds = readFunds();
  const fi = funds.findIndex(f => f.name === lp.fund);
  if (fi !== -1) { funds[fi].lpCount = (funds[fi].lpCount || 0) + 1; writeFunds(funds); }

  // 5. Auto-create LP user account
  const users = readUsers();
  if (!users.find(u => u.email.toLowerCase() === lp.email.toLowerCase())) {
    const tempPwd = "LP-" + lp.id.slice(-6);
    users.push({ id: "user-lp-" + Date.now(), email: lp.email, name: lp.lpName,
      role: "lp", lpId: lp.id, passwordHash: bcrypt.hashSync(tempPwd, 10), createdAt: new Date().toISOString() });
    writeUsers(users);
    lp.tempPassword = tempPwd;
  }

  // 6. Notion sync (non-blocking)
  const notionPageId = await createNotionLP(lp, review);
  if (notionPageId) {
    updateInQueue(lp.id, { notionId: notionPageId });
    await createNotionComplianceTasks(lp, notionPageId, localTasks);
    console.log(`  Notion synced`);
  }

  res.json({
    success: true, lpId: lp.id, status: lp.status,
    score: review.score, recommendation: review.recommendation,
    summary: review.summary, missingItems: review.missing_items,
    checklistCount: lp.complianceChecklist.length,
    tasksCreated: localTasks.length,
    notionCreated: !!notionPageId, tempPassword: lp.tempPassword || null,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LP API
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/all-lps",   requireAuth("gp", "admin"), (req, res) => res.json(readQueue()));

app.get("/api/dashboard", requireAuth("gp", "admin"), (req, res) => {
  const subs = readQueue();
  const stats = { total: subs.length, byStatus: {}, avgScore: 0, recentSubmissions: subs.slice(-5).reverse() };
  subs.forEach(s => {
    stats.byStatus[s.status] = (stats.byStatus[s.status] || 0) + 1;
    stats.avgScore += (s.review?.score || 0);
  });
  if (subs.length) stats.avgScore = Math.round(stats.avgScore / subs.length);
  res.json(stats);
});

app.get("/api/lp/:id", requireAuth("gp", "admin"), (req, res) => {
  const lp = readQueue().find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  res.json(lp);
});

app.put("/api/lp/:id/status", requireAuth("gp", "admin"), (req, res) => {
  const updated = updateInQueue(req.params.id, { status: req.body.status });
  if (!updated) return res.status(404).json({ error: "LP not found" });
  res.json({ ok: true, status: updated.status });
});

app.put("/api/lp/:id/checklist/:itemId", requireAuth("gp", "admin"), (req, res) => {
  const q = readQueue(), lpIdx = q.findIndex(r => r.id === req.params.id);
  if (lpIdx === -1) return res.status(404).json({ error: "LP not found" });
  const lp = q[lpIdx];
  if (!lp.complianceChecklist) lp.complianceChecklist = buildBaseChecklist(lp);
  const iIdx = lp.complianceChecklist.findIndex(i => i.id === req.params.itemId);
  if (iIdx === -1) return res.status(404).json({ error: "Item not found" });
  const { status, gpNotes } = req.body;
  if (status)             lp.complianceChecklist[iIdx].status   = status;
  if (gpNotes !== undefined) lp.complianceChecklist[iIdx].gpNotes = gpNotes;
  if (status && status !== "Pending") {
    lp.complianceChecklist[iIdx].verifiedBy = req.user.name;
    lp.complianceChecklist[iIdx].verifiedAt = new Date().toISOString();
  }
  const req_ = lp.complianceChecklist.filter(i => i.required);
  if (req_.some(i => i.status === "Failed"))                        lp.status = "Compliance Check";
  else if (req_.every(i => i.status === "Verified" || i.status === "Waived")) lp.status = "Approved";
  writeQueue(q);
  res.json({ ok: true, item: lp.complianceChecklist[iIdx], lpStatus: lp.status });
});

app.put("/api/lp/:id/checklist", requireAuth("gp", "admin"), (req, res) => {
  const q = readQueue(), lpIdx = q.findIndex(r => r.id === req.params.id);
  if (lpIdx === -1) return res.status(404).json({ error: "LP not found" });
  const lp = q[lpIdx];
  if (!lp.complianceChecklist) lp.complianceChecklist = buildBaseChecklist(lp);
  (req.body.updates || []).forEach(u => {
    const i = lp.complianceChecklist.findIndex(it => it.id === u.id);
    if (i !== -1) {
      if (u.status)             lp.complianceChecklist[i].status   = u.status;
      if (u.gpNotes !== undefined) lp.complianceChecklist[i].gpNotes = u.gpNotes;
      if (u.status && u.status !== "Pending") {
        lp.complianceChecklist[i].verifiedBy = req.user.name;
        lp.complianceChecklist[i].verifiedAt = new Date().toISOString();
      }
    }
  });
  const req_ = lp.complianceChecklist.filter(i => i.required);
  if (req_.some(i => i.status === "Failed"))                        lp.status = "Compliance Check";
  else if (req_.every(i => i.status === "Verified" || i.status === "Waived")) lp.status = "Approved";
  writeQueue(q);
  res.json({ ok: true, checklist: lp.complianceChecklist, lpStatus: lp.status });
});

// Public status
app.get("/api/status/:id", (req, res) => {
  const lp = readQueue().find(r => r.id === req.params.id);
  if (!lp) return res.status(404).json({ error: "LP not found" });
  const { id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review } = lp;
  res.json({ id, lpName, investorType, nationality, jurisdiction, fund, status, submittedAt, review });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE TASKS API
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/compliance-tasks", requireAuth("gp", "admin"), (req, res) => {
  let tasks = readTasks();
  if (req.query.team)   tasks = tasks.filter(t => t.team === req.query.team);
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.lpId)   tasks = tasks.filter(t => t.lpId === req.query.lpId);
  res.json(tasks);
});

app.put("/api/compliance-tasks/:id", requireAuth("gp", "admin"), (req, res) => {
  const tasks = readTasks(), i = tasks.findIndex(t => t.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Task not found" });
  if (req.body.status)     tasks[i].status     = req.body.status;
  if (req.body.assignedTo) tasks[i].assignedTo = req.body.assignedTo;
  if (req.body.notes)      tasks[i].notes      = req.body.notes;
  if (req.body.dueDate)    tasks[i].dueDate     = req.body.dueDate;
  tasks[i].updatedAt = new Date().toISOString();
  writeTasks(tasks);
  res.json({ ok: true, task: tasks[i] });
});

app.get("/api/compliance-tasks/stats", requireAuth("gp", "admin"), (req, res) => {
  const tasks = readTasks();
  const stats = { total: tasks.length, byStatus: {}, byTeam: {}, byPriority: {} };
  tasks.forEach(t => {
    stats.byStatus[t.status]   = (stats.byStatus[t.status]   || 0) + 1;
    stats.byTeam[t.team]       = (stats.byTeam[t.team]       || 0) + 1;
    stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
  });
  res.json(stats);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDS API
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/funds", requireAuth("gp", "admin"), (req, res) => {
  const funds = readFunds();
  // Enrich with live LP count
  const subs = readQueue();
  const enriched = funds.map(f => ({
    ...f,
    lpCount:        subs.filter(s => s.fund === f.name).length,
    totalCommitted: subs.filter(s => s.fund === f.name)
      .reduce((sum, s) => sum + parseFloat(s.committedAmount || 0), 0),
    byStatus: subs.filter(s => s.fund === f.name)
      .reduce((acc, s) => { acc[s.status] = (acc[s.status]||0)+1; return acc; }, {}),
  }));
  res.json(enriched);
});

app.post("/api/funds", requireAuth("admin"), (req, res) => {
  const { name, strategy, aum, aumCurrency, aumTarget, vintage, domicile, regFramework, minTicket } = req.body;
  if (!name) return res.status(400).json({ error: "Fund name required" });
  const funds = readFunds();
  const fund = {
    id: "fund-" + Date.now(), name, strategy, aum: parseFloat(aum)||0,
    aumCurrency: aumCurrency||"EUR", aumTarget: parseFloat(aumTarget)||0,
    vintage: parseInt(vintage)||new Date().getFullYear(),
    domicile, regFramework: Array.isArray(regFramework) ? regFramework : [regFramework].filter(Boolean),
    minTicket: parseFloat(minTicket)||500, status: "Fundraising",
    lpCount: 0, createdAt: new Date().toISOString(),
  };
  funds.push(fund); writeFunds(funds);
  res.json({ ok: true, id: fund.id });
});

app.put("/api/funds/:id", requireAuth("admin"), (req, res) => {
  const funds = readFunds(), i = funds.findIndex(f => f.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Fund not found" });
  const fields = ["name","strategy","aum","aumCurrency","aumTarget","vintage","domicile","minTicket","status"];
  fields.forEach(k => { if (req.body[k] !== undefined) funds[i][k] = req.body[k]; });
  writeFunds(funds); res.json({ ok: true });
});

// Health — platform is always operational; notion/claude are optional extras
app.get("/api/health", (req, res) =>
  res.json({
    status:    "ok",
    platform:  "standalone",
    lps:       readQueue().length,
    tasks:     readTasks().length,
    funds:     readFunds().length,
    users:     readUsers().length,
    claude:    !!anthropic,
    notionSync: !!notion,
  }));

// ── Start ──────────────────────────────────────────────────────────────────────
seedAdmin();
seedFunds();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Onboard is running → http://localhost:${PORT}`);
  console.log(`   Data:   local JSON store (standalone — no external DB required)`);
  console.log(`   Claude: ${anthropic ? "✅ AI review active" : "ℹ️  add ANTHROPIC_API_KEY for AI review"}`);
  console.log(`   Notion: ${notion    ? "✅ background sync active" : "ℹ️  not configured (optional)"}\n`);
});
