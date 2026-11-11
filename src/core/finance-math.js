/**
 * The arithmetic of money, with no imports.
 *
 * Kept apart from `finance.js` for the same reason the gesture detector is
 * apart from the camera: the part that must be *right* — a payoff schedule, a
 * month's totals, a bank's CSV — should run in Node in milliseconds, with no
 * browser and no stored state to get in the way. A figure here that is off by
 * one month is a figure that tells you to stop paying a debt too early.
 *
 * Amounts are plain numbers rounded to three decimals, which is the finest unit
 * any currency in daily use here needs (the dinar has 1000 fils).
 */

export const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** "1,250.5" · "1250,5" · "(40.00)" · "-12" → a number, or null when it is not one. */
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  let s = String(text ?? '').trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }   // accounting negatives
  s = s.replace(/[^\d.,-]/g, '');                                   // strip currency symbols
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!s || /-/.test(s)) return null;

  // Both separators present: the last one is the decimal point.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    s = s.split(group).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    // A lone comma is a decimal point only when it is followed by 1–2 digits;
    // "1,250" is twelve hundred and fifty, "12,5" is twelve and a half.
    s = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? s.replace(',', '.') : s.split(',').join('');
  }
  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;
  return r3(negative ? -value : value);
}

export function monthKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Add whole calendar months, clamping the day (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** Whole days until the next time the calendar reaches `dueDay` (0 = today). */
export function daysUntilDue(dueDay, now = Date.now()) {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const thisMonthLast = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  let due = new Date(today.getFullYear(), today.getMonth(), Math.min(dueDay, thisMonthLast));
  if (due < today) {
    const nextLast = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();
    due = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(dueDay, nextLast));
  }
  return Math.round((due - today) / 86_400_000);
}

// --- Totals -----------------------------------------------------------------

/**
 * One month of movement.
 *
 * `debt` payments are excluded from spending by default: paying a loan down is
 * not consumption, and counting it makes the month you clear a card look like
 * the month you went on a spree.
 */
export function summarise(transactions, { month, includeDebtPayments = false } = {}) {
  let income = 0;
  let spend = 0;
  let debtPaid = 0;
  let count = 0;
  const byCategory = new Map();
  const bySource = new Map();

  for (const t of transactions) {
    if (month && monthKey(t.at) !== month) continue;
    count += 1;
    if (t.kind === 'income') {
      income += t.amount;
      bySource.set(t.category, (bySource.get(t.category) ?? 0) + t.amount);
    } else if (t.category === 'debt') {
      debtPaid += t.amount;
      if (includeDebtPayments) spend += t.amount;
    } else {
      spend += t.amount;
      byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amount);
    }
  }

  const sorted = (map) => [...map.entries()]
    .map(([name, total]) => ({ name, total: r3(total) }))
    .sort((a, b) => b.total - a.total);

  return {
    month: month ?? null,
    income: r3(income),
    spend: r3(spend),
    debtPaid: r3(debtPaid),
    net: r3(income - spend - (includeDebtPayments ? 0 : debtPaid)),
    count,
    categories: sorted(byCategory),
    sources: sorted(bySource),
  };
}

