/* shared between server and browser: pure functions only, no React */

const DEFAULT_SETTINGS = {
  currency: "$",
  rateDev: 30,
  pmPct: 5,
  salesPct: 10,
  termsDays: 7,
  team: [
    { id: "pm", role: "Project management", name: "Casandra Visser", email: "" },
    { id: "auditor", role: "Manual audit and VPAT", name: "Ritvik", email: "" },
    { id: "dev", role: "Developer", name: "Igor", email: "" },
  ],
  lastTimesheetRun: "",
  lastReconcile: "",
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

/* ------------------------------------------------------------------ helpers */
const uid = () => Math.random().toString(36).slice(2, 10);
const num = (v) => (isNaN(parseFloat(v)) ? 0 : parseFloat(v));
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const daysBetween = (a, b) =>
  Math.round((new Date(b) - new Date(a)) / 86400000);
const monthName = (m) =>
  new Date(m + "-02").toLocaleDateString("en-US", { month: "short", year: "numeric" });

function money(v, cur = "$") {
  const n = num(v);
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return (n < 0 ? "-" : "") + cur + s;
}

function newProject(partial = {}) {
  return {
    id: uid(),
    client: "",
    contractDate: today(),
    status: "active",
    services: { remediation: true, audit: false, vpat: false, pdf: false, monitoring: false },
    projectFee: 0,
    depositPct: 50,
    monitoringMonthly: 0,
    monitoringMonths: 12,
    monitoringStartsAt: "",
    monitoringLog: [],
    lead: { source: "", partner: "", feeType: "pct", feeValue: 0, feePaid: false },
    auditCost: 0,
    vpatCost: 0,
    pdfCost: 0,
    devLog: [],
    devRateOverride: null,
    deposit: { invoiceNo: "", invoicedAt: "", dueAt: "", paidAt: "" },
    balance: { invoiceNo: "", invoicedAt: "", dueAt: "", paidAt: "" },
    deliveredAt: "",
    upsellCall: { bookedAt: "", outcome: "" },
    notes: "",
    ...partial,
  };
}

function devRate(p, s) {
  return p.devRateOverride === null || p.devRateOverride === "" ? num(s.rateDev) : num(p.devRateOverride);
}

function devHours(p) {
  return (p.devLog || []).reduce((a, e) => a + num(e.hours), 0);
}

/* monitoring cannot run before the one-time work is handed over */
function monitoringState(p) {
  if (!p.services.monitoring) return "none";
  if (!p.deliveredAt) return "pending";
  const start = p.monitoringStartsAt || p.deliveredAt;
  return start > today() ? "pending" : "running";
}

function dueDate(inv, s) {
  if (!inv) return "";
  if (inv.dueAt) return inv.dueAt;
  if (!inv.invoicedAt) return "";
  const d = new Date(inv.invoicedAt);
  d.setDate(d.getDate() + num(s.termsDays));
  return d.toISOString().slice(0, 10);
}

function overdueBy(inv, s) {
  const due = dueDate(inv, s);
  return due ? daysBetween(due, today()) : null;
}

function pnl(p, s) {
  const dr = devRate(p, s);
  const dh = devHours(p);

  /* ---- one time: remediation, manual audit, VPAT, PDF remediation ---- */
  const fee = num(p.projectFee);
  const referral =
    p.lead.feeType === "pct" ? (fee * num(p.lead.feeValue)) / 100 : num(p.lead.feeValue);
  const audit = num(p.auditCost);
  const vpat = num(p.vpatCost);
  const pdf = num(p.pdfCost);
  const dev = dh * dr;
  const labor = audit + vpat + pdf + dev;
  const pm = (fee * num(s.pmPct)) / 100;
  const sales = (fee * num(s.salesPct)) / 100;
  const overhead = pm + sales;
  const cost = referral + labor + overhead;
  const margin = fee - cost;

  /* ---- ongoing: monitoring, one row per month actually served ---- */
  const mFee = num(p.monitoringMonthly);
  const state = monitoringState(p);
  const log = p.monitoringLog || [];
  const mHours = log.reduce((a, e) => a + num(e.hours), 0);
  const mRevenue = log.length * mFee;
  const mLabor = mHours * dr;
  const mOverhead = (mRevenue * (num(s.pmPct) + num(s.salesPct))) / 100;
  const mCost = mLabor + mOverhead;
  const mMargin = mRevenue - mCost;
  const mCollected = log.filter((e) => e.paidAt).length * mFee;
  const mOutstanding = mRevenue - mCollected;

  /* typical month, for the MRR view */
  const mAvgHours = log.length ? mHours / log.length : 0;
  const mMonthMargin = mFee - mAvgHours * dr - (mFee * (num(s.pmPct) + num(s.salesPct))) / 100;

  const deposit = (fee * num(p.depositPct)) / 100;
  const balance = fee - deposit;
  const collected = (p.deposit.paidAt ? deposit : 0) + (p.balance.paidAt ? balance : 0);

  return {
    fee, referral, labor, audit, vpat, pdf, dev, dh, dr, pm, sales, overhead, cost, margin,
    marginPct: fee ? (margin / fee) * 100 : 0,
    state, mFee, mHours, mRevenue, mLabor, mOverhead, mCost, mMargin, mCollected, mOutstanding,
    mMonths: log.length, mAvgHours, mMonthMargin,
    mMarginPct: mRevenue ? (mMargin / mRevenue) * 100 : 0,
    mrr: state === "running" ? mFee : 0,
    pendingMrr: state === "pending" ? mFee : 0,
    deposit, balance, collected,
    outstanding: fee - collected + mOutstanding,
    oneTimeOutstanding: fee - collected,
  };
}

/* month by month, one time recognised on handover, monitoring on the month served */
function monthlyPnl(projects, s) {
  const rows = {};
  const touch = (m) =>
    (rows[m] = rows[m] || { month: m, oneRev: 0, oneCost: 0, monRev: 0, monCost: 0 });

  projects.forEach((p) => {
    const n = pnl(p, s);
    if (p.deliveredAt && n.fee) {
      const r = touch(p.deliveredAt.slice(0, 7));
      r.oneRev += n.fee;
      r.oneCost += n.cost;
    }
    (p.monitoringLog || []).forEach((e) => {
      if (!e.month) return;
      const r = touch(e.month);
      r.monRev += n.mFee;
      r.monCost += num(e.hours) * n.dr + (n.mFee * (num(s.pmPct) + num(s.salesPct))) / 100;
    });
  });

  return Object.values(rows)
    .map((r) => ({
      ...r,
      oneMargin: r.oneRev - r.oneCost,
      monMargin: r.monRev - r.monCost,
      total: r.oneRev - r.oneCost + (r.monRev - r.monCost),
      rev: r.oneRev + r.monRev,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}


function tasksFor(p, s) {
  const out = [];
  const k = (t) => `${p.id}:${t}`;
  if (p.status === "closed") return out;
  const n = pnl(p, s);

  if (!p.deposit.paidAt && n.deposit > 0) {
    const od = overdueBy(p.deposit, s);
    out.push({
      key: k("deposit"),
      level: od > 0 ? "red" : "amber",
      title: `Deposit unpaid: ${money(n.deposit, s.currency)}`,
      detail: p.deposit.invoicedAt
        ? `Invoice ${p.deposit.invoiceNo || "?"} due ${dueDate(p.deposit, s)}, ${od > 0 ? `${od} days overdue` : `due in ${-od} days`}.`
        : "Not invoiced yet. Work should not start before the deposit lands.",
      project: p,
    });
  }

  if (p.status === "delivered" && !p.balance.paidAt) {
    const od = overdueBy(p.balance, s);
    out.push({
      key: k("balance"),
      level: od > 0 ? "red" : "amber",
      title: `Balance unpaid: ${money(n.balance, s.currency)}`,
      detail: p.balance.invoicedAt
        ? `Invoice ${p.balance.invoiceNo || "?"} due ${dueDate(p.balance, s)}, ${od > 0 ? `${od} days overdue` : `due in ${-od} days`}.`
        : "Delivered but the balance has not been invoiced.",
      project: p,
    });
  }

  if (p.status === "delivered" && !p.services.monitoring && !p.upsellCall.bookedAt) {
    out.push({
      key: k("upsell"),
      level: "slate",
      title: "Book the monitoring call",
      detail:
        "No monitoring on this contract. Sales should call before the site drifts out of compliance: core updates, plugin updates and client edits are not covered once remediation ends.",
      project: p,
    });
  }

  if (p.services.monitoring && p.status !== "draft") {
    const st = monitoringState(p);
    if (st === "pending") {
      out.push({
        key: k("monitoring-pending"),
        level: "slate",
        title: `Monitoring signed but not started: ${money(n.mFee, s.currency)}/mo`,
        detail: p.deliveredAt
          ? `Starts ${p.monitoringStartsAt || p.deliveredAt}. Not counted in MRR until then.`
          : "Starts once remediation is handed over. Not counted in MRR yet.",
        project: p,
      });
    } else if (st === "running" && !(p.monitoringLog || []).some((e) => e.month === thisMonth())) {
      out.push({
        key: k("monitoring"),
        level: "green",
        title: `Log ${monthName(thisMonth())} monitoring for ${p.client || "this client"}`,
        detail: `${money(n.mFee, s.currency)}/mo. Run the scan, fix what it finds, then log the dev hours so the month has a real margin.`,
        project: p,
      });
    }
  }

  if (p.lead.partner && !p.lead.feePaid && num(n.referral) > 0 && p.deposit.paidAt) {
    out.push({
      key: k("referral"),
      level: "amber",
      title: `Referral fee owed to ${p.lead.partner}: ${money(n.referral, s.currency)}`,
      detail: "Deposit has landed, so the payout is due.",
      project: p,
    });
  }
  return out;
}


function weeklyEmail(member, projects, settings) {
  const open = projects.filter((p) => p.status === "active" || p.status === "delivered");
  const list = open.map((p) => `- ${p.client || "Untitled"}`).join("\n");
  const week = today();

  if (member.id === "dev") {
    return {
      subject: `Hours this week, ${week}`,
      body: `Hi ${member.name},\n\nQuick one for the ledger. How many hours did you put into each of these this week?\n\n${list}\n\nJust reply with the project and the number of hours, nothing formal. If you touched something not on the list, add it.\n\nThanks`,
    };
  }
  if (member.id === "auditor") {
    return {
      subject: `Audit and VPAT costs, ${week}`,
      body: `Hi ${member.name},\n\nFor the P&L I need your project cost on the manual audit and the VPAT for these:\n\n${list}\n\nOne number per project per deliverable is enough. Also tell me which ones are finished so I know when to invoice the balance.\n\nThanks`,
    };
  }
  return {
    subject: `Project status, ${week}`,
    body: `Hi ${member.name},\n\nWeekly check on the open manual services projects:\n\n${list}\n\nFor each one: where is it, is anything blocked, and is it ready for handover? If a project is done, say so and I will trigger the balance invoice.\n\nThanks`,
  };
}



export { DEFAULT_SETTINGS, SERVICE_LABELS, ONE_TIME, SHORT, uid, num, today, thisMonth, daysBetween, monthName, money, newProject, devRate, devHours, monitoringState, dueDate, overdueBy, pnl, monthlyPnl, tasksFor, weeklyEmail };
