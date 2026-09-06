import express from "express";
import multer from "multer";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, listProjects, upsertProject, deleteProject, getKV, setKV } from "./db.js";
import {
  parseContract, findInvoicesInGmail, sendGmail, readSupplierReplies,
  incomingPayments, matchPayments, googleAuthUrl, storeGoogleCode, chartmogulMrr, stripeInvoices, guessServices,
} from "./integrations.js";
import { pnl, monitoringState, tasksFor, supplierEmail, TAG, DEFAULT_SETTINGS, num, today } from "./logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/* -------------------------------------------------------- simple auth */
const PASSWORD = process.env.APP_PASSWORD || "";
function authed(req) {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith("ledger="));
  return cookie?.slice(7) === PASSWORD;
}
app.post("/login", (req, res) => {
  if (req.body?.password === PASSWORD) {
    res.setHeader("Set-Cookie", `ledger=${PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong password" });
});
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.use((req, res, next) => {
  if (req.path.startsWith("/auth/google") || req.path === "/login") return next();
  if (!authed(req)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in first" });
    return res.sendFile(path.join(__dirname, "login.html"));
  }
  next();
});

/* ------------------------------------------------------- Google OAuth */
app.get("/auth/google", (req, res) => {
  try { res.redirect(googleAuthUrl()); } catch (e) { res.status(500).send(e.message); }
});
app.get("/auth/google/callback", async (req, res) => {
  try { await storeGoogleCode(req.query.code); res.redirect("/?gmail=connected"); }
  catch (e) { res.status(500).send(e.message); }
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));
async function settings() { return { ...DEFAULT_SETTINGS, ...(await getKV("settings", {})) }; }

/* ------------------------------------------------------------- data */
app.get("/api/state", wrap(async (req, res) => {
  const [projects, s, gmail] = await Promise.all([listProjects(), settings(), getKV("google_tokens")]);
  res.json({ projects, settings: s, gmailConnected: !!gmail, chartmogul: !!process.env.CHARTMOGUL_API_KEY });
}));
app.put("/api/settings", wrap(async (req, res) => res.json(await setKV("settings", req.body))));
app.put("/api/projects/:id", wrap(async (req, res) => res.json(await upsertProject({ ...req.body, id: req.params.id }))));
app.delete("/api/projects/:id", wrap(async (req, res) => { await deleteProject(req.params.id); res.json({ ok: true }); }));

/* create = save + fire the supplier emails automatically */
app.post("/api/projects", wrap(async (req, res) => {
  const p = await upsertProject(req.body);
  const s = await settings();
  const sent = await sendSupplierRequests(p, s, ["ritvik", "cas"]);
  res.json({ project: sent, emails: Object.keys(sent.requests || {}) });
}));

async function sendSupplierRequests(p, s, kinds) {
  const ritvik = s.team.find((t) => t.id === "ritvik");
  const cas = s.team.find((t) => t.id === "cas");
  const requests = { ...(p.requests || {}) };
  for (const kind of kinds) {
    const member = kind === "ritvik" ? ritvik : cas;
    const cc = kind === "ritvik" ? cas : null;
    if (!member?.email || requests[kind]) continue;
    const mail = supplierEmail(kind, p, member, cc);
    if (s.autoEmails) {
      try {
        const threadId = await sendGmail(mail);
        requests[kind] = { sentAt: today(), threadId, subject: mail.subject };
      } catch (e) {
        requests[kind] = { error: e.message };
      }
    }
  }
  const out = { ...p, requests };
  await upsertProject(out);
  return out;
}

app.post("/api/projects/:id/request/:kind", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "No such project" });
  const s = await settings();
  const cleared = { ...p, requests: { ...(p.requests || {}), [req.params.kind]: undefined } };
  res.json(await sendSupplierRequests(cleared, s, [req.params.kind]));
}));

/* preview only, nothing sent */
app.get("/api/projects/:id/preview/:kind", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  const s = await settings();
  const member = s.team.find((t) => t.id === req.params.kind) || { name: req.params.kind, email: "" };
  const cas = s.team.find((t) => t.id === "cas");
  res.json(supplierEmail(req.params.kind, p, member, req.params.kind === "ritvik" ? cas : null));
}));

/* pull replies into the cost lines */
async function ingestReplies(p) {
  const r = await readSupplierReplies(p, TAG(p));
  if (!r) return p;
  const c = { ...p.costs };
  const setAmt = (k, v) => { if (v !== null && v !== undefined && num(v) > 0) c[k] = { ...c[k], amount: num(v) }; };
  setAmt("audit", (num(r.audit) || 0) + (num(r.reaudit) || 0) || null);
  setAmt("vpat", r.vpat);
  setAmt("pdf", r.pdf);
  if (r.devHours !== null && r.devHours !== undefined) c.dev = { ...c.dev, hours: num(r.devHours) };
  if (r.pmHours !== null && r.pmHours !== undefined) c.pm = { ...c.pm, hours: num(r.pmHours) };
  const out = { ...p, costs: c, deliveredAt: p.deliveredAt || r.deliveredAt || "", lastReplyNote: r.note || "" };
  await upsertProject(out);
  return out;
}
app.post("/api/projects/:id/ingest", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "No such project" });
  res.json(await ingestReplies(p));
}));

/* Stripe invoices that are not yet linked to a project */
app.get("/api/stripe/invoices", wrap(async (req, res) => {
  const [invoices, projects] = await Promise.all([stripeInvoices(120), listProjects()]);
  const linked = new Set(projects.flatMap((p) => p.stripeInvoices || []));
  res.json(invoices.filter((i) => !linked.has(i.id)).map((i) => ({ ...i, services: guessServices(i.lines) })));
}));

/* ---------------------------------------------------------- AI + mail */
app.post("/api/parse", upload.single("file"), wrap(async (req, res) => {
  res.json(await parseContract({ mode: req.body.mode, file: req.file, text: req.body.text }));
}));

app.post("/api/projects/:id/find-invoices", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "No such project" });
  res.json(await findInvoicesInGmail(p));
}));

app.get("/api/projects/:id/chartmogul", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  res.json(await chartmogulMrr(p.client));
}));

async function reconcileAll() {
  const [projects, s] = await Promise.all([listProjects(), settings()]);
  const open = [];
  for (const p of projects) {
    const n = pnl(p, s);
    if (!p.deposit.paidAt && n.deposit > 0) open.push({ client: p.client, stage: "deposit", amount: n.deposit, invoiceNo: p.deposit.invoiceNo });
    if (!p.balance.paidAt && n.balance > 0) open.push({ client: p.client, stage: "balance", amount: n.balance, invoiceNo: p.balance.invoiceNo });
    if (monitoringState(p) === "running") open.push({ client: p.client, stage: "monitoring", amount: n.mFee, invoiceNo: "monthly" });
  }
  const payments = await incomingPayments(120);
  const result = await matchPayments(payments, open);
  await setKV("settings", { ...s, lastReconcile: today() });
  return { ...result, paymentsSeen: payments.length };
}
app.post("/api/reconcile", wrap(async (req, res) => res.json(await reconcileAll())));

/* --------------------------------------------------- Monday morning job */
async function mondayRun() {
  const lines = [];
  try {
    const s = await settings();
    let projects = await listProjects();

    /* 1. read supplier replies into the P&L */
    for (const p of projects) {
      if (p.closed || !p.requests || Object.keys(p.requests).length === 0) continue;
      try { const u = await ingestReplies(p); if (u.lastReplyNote) lines.push(`${p.client}: ${u.lastReplyNote}`); }
      catch (e) { lines.push(`${p.client}: could not read replies, ${e.message}`); }
    }
    projects = await listProjects();

    /* 2. nudge Cas for hours on anything open and not yet delivered */
    for (const p of projects) {
      if (p.closed || p.deliveredAt) continue;
      await sendSupplierRequests({ ...p, requests: { ...(p.requests || {}), cas: undefined } }, s, ["cas"]);
    }

    /* 3. payments */
    try {
      const r = await reconcileAll();
      lines.push("", `Payments: ${r.paymentsSeen} seen, ${(r.matches || []).length} look like a match. Confirm them in the app.`);
    } catch (e) { lines.push("", `Payment check failed: ${e.message}`); }

    /* 4. open items */
    const tasks = projects.flatMap((p) => tasksFor(p, s));
    lines.push("", tasks.length ? "Open items:" : "No open items.");
    for (const t of tasks) lines.push(`- ${t.title} (${t.project.client})`);

    if (process.env.OWNER_EMAIL) {
      await sendGmail({ to: process.env.OWNER_EMAIL, subject: "Ledger: Monday summary", body: lines.join("\n") });
    }
    await setKV("settings", { ...s, lastMonday: today() });
  } catch (e) {
    console.error("monday job failed", e);
  }
  return lines;
}
cron.schedule("0 8 * * 1", mondayRun, { timezone: process.env.TZ || "Asia/Bangkok" });
app.post("/api/run-monday-now", wrap(async (req, res) => res.json({ lines: await mondayRun() })));

/* ---------------------------------------------------------- static */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const port = process.env.PORT || 8080;
migrate().then(() => app.listen(port, () => console.log(`ledger on :${port}`)));
