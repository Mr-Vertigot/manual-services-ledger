import express from "express";
import multer from "multer";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, listProjects, upsertProject, deleteProject, getKV, setKV } from "./db.js";
import {
  parseContract, findInvoicesInGmail, createGmailDraft, sendGmail,
  incomingPayments, matchPayments, googleAuthUrl, storeGoogleCode,
} from "./integrations.js";
import { pnl, monitoringState, tasksFor, weeklyEmail, DEFAULT_SETTINGS } from "./logic.js";

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
app.use((req, res, next) => {
  if (req.path.startsWith("/auth/google")) return next();
  if (req.path === "/login" || req.path === "/login.html") return next();
  if (!authed(req)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in first" });
    return res.sendFile(path.join(__dirname, "..", "public", "login.html"));
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

/* ------------------------------------------------------------- data */
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

app.get("/api/state", wrap(async (req, res) => {
  const [projects, settings, gmail] = await Promise.all([
    listProjects(),
    getKV("settings", DEFAULT_SETTINGS),
    getKV("google_tokens"),
  ]);
  res.json({ projects, settings: { ...DEFAULT_SETTINGS, ...settings }, gmailConnected: !!gmail });
}));
app.put("/api/settings", wrap(async (req, res) => res.json(await setKV("settings", req.body))));
app.put("/api/projects/:id", wrap(async (req, res) => res.json(await upsertProject({ ...req.body, id: req.params.id }))));
app.delete("/api/projects/:id", wrap(async (req, res) => { await deleteProject(req.params.id); res.json({ ok: true }); }));

/* ---------------------------------------------------------- AI + mail */
app.post("/api/parse", upload.single("file"), wrap(async (req, res) => {
  res.json(await parseContract({ mode: req.body.mode, file: req.file, text: req.body.text }));
}));

app.post("/api/projects/:id/find-invoices", wrap(async (req, res) => {
  const p = (await listProjects()).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "No such project" });
  res.json(await findInvoicesInGmail(p));
}));

app.post("/api/reconcile", wrap(async (req, res) => {
  const [projects, settings] = await Promise.all([listProjects(), getKV("settings", DEFAULT_SETTINGS)]);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const open = [];
  for (const p of projects) {
    const n = pnl(p, s);
    if (!p.deposit.paidAt && n.deposit > 0) open.push({ client: p.client, stage: "deposit", amount: n.deposit, invoiceNo: p.deposit.invoiceNo });
    if (!p.balance.paidAt && n.balance > 0) open.push({ client: p.client, stage: "balance", amount: n.balance, invoiceNo: p.balance.invoiceNo });
    if (monitoringState(p) === "running") open.push({ client: p.client, stage: "monitoring", amount: n.mFee, invoiceNo: "monthly" });
  }
  const payments = await incomingPayments(45);
  const result = await matchPayments(payments, open);
  await setKV("settings", { ...s, lastReconcile: new Date().toISOString().slice(0, 10) });
  res.json({ ...result, paymentsSeen: payments.length });
}));

app.post("/api/team/draft", wrap(async (req, res) => {
  const [projects, settings] = await Promise.all([listProjects(), getKV("settings", DEFAULT_SETTINGS)]);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const member = s.team.find((t) => t.id === req.body.memberId);
  if (!member?.email) return res.status(400).json({ error: "Add an email address for that person first." });
  const mail = weeklyEmail(member, projects);
  const id = await createGmailDraft({ to: member.email, ...mail });
  await setKV("settings", { ...s, lastTimesheetRun: new Date().toISOString().slice(0, 10) });
  res.json({ ok: true, draftId: id });
}));

/* --------------------------------------------------- Monday morning job */
async function mondayRun() {
  try {
    const [projects, settings] = await Promise.all([listProjects(), getKV("settings", DEFAULT_SETTINGS)]);
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const lines = [];

    /* 1. team check-ins go out as drafts, you press send */
    for (const m of s.team) {
      if (!m.email) continue;
      try { await createGmailDraft({ to: m.email, ...weeklyEmail(m, projects) }); lines.push(`Draft ready for ${m.name}`); }
      catch (e) { lines.push(`Could not draft for ${m.name}: ${e.message}`); }
    }

    /* 2. reminders summary */
    const tasks = projects.flatMap((p) => tasksFor(p, s));
    lines.push("", tasks.length ? "Open items:" : "No open items.");
    for (const t of tasks) lines.push(`- ${t.title} (${t.project.client})`);

    /* 3. payments landed since last week */
    try {
      const pays = await incomingPayments(8);
      lines.push("", pays.length ? "Payments in the last 8 days:" : "No incoming payments in the last 8 days.");
      for (const p of pays) lines.push(`- ${p.date} ${p.source} ${p.amount} ${p.currency} from ${p.from}`);
    } catch (e) { lines.push("", `Payment check failed: ${e.message}`); }

    if (process.env.OWNER_EMAIL) {
      await sendGmail({ to: process.env.OWNER_EMAIL, subject: "Ledger: Monday summary", body: lines.join("\n") });
    }
    await setKV("settings", { ...s, lastTimesheetRun: new Date().toISOString().slice(0, 10) });
  } catch (e) {
    console.error("monday job failed", e);
  }
}
cron.schedule("0 8 * * 1", mondayRun, { timezone: process.env.TZ || "Asia/Bangkok" });
app.post("/api/run-monday-now", wrap(async (req, res) => { await mondayRun(); res.json({ ok: true }); }));

/* ---------------------------------------------------------- static */
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 8080;
migrate().then(() => app.listen(port, () => console.log(`ledger on :${port}`)));
