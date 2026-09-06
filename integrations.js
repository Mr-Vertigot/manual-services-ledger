import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import { google } from "googleapis";
import mammoth from "mammoth";
import { getKV, setKV } from "./db.js";

/* ------------------------------------------------------------ Anthropic */
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

function need(x, name) {
  if (!x) throw new Error(`${name} is not configured on the server.`);
  return x;
}

function parseJSON(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  return JSON.parse(start > 0 ? clean.slice(start) : clean);
}

export async function askClaude(content, maxTokens = 1500) {
  need(anthropic, "ANTHROPIC_API_KEY");
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  });
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const CONTRACT_PROMPT = `You are reading a signed accessibility services contract for AccessibilityChecker.org.
Extract the commercial terms. Respond with ONLY a JSON object, no preamble, no markdown fences:
{
 "client": "legal name of the client",
 "contractDate": "YYYY-MM-DD or empty string",
 "services": {"remediation": bool, "audit": bool, "vpat": bool, "pdf": bool, "monitoring": bool},
 "projectFee": number (total one-time fee, 0 if none),
 "depositPct": number (percent due upfront, usually 50),
 "monitoringMonthly": number (0 if no monitoring; if only an annual figure is given divide by 12),
 "monitoringMonths": number (contracted term in months, 12 if unstated),
 "scopeNotes": "one short line: page/template count, platform, anything unusual",
 "confidence": "high" | "medium" | "low",
 "flags": ["anything ambiguous a human should check"]
}
Rules: remediation, audit, vpat and pdf are one-time work; "pdf" means remediating PDF documents. Monitoring is the only recurring service and it starts only after the one-time work is handed over. "audit" is true when a standalone manual audit is sold. When remediation is sold, an audit is normally part of it, so set remediation true and audit false unless the audit is priced separately. Numbers must be plain numbers with no currency symbols.`;

const NOTE_PROMPT = `You are reading an internal note from AccessibilityChecker.org describing work that was sold to a client. There may be no formal contract, so do not expect signatures, payment clauses or legal terms, and never flag their absence.
Pull out whatever commercial detail is there and leave the rest empty. Respond with ONLY a JSON object, no preamble, no markdown fences:
{
 "client": "client name if named, else empty string",
 "contractDate": "YYYY-MM-DD or empty string",
 "services": {"remediation": bool, "audit": bool, "vpat": bool, "pdf": bool, "monitoring": bool},
 "projectFee": number (0 if not stated),
 "depositPct": number (50 unless stated otherwise),
 "monitoringMonthly": number (0 if none),
 "monitoringMonths": number (12 if unstated),
 "scopeNotes": "one short line",
 "confidence": "high" | "medium" | "low",
 "flags": ["only things that change what we charge or owe, max 2, empty array if none"]
}
Shorthand is normal here: "7 tops" or "7tops" means 7 templates, "wcag aa" is the standard target. Interpret it, do not complain about it.`;

export async function parseContract({ mode, file, text }) {
  const prompt = mode === "note" ? NOTE_PROMPT : CONTRACT_PROMPT;
  let content;
  if (file) {
    const { mimetype, buffer, originalname } = file;
    if (mimetype === "application/pdf") {
      content = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } },
        { type: "text", text: prompt },
      ];
    } else if (originalname.endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer });
      content = [{ type: "text", text: `${prompt}\n\nSOURCE:\n${value}` }];
    } else if (mimetype.startsWith("image/")) {
      content = [
        { type: "image", source: { type: "base64", media_type: mimetype, data: buffer.toString("base64") } },
        { type: "text", text: prompt },
      ];
    } else {
      content = [{ type: "text", text: `${prompt}\n\nSOURCE:\n${buffer.toString("utf8")}` }];
    }
  } else {
    content = [{ type: "text", text: `${prompt}\n\nSOURCE:\n${text || ""}` }];
  }
  return parseJSON(await askClaude(content));
}

