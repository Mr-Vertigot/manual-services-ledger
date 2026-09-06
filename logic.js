/* shared between server and browser: pure functions only, no React */

const DEFAULT_SETTINGS = {
  currency: "$",
  rateDev: 30,
  ratePm: 25,
  termsDays: 7,
  team: [
    { id: "cas", role: "Project management", name: "Casandra Visser", email: "" },
    { id: "ritvik", role: "Manual audit and VPAT", name: "Ritvik", email: "" },
    { id: "denis", role: "Developer", name: "Denis", email: "" },
  ],
  referralRules: [],   /* { match: "nolan", partner: "Nolan Klein", type: "pct" | "fixed", value: 20 } */
  autoEmails: true,
  lastReconcile: "",
  lastMonday: "",
};

const SERVICE_LABELS = {
  remediation: "Remediation",
  audit: "Manual audit",
  vpat: "VPAT",
  pdf: "PDF remediation",
  monitoring: "Monitoring",
};
const ONE_TIME = ["remediation", "audit", "vpat", "pdf"];
const SHORT = { remediation: "REM", audit: "AUDIT", vpat: "VPAT", pdf: "PDF", monitoring: "MON" };

const uid = () => Math.random().toString(36).slice(2, 10);
const num = (v) => (isNaN(parseFloat(v)) ? 0 : parseFloat(v));
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const monthName = (m) => new Date(m + "-02").toLocaleDateString("en-US", { month: "short", year: "numeric" });

function money(v, cur = "$") {
  const n = num(v);
  const s = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return (n < 0 ? "-" : "") + cur + s;
}

function newProject(partial = {}) {
  return {
    id: uid(),
    client: "",
    contractDate: today(),
    closed: false,
    services: { remediation: true, audit: false, vpat: false, pdf: false, monitoring: false },
    projectFee: 0,
    depositPct: 50,
    monitoringMonthly: 0,
    lead: { source: "", partner: "" },
    costs: {
      audit: { amount: 0, paidAt: "", note: "" },
      vpat: { amount: 0, paidAt: "", note: "" },
      pdf: { amount: 0, paidAt: "", note: "" },
      dev: { hours: 0, paidAt: "", note: "" },
      pm: { hours: 0, paidAt: "", note: "" },
      referral: { amount: 0, paidAt: "", note: "" },
      sales: { amount: 0, paidAt: "", note: "" },
    },
    deposit: { paidAt: "", invoiceNo: "", invoicedAt: "" },
    balance: { paidAt: "", invoiceNo: "", invoicedAt: "" },
    deliveredAt: "",
    monitoringLog: [],
    requests: {},
    upsellCall: { bookedAt: "", outcome: "" },
    notes: "",
    ...partial,
  };
}

function monitoringState(p) {
  if (!p.services.monitoring) return "none";
  if (!p.deliveredAt || p.deliveredAt > today()) return "pending";
  return "running";
}

function paymentState(p) {
  const fee = num(p.projectFee);
  const deposit = (fee * num(p.depositPct)) / 100;
  if (!p.deposit.paidAt && deposit > 0) return "awaiting-deposit";
  if (!p.balance.paidAt && fee - deposit > 0) return "balance-remaining";
  return "paid";
}
const STATE_LABEL = { "awaiting-deposit": "Awaiting deposit", "balance-remaining": "Balance remaining", paid: "Paid in full" };

function referralFor(p, s) {
  if (num(p.costs.referral.amount)) return num(p.costs.referral.amount);
  const src = `${p.lead.source} ${p.lead.partner}`.toLowerCase();
  const rule = (s.referralRules || []).find((r) => r.match && src.includes(r.match.toLowerCase()));
  if (!rule) return 0;
  return rule.type === "pct" ? (num(p.projectFee) * num(rule.value)) / 100 : num(rule.value);
}

function pnl(p, s) {
  const c = p.costs;
  const fee = num(p.projectFee);
  const audit = p.services.audit || p.services.remediation ? num(c.audit.amount) : 0;
  const vpat = p.services.vpat ? num(c.vpat.amount) : 0;
  const pdf = p.services.pdf ? num(c.pdf.amount) : 0;
  const dev = num(c.dev.hours) * num(s.rateDev);
  const pm = num(c.pm.hours) * num(s.ratePm);
  const referral = referralFor(p, s);
  const sales = num(c.sales.amount);
  const cost = audit + vpat + pdf + dev + pm + referral + sales;
  const margin = fee - cost;

  const mFee = num(p.monitoringMonthly);
  const log = p.monitoringLog || [];
  const mRevenue = log.length * mFee;
  const mCost = log.reduce((a, e) => a + num(e.hours), 0) * num(s.rateDev);
  const mMargin = mRevenue - mCost;

  const deposit = (fee * num(p.depositPct)) / 100;
  const balance = fee - deposit;
  const collected = (p.deposit.paidAt ? deposit : 0) + (p.balance.paidAt ? balance : 0);
  const state = monitoringState(p);

  return {
    fee, audit, vpat, pdf, dev, pm, referral, sales, cost, margin,
    marginPct: fee ? (margin / fee) * 100 : 0,
    mFee, mRevenue, mCost, mMargin, mMonths: log.length, state,
    mrr: state === "running" ? mFee : 0,
    pendingMrr: state === "pending" ? mFee : 0,
    deposit, balance, collected, outstanding: fee - collected,
  };
}