/** Each budgeted category against what has actually gone out this month. */
export function budgetStatus(budgets, summary) {
  const spent = new Map(summary.categories.map((c) => [c.name, c.total]));
  return Object.entries(budgets)
    .map(([category, limit]) => {
      const used = r3(spent.get(category) ?? 0);
      return {
        category,
        limit,
        spent: used,
        left: r3(limit - used),
        pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
        over: used > limit,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

// --- Debt -------------------------------------------------------------------

/**
 * Simulate paying a set of debts off, month by month.
 *
 * Interest accrues first, then the minimums are paid, then everything left in
 * the monthly budget goes to the priority debt. When a debt clears, its minimum
 * stays in the budget and rolls onto the next one — that rollover is the whole
 * reason snowball and avalanche work, and omitting it makes both look worse
 * than they are.
 *
 * Avalanche targets the highest rate first and minimises total interest.
 * Snowball targets the smallest balance first; it costs more but clears whole
 * debts sooner, which for some people is the difference between sticking with
 * a plan and abandoning it. Neither is "correct" — this reports both.
 *
 * @param {{id:string,name:string,balance:number,apr:number,min:number}[]} debts
 * @param {{extra?:number, strategy?:'avalanche'|'snowball', maxMonths?:number}} [options]
 */
export function simulatePayoff(debts, { extra = 0, strategy = 'avalanche', maxMonths = 600 } = {}) {
  const live = debts
    .filter((d) => d.balance > 0)
    .map((d) => ({ ...d, balance: d.balance, paidOff: null }));

  const order = [...live].sort((a, b) =>
    strategy === 'snowball'
      ? a.balance - b.balance || b.apr - a.apr
      : b.apr - a.apr || a.balance - b.balance);

  const budget = live.reduce((sum, d) => sum + d.min, 0) + Math.max(0, extra);
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;

  // A debt whose minimum does not even cover its interest can never shrink on
  // the minimum alone. Flag it — it is the most important thing this can say.
  const stuck = live
    .filter((d) => d.min <= (d.balance * d.apr) / 1200 + 1e-9)
    .map((d) => d.name);

  if (!live.length) {
    return { months: 0, totalInterest: 0, totalPaid: 0, budget: 0, order: [], payoffs: [], neverPaid: false, stuck: [] };
  }
  if (budget <= 0) {
    return { months: null, totalInterest: null, totalPaid: 0, budget: 0, order: order.map((d) => d.name), payoffs: [], neverPaid: true, stuck };
  }

  while (live.some((d) => d.balance > 0.0005) && month < maxMonths) {
    month += 1;

    for (const d of live) {
      if (d.balance <= 0) continue;
      const interest = (d.balance * d.apr) / 1200;
      d.balance += interest;
      totalInterest += interest;
    }

    let pool = budget;
    // Minimums first, on every debt still open at the start of the month.
    for (const d of live) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.min, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
      totalPaid += pay;
    }
    // Then whatever remains, down the priority list.
    for (const d of order) {
      if (pool <= 0) break;
      const target = live.find((x) => x.id === d.id);
      if (target.balance <= 0) continue;
      const pay = Math.min(pool, target.balance);
      target.balance -= pay;
      pool -= pay;
      totalPaid += pay;
    }
    for (const d of live) {
      if (d.balance <= 0.0005 && d.paidOff === null) { d.balance = 0; d.paidOff = month; }
    }
  }

  const neverPaid = live.some((d) => d.balance > 0.0005);
  return {
    months: neverPaid ? null : month,
    totalInterest: r3(totalInterest),
    totalPaid: r3(totalPaid),
    budget: r3(budget),
    order: order.map((d) => d.name),
    payoffs: live
      .filter((d) => d.paidOff !== null)
      .map((d) => ({ id: d.id, name: d.name, month: d.paidOff }))
      .sort((a, b) => a.month - b.month),
    neverPaid,
    stuck,
  };
}

// --- Importing a bank's CSV --------------------------------------------------

/** Split one CSV record, honouring "quoted, fields" and doubled quotes. */
export function splitCsvLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { cells.push(cell.trim()); cell = ''; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function detectDelimiter(headerLine) {
  const counts = [',', ';', '\t'].map((d) => [d, headerLine.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Banks disagree about everything, so dates are read day-first unless the data
 * proves otherwise (a first field above 12 can only be a day, and a second
 * field above 12 can only be one in month-first data). Ambiguous rows default
 * to day-first, which is what the banks in this region use.
 */
export function parseDate(text, { dayFirst = true } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    let first = dayFirst;
    if (a > 12) first = true;
    else if (b > 12) first = false;
    if (!first) [a, b] = [b, a];
    return validDate(year, b, a);
  }

  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 12);
  return d.getMonth() === month - 1 ? d.getTime() : null;
}

const CATEGORY_HINTS = [
  // First, so "Salary - Zain" is pay and not a phone bill.
  [/salary|payroll|wage/i, 'salary'],
  [/carrefour|supermarket|grocer|hypermarket|safeway|bakery|cozmo|miles/i, 'groceries'],
  [/fuel|petrol|gas station|jopetrol|total|shell|manaseer/i, 'fuel'],
  [/zain|orange|umniah|internet|mobile|topup|top-up/i, 'bills'],
  [/electric|water|nepco|miyahuna|rent|insurance/i, 'bills'],
  [/restaurant|cafe|coffee|talabat|careem food|mcdonald|kfc|burger|pizza/i, 'eating-out'],
  [/careem|uber|taxi|transport|parking/i, 'transport'],
  [/pharmacy|clinic|hospital|doctor|dental/i, 'health'],
  [/netflix|spotify|youtube|subscription|apple\.com|google \*/i, 'subscriptions'],
];

export function guessCategory(text) {
  for (const [pattern, category] of CATEGORY_HINTS) if (pattern.test(text)) return category;
  return 'other';
}

const HEADER_ALIASES = {
  date: /^(date|posting date|value date|transaction date|txn date|booking date|تاريخ)/i,
  note: /^(description|details|narration|narrative|memo|payee|merchant|reference|particulars|بيان)/i,
  amount: /^(amount|value|sum|المبلغ)$/i,
  debit: /^(debit|withdrawal|withdrawals|paid out|money out|dr|مدين)/i,
  credit: /^(credit|deposit|deposits|paid in|money in|cr|دائن)/i,
};

/**
 * Turn a bank statement's CSV into transactions.
 *
 * Handles one signed "amount" column or separate debit/credit columns. Rows it
 * cannot read are counted and returned, not silently dropped — an import that
 * quietly loses a fifth of a statement is worse than one that refuses.
 */
export function parseCsv(text, { dayFirst = true } = {}) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { transactions: [], skipped: 0, problem: 'The file has no data rows.' };

  const delimiter = detectDelimiter(lines[0]);
  const header = splitCsvLine(lines[0], delimiter);
  const col = {};
  header.forEach((name, i) => {
    for (const [key, pattern] of Object.entries(HEADER_ALIASES)) {
      if (col[key] === undefined && pattern.test(name.trim())) col[key] = i;
    }
  });

  if (col.date === undefined) return { transactions: [], skipped: 0, problem: 'No date column found. Expected a header like "Date".' };
  if (col.amount === undefined && col.debit === undefined && col.credit === undefined) {
    return { transactions: [], skipped: 0, problem: 'No amount column found. Expected "Amount", or "Debit" and "Credit".' };
  }

  const transactions = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    const at = parseDate(cells[col.date], { dayFirst });
    const note = (cells[col.note] ?? '').trim();

    let signed = null;
    if (col.amount !== undefined) signed = parseAmount(cells[col.amount]);
    else {
      const debit = parseAmount(cells[col.debit]);
      const credit = parseAmount(cells[col.credit]);
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    }
    if (at === null || signed === null || signed === 0) { skipped += 1; continue; }

    const kind = signed < 0 ? 'spend' : 'income';
    transactions.push({
      at,
      amount: r3(Math.abs(signed)),
      kind,
      category: guessCategory(note),
      note: note.slice(0, 120),
    });
  }
  return { transactions, skipped, problem: null };
}

/** Two rows are the same transaction when day, amount, direction and text agree. */
export function fingerprint(t) {
  const d = new Date(t.at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${t.kind}|${t.amount}|${String(t.note ?? '').toLowerCase().trim()}`;
}