/* --------------------------------------------------------------- Gmail */
export function oauthClient() {
  need(process.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/google/callback`
  );
}

export function googleAuthUrl() {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  });
}

export async function storeGoogleCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  await setKV("google_tokens", tokens);
}

async function gmail() {
  const tokens = await getKV("google_tokens");
  if (!tokens) throw new Error("Gmail is not connected. Open /auth/google once to connect it.");
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on("tokens", (t) => setKV("google_tokens", { ...tokens, ...t }));
  return google.gmail({ version: "v1", auth: client });
}

function headerOf(msg, name) {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function bodyText(msg) {
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) parts.push(Buffer.from(p.body.data, "base64").toString("utf8"));
    (p.parts || []).forEach(walk);
  };
  walk(msg.payload);
  return parts.join("\n").slice(0, 6000);
}

export async function findInvoicesInGmail(project) {
  const g = await gmail();
  const q = `${project.client} (invoice OR payment OR paid OR receipt) newer_than:1y`;
  const list = await g.users.messages.list({ userId: "me", q, maxResults: 12 });
  const ids = (list.data.messages || []).map((m) => m.id);
  const msgs = [];
  for (const id of ids) {
    const m = await g.users.messages.get({ userId: "me", id, format: "full" });
    msgs.push(`--- ${headerOf(m.data, "Date")} | from ${headerOf(m.data, "From")} | ${headerOf(m.data, "Subject")}\n${bodyText(m.data)}`);
  }
  if (msgs.length === 0) return { deposit: {}, balance: {}, note: "No matching emails found." };
  const text = await askClaude(
    `These are emails about the client "${project.client}". The project fee is ${project.projectFee} billed ${project.depositPct}% upfront and the rest on completion. Find the deposit invoice and the balance invoice. Respond with ONLY JSON, no fences:
{"deposit":{"invoiceNo":"","invoicedAt":"YYYY-MM-DD","dueAt":"YYYY-MM-DD","paidAt":""},"balance":{"invoiceNo":"","invoicedAt":"","dueAt":"","paidAt":""},"note":"one line on what you found"}
Use empty strings for anything you cannot find. Only set paidAt if an email clearly confirms payment was received.

EMAILS:
${msgs.join("\n\n")}`
  );
  return parseJSON(text);
}

export async function createGmailDraft({ to, subject, body }) {
  const g = await gmail();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");
  const res = await g.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  return res.data.id;
}

export async function sendGmail({ to, subject, body }) {
  const g = await gmail();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");
  await g.users.messages.send({ userId: "me", requestBody: { raw } });
}

/* ------------------------------------------------------ Stripe + Mercury */
export async function incomingPayments(days = 45) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const out = [];

  if (process.env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const charges = await stripe.charges.list({ created: { gte: since }, limit: 100 });
    for (const c of charges.data) {
      if (c.status !== "succeeded") continue;
      out.push({
        source: "stripe",
        date: new Date(c.created * 1000).toISOString().slice(0, 10),
        amount: c.amount / 100,
        currency: c.currency.toUpperCase(),
        from: c.billing_details?.name || c.customer_email || c.receipt_email || "",
        reference: c.description || c.id,
      });
    }
  }

  if (process.env.MERCURY_API_TOKEN) {
    const h = { Authorization: `Bearer ${process.env.MERCURY_API_TOKEN}` };
    const accts = await fetch("https://api.mercury.com/api/v1/accounts", { headers: h }).then((r) => r.json());
    const start = new Date(since * 1000).toISOString().slice(0, 10);
    for (const a of accts.accounts || []) {
      const tx = await fetch(
        `https://api.mercury.com/api/v1/account/${a.id}/transactions?start=${start}&limit=500`,
        { headers: h }
      ).then((r) => r.json());
      for (const t of tx.transactions || []) {
        if (t.amount <= 0 || t.status === "failed" || t.status === "cancelled") continue;
        out.push({
          source: "mercury",
          date: (t.postedAt || t.createdAt || "").slice(0, 10),
          amount: t.amount,
          currency: "USD",
          from: t.counterpartyName || "",
          reference: t.bankDescription || t.externalMemo || t.id,
        });
      }
    }
  }

  return out;
}

export async function matchPayments(payments, openItems) {
  if (payments.length === 0 || openItems.length === 0) return { matches: [], unmatched: payments.map((p) => `${p.source} ${p.date} ${p.amount} ${p.from}`) };
  const text = await askClaude(
    `Match incoming payments to outstanding invoices. Match on amount and payer name. Do not guess: if a payment is close but not clearly the same client, leave it unmatched.

OUTSTANDING:
${openItems.map((r) => `${r.client} | ${r.stage} | ${r.amount} | invoice ${r.invoiceNo || "unknown"}`).join("\n")}

PAYMENTS:
${payments.map((p) => `${p.source} | ${p.date} | ${p.amount} ${p.currency} | ${p.from} | ${p.reference}`).join("\n")}

Respond with ONLY JSON, no fences:
{"matches":[{"client":"","stage":"deposit|balance|monitoring","amount":0,"date":"YYYY-MM-DD","source":"stripe|mercury","reference":"","certainty":"high|low"}],"unmatched":["one line per payment you could not match"],"note":"one line summary"}`
  );
  return parseJSON(text);
}