function tasksFor(p, s) {
  const out = [];
  if (p.closed) return out;
  const n = pnl(p, s);
  const k = (t) => `${p.id}:${t}`;

  if (!p.deposit.paidAt && n.deposit > 0)
    out.push({ key: k("deposit"), level: "amber", title: `Deposit unpaid ${money(n.deposit, s.currency)}`, project: p });

  if (p.deliveredAt && !p.balance.paidAt && n.balance > 0) {
    const inv = p.balance.invoicedAt;
    out.push({
      key: k("balance"),
      level: inv && daysBetween(inv, today()) > s.termsDays ? "red" : "amber",
      title: inv ? `Balance overdue ${money(n.balance, s.currency)}` : `Invoice the balance ${money(n.balance, s.currency)}`,
      project: p,
    });
  }

  if (p.deliveredAt && !p.services.monitoring && !p.upsellCall.bookedAt)
    out.push({ key: k("upsell"), level: "slate", title: "Book the monitoring call", project: p });

  if (monitoringState(p) === "running" && !(p.monitoringLog || []).some((e) => e.month === thisMonth()))
    out.push({ key: k("mon"), level: "green", title: `Log ${monthName(thisMonth())} monitoring hours`, project: p });

  return out;
}

function cashFlow(projects, s) {
  const rows = {};
  const touch = (m) => (rows[m] = rows[m] || { month: m, in: 0, out: 0, lines: [] });
  const add = (date, amt, label, dir) => {
    if (!date || !amt) return;
    const r = touch(date.slice(0, 7));
    r[dir] += amt;
    r.lines.push({ date, amt, label, dir });
  };

  projects.forEach((p) => {
    const n = pnl(p, s);
    const who = p.client || "Untitled";
    add(p.deposit.paidAt, n.deposit, `${who}, deposit`, "in");
    add(p.balance.paidAt, n.balance, `${who}, balance`, "in");
    (p.monitoringLog || []).forEach((e) => add(e.paidAt, n.mFee, `${who}, monitoring ${monthName(e.month)}`, "in"));

    const c = p.costs;
    add(c.audit.paidAt, n.audit, `${who}, audit, Ritvik`, "out");
    add(c.vpat.paidAt, n.vpat, `${who}, VPAT, Ritvik`, "out");
    add(c.pdf.paidAt, n.pdf, `${who}, PDF`, "out");
    add(c.dev.paidAt, n.dev, `${who}, dev, Denis`, "out");
    add(c.pm.paidAt, n.pm, `${who}, PM, Cas`, "out");
    add(c.referral.paidAt, n.referral, `${who}, referral, ${p.lead.partner || "partner"}`, "out");
    add(c.sales.paidAt, n.sales, `${who}, sales fee`, "out");
  });

  return Object.values(rows)
    .map((r) => ({ ...r, net: r.in - r.out, lines: r.lines.sort((a, b) => (a.date < b.date ? -1 : 1)) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

/* -------------------------------------------------- supplier emails */
const TAG = (p) => `[Ledger ${p.id}]`;

function supplierEmail(kind, p, member, cc) {
  const sold = Object.keys(SERVICE_LABELS).filter((k) => p.services[k]).map((k) => SERVICE_LABELS[k]).join(", ");
  const who = p.client || "the client";
  const first = (member.name || "").split(" ")[0];

  if (kind === "ritvik") {
    return {
      to: member.email,
      cc: cc?.email || "",
      subject: `${who}: audit cost for the P&L ${TAG(p)}`,
      body:
`Hi ${first},

This is an automated email from the manual services P&L Danny built.

New project: ${who}
Sold: ${sold}

For the P&L I need your cost on this one:
- Manual audit: $
${p.services.vpat ? "- VPAT: $\n" : ""}- Re-audit or QA rounds, if any: $

Reply to this email with the numbers, one per line. Nothing else needed.

Thanks`,
    };
  }

  return {
    to: member.email,
    cc: cc?.email || "",
    subject: `${who}: hours for the P&L ${TAG(p)}`,
    body:
`Hi ${first},

This is an automated email from the manual services P&L Danny built.

Project: ${who}
Sold: ${sold}

Reply with:
- Denis dev hours so far: 
- Your project management hours so far: 
${p.services.pdf ? "- PDF remediation cost: $\n" : ""}- Handed over to the client? (yes/no, and the date if yes)

One number per line. Nothing else needed.

Thanks`,
  };
}

export {
  DEFAULT_SETTINGS, SERVICE_LABELS, ONE_TIME, SHORT, STATE_LABEL, TAG,
  uid, num, today, thisMonth, daysBetween, monthName, money,
  newProject, monitoringState, paymentState, referralFor, pnl, tasksFor, cashFlow, supplierEmail,
};

/* upgrade projects saved under an older shape */
function normalize(p) {
  const d = newProject();
  const costs = Object.fromEntries(Object.keys(d.costs).map((k) => [k, { ...d.costs[k], ...((p.costs || {})[k] || {}) }]));
  return {
    ...d, ...p,
    services: { ...d.services, ...(p.services || {}) },
    costs,
    lead: { ...d.lead, ...(p.lead || {}) },
    deposit: { ...d.deposit, ...(p.deposit || {}) },
    balance: { ...d.balance, ...(p.balance || {}) },
    upsellCall: { ...d.upsellCall, ...(p.upsellCall || {}) },
    monitoringLog: Array.isArray(p.monitoringLog) ? p.monitoringLog : [],
    requests: p.requests || {},
    deliveredAt: p.deliveredAt || "",
    closed: !!p.closed || p.status === "closed",
  };
}
export { normalize };
