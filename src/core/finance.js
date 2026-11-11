import { bus } from './bus.js';
import { registerSignal, PROVENANCE } from './signals.js';
import { readLocalJSON, writeLocalJSON } from './storage.js';
import { register, log, respond } from './commands.js';
import { slug } from './track.js';
import {
  r3, parseAmount, monthKey, addMonths, daysUntilDue, summarise, budgetStatus,
  simulatePayoff, parseCsv, fingerprint,
} from './finance-math.js';

/**
 * Money, kept where you can ask about it.
 *
 * A ledger of what came in and went out, the debts you owe with their rates and
 * due days, and the budgets you set — stored in this browser and nowhere else.
 * No account is connected and no statement leaves the machine: you type entries
 * at the prompt (`spend 12 fuel`), or import a CSV your bank already lets you
 * download. That is deliberate. Screen-scraping a bank or holding its
 * credentials is a security decision that deserves its own design, not a side
 * effect of a dashboard.
 *
 * Every directive here is marked `private`. The assistant is handed them only
 * when its model runs on this machine; with a hosted model they are withheld,
 * so a question about your debts cannot ship the balances to a third party as a
 * tool result.
 */

const STORAGE_KEY = 'jarvis.finance';
const MAX_TRANSACTIONS = 20_000;

function blank() {
  return { v: 1, currency: 'JOD', transactions: [], debts: [], budgets: {} };
}

function normalise(raw) {
  const base = blank();
  if (!raw || typeof raw !== 'object') return base;
  return {
    v: 1,
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency.toUpperCase().slice(0, 6) : base.currency,
    transactions: Array.isArray(raw.transactions) ? raw.transactions.filter(validTransaction) : [],
    debts: Array.isArray(raw.debts) ? raw.debts.filter(validDebt) : [],
    budgets: raw.budgets && typeof raw.budgets === 'object' ? { ...raw.budgets } : {},
  };
}

function validTransaction(t) {
  return t && Number.isFinite(t.at) && Number.isFinite(t.amount)
    && t.amount > 0 && (t.kind === 'spend' || t.kind === 'income') && typeof t.category === 'string';
}

function validDebt(d) {
  return d && typeof d.name === 'string' && Number.isFinite(d.balance)
    && Number.isFinite(d.apr) && Number.isFinite(d.min);
}

// Declared last among the helpers above on purpose: it calls them while the
// module is still evaluating, and an arrow-function constant defined further
// down would not exist yet.
let data = normalise(readLocalJSON(STORAGE_KEY, null));

function persist() {
  writeLocalJSON(STORAGE_KEY, data);
  bus.emit('finance:change', {});
}

const id = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// --- Reading ------------------------------------------------------------------

export const currency = () => data.currency;
export const transactions = () => data.transactions;
export const debts = () => data.debts;
export const budgets = () => data.budgets;

export function fmt(amount) {
  const n = Number(r3(amount));
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${data.currency}`;
}

export const thisMonth = () => monthKey(Date.now());

export function monthSummary(month = thisMonth()) {
  return summarise(data.transactions, { month });
}

export function debtTotal() {
  return r3(data.debts.reduce((sum, d) => sum + Math.max(0, d.balance), 0));
}

/** A debt counts as handled for the month once its minimum has gone in. */
function settledThisMonth(debt) {
  return debt.payments?.month === thisMonth() && debt.payments.amount >= debt.min - 1e-9;
}

export function dueDebts(now = Date.now()) {
  return data.debts
    .filter((d) => d.balance > 0 && d.dueDay && !settledThisMonth(d))
    .map((d) => ({ ...d, days: daysUntilDue(d.dueDay, now) }))
    .filter((d) => d.days !== null)
    .sort((a, b) => a.days - b.days);
}

export function nextDueDays() {
  const due = dueDebts();
  return due.length ? due[0].days : null;
}

/** What the assistant is told when — and only when — its model is local. */
export function contextSummary() {
  const month = monthSummary();
  const due = dueDebts()[0];
  return {
    currency: data.currency,
    month: thisMonth(),
    income: month.income,
    spent: month.spend,
    topCategories: month.categories.slice(0, 3),
    debtTotal: debtTotal(),
    nextDue: due ? { name: due.name, inDays: due.days } : null,
    overBudget: budgetStatus(data.budgets, month).filter((b) => b.over).map((b) => b.category),
  };
}

// --- Writing ------------------------------------------------------------------

export function addTransaction({ kind, amount, category = 'other', note = '', at = Date.now() }) {
  const value = r3(amount);
  if (!(value > 0)) throw new Error('an amount must be greater than zero');
  const t = { id: id('t'), at, kind, amount: value, category: slug(category) || 'other', note: note.slice(0, 120) };
  data.transactions.push(t);
  if (data.transactions.length > MAX_TRANSACTIONS) data.transactions.splice(0, data.transactions.length - MAX_TRANSACTIONS);
  persist();
  return t;
}

export function undoLast() {
  const removed = data.transactions.pop();
  if (removed) persist();
  return removed ?? null;
}

/** Merge parsed rows in, skipping any already present. */
export function importTransactions(rows) {
  const seen = new Set(data.transactions.map(fingerprint));
  let added = 0;
  let duplicates = 0;
  for (const row of rows) {
    const key = fingerprint(row);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    data.transactions.push({ id: id('t'), ...row });
    added += 1;
  }
  data.transactions.sort((a, b) => a.at - b.at);
  if (added) persist();
  return { added, duplicates };
}

/** Find a debt by exact name, or by a prefix that matches exactly one. */
export function findDebt(name) {
  const wanted = slug(name || '');
  if (!wanted) return null;
  const exact = data.debts.find((d) => slug(d.name) === wanted);
  if (exact) return exact;
  const prefixed = data.debts.filter((d) => slug(d.name).startsWith(wanted));
  return prefixed.length === 1 ? prefixed[0] : null;
}

export function addDebt({ name, balance, apr, min, dueDay = null }) {
  if (!name) throw new Error('a debt needs a name');
  if (!(balance > 0)) throw new Error('the balance must be above zero');
  if (!(apr >= 0 && apr <= 200)) throw new Error('the rate is a yearly percentage between 0 and 200');
  if (!(min >= 0)) throw new Error('the minimum payment cannot be negative');
  if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) {
    throw new Error('the due day is a day of the month, 1 to 31');
  }
  const existing = data.debts.find((d) => slug(d.name) === slug(name));
  if (existing) {
    Object.assign(existing, { balance: r3(balance), apr, min: r3(min), dueDay });
  } else {
    data.debts.push({ id: id('d'), name: String(name).trim(), balance: r3(balance), apr, min: r3(min), dueDay, payments: null });
  }
  persist();
  return findDebt(name);
}

export function payDebt(name, amount) {
  const debt = findDebt(name);
  if (!debt) return null;
  const paid = r3(Math.min(amount, debt.balance));
  if (!(paid > 0)) throw new Error('a payment must be greater than zero');
  debt.balance = r3(debt.balance - paid);
  const month = thisMonth();
  debt.payments = debt.payments?.month === month
    ? { month, amount: r3(debt.payments.amount + paid) }
    : { month, amount: paid };
  data.transactions.push({ id: id('t'), at: Date.now(), kind: 'spend', amount: paid, category: 'debt', note: `payment: ${debt.name}` });
  persist();
  return { debt, paid };
}

export function removeDebt(name) {
  const debt = findDebt(name);
  if (!debt) return false;
  data.debts = data.debts.filter((d) => d !== debt);
  persist();
  return true;
}

export function setBudget(category, limit) {
  data.budgets[slug(category)] = r3(limit);
  persist();
}

export function removeBudget(category) {
  const key = slug(category);
  if (!(key in data.budgets)) return false;
  delete data.budgets[key];
  persist();
  return true;
}

export function setCurrency(code) {
  data.currency = String(code).toUpperCase().slice(0, 6);
  persist();
}

export function forgetAll() {
  data = blank();
  persist();
}

// --- Backup and import ---------------------------------------------------------

export function backupJSON() {
  return JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2);
}

/**
 * Bring a file in: a backup this module wrote, or a bank's CSV.
 * Returns a one-line description of what happened, never throws on bad input.
 */
export function importText(text, filename = '') {
  const trimmed = String(text).trim();
  if (!trimmed) return { ok: false, message: 'That file is empty.' };

  if (/\.json$/i.test(filename) || trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { return { ok: false, message: 'That is not valid JSON.' }; }
    const incoming = normalise(parsed);
    if (!incoming.transactions.length && !incoming.debts.length && !Object.keys(incoming.budgets).length) {
      return { ok: false, message: 'That backup holds no transactions, debts or budgets.' };
    }
    const { added, duplicates } = importTransactions(incoming.transactions);
    let debtsAdded = 0;
    for (const d of incoming.debts) {
      if (!findDebt(d.name)) { data.debts.push({ ...d, id: id('d') }); debtsAdded += 1; }
    }
    for (const [category, limit] of Object.entries(incoming.budgets)) {
      if (!(category in data.budgets)) data.budgets[category] = limit;
    }
    persist();
    return { ok: true, message: `Backup merged: ${added} transactions added, ${duplicates} already present, ${debtsAdded} debts added.` };
  }

  const { transactions: rows, skipped, problem } = parseCsv(trimmed);
  if (problem) return { ok: false, message: problem };
  const { added, duplicates } = importTransactions(rows);
  const tail = skipped ? ` ${skipped} row${skipped === 1 ? '' : 's'} could not be read.` : '';
  return { ok: true, message: `Imported ${added} transactions, ${duplicates} already present.${tail}` };
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Signals: so the sentinel can watch money like anything else ---------------

export function restoreFinance() {
  registerSignal({
    id: 'money:spent',
    label: 'SPENT THIS MONTH',
    unit: '',
    provenance: PROVENANCE.MEASURED,
    note: 'Sum of what you have logged or imported this month, excluding debt payments.',
    read: () => (data.transactions.length ? monthSummary().spend : null),
  });
  registerSignal({
    id: 'money:debt',
    label: 'TOTAL DEBT',
    unit: '',
    provenance: PROVENANCE.MEASURED,
    note: 'Sum of the debt balances you have entered.',
    read: () => (data.debts.length ? debtTotal() : null),
  });
  registerSignal({
    id: 'money:due',
    label: 'DAYS TO NEXT DEBT PAYMENT',
    unit: 'd',
    provenance: PROVENANCE.MEASURED,
    note: 'Days until the nearest due day among debts whose minimum has not yet gone in this month.',
    read: nextDueDays,
  });
}

// --- Directives ----------------------------------------------------------------

const warn = (text) => { log(text, 'warn', 'money'); return Promise.resolve(); };

/** `12.5 fuel at the pump` → { amount: 12.5, category: 'fuel', note: 'at the pump' } */
function parseEntry(args) {
  let amount = null;
  const words = [];
  for (const arg of args) {
    if (amount === null && /\d/.test(arg)) {
      const n = parseAmount(arg);
      if (n !== null) { amount = n; continue; }
    }
    words.push(arg);
  }
  return { amount, category: words[0] || 'other', note: words.slice(1).join(' ') };
}

function entryDirective(kind, name, summary, aliases, defaultCategory) {
  register({
    name,
    aliases,
    summary,
    private: true,
    run(args) {
      const { amount, category, note } = parseEntry(args);
      if (amount === null || amount <= 0) {
        return warn(`Usage: ${name} <amount> [${kind === 'income' ? 'source' : 'category'}] [note…]`);
      }
      const entry = addTransaction({ kind, amount, category: args.length > 1 ? category : defaultCategory, note });
      log(`${kind === 'income' ? '+' : '−'} ${fmt(entry.amount)}  ${entry.category}${entry.note ? `  — ${entry.note}` : ''}`, 'ok', 'money');

      if (kind === 'spend') {
        const limit = data.budgets[entry.category];
        if (limit) {
          const status = budgetStatus(data.budgets, monthSummary()).find((b) => b.category === entry.category);
          if (status.over) {
            log(`Over budget on ${entry.category}: ${fmt(status.spent)} of ${fmt(limit)}.`, 'warn', 'money');
            return respond(`That puts you over your ${entry.category} budget, sir.`);
          }
          return respond(`Logged. ${fmt(status.left)} left in ${entry.category}.`);
        }
      }
      return respond('Logged, sir.');
    },
  });
}

entryDirective('spend', 'spend', 'Log spending — spend <amount> [category] [note].', ['pay', 'expense'], 'other');
entryDirective('income', 'earn', 'Log income — earn <amount> [source] [note].', ['income'], 'income');

register({
  name: 'money',
  aliases: ['finance', 'wallet'],
  summary: 'This month in numbers — money [last|YYYY-MM] | list [n] | undo | import | export | currency <code> | forget all.',
  private: true,
  run(args) {
    const verb = (args[0] || '').toLowerCase();

    if (verb === 'undo') {
      const removed = undoLast();
      if (!removed) return warn('Nothing to undo.');
      log(`Removed: ${removed.kind} ${fmt(removed.amount)} ${removed.category}`, 'ok', 'money');
      return Promise.resolve();
    }

    if (verb === 'list') {
      const n = Math.min(50, Math.max(1, Number.parseInt(args[1], 10) || 10));
      const recent = data.transactions.slice(-n).reverse();
      if (!recent.length) return warn('No transactions yet. Try: spend 12 fuel');
      log(`LAST ${recent.length} TRANSACTIONS`, 'ok', 'money');
      for (const t of recent) {
        const day = new Date(t.at).toISOString().slice(0, 10);
        log(`  ${day}  ${(t.kind === 'income' ? '+' : '−') + fmt(t.amount)}`.padEnd(34) + ` ${t.category}${t.note ? `  ${t.note}` : ''}`, 'sys', 'money');
      }
      return Promise.resolve();
    }

    if (verb === 'currency') {
      if (!/^[a-zA-Z]{2,6}$/.test(args[1] || '')) return warn('Usage: money currency <code>  e.g. JOD, USD');
      setCurrency(args[1]);
      log(`Currency is now ${data.currency}. Existing amounts are not converted.`, 'ok', 'money');
      return Promise.resolve();
    }

    if (verb === 'export') {
      if (!data.transactions.length && !data.debts.length) return warn('Nothing to export yet.');
      download(`jarvis-finance-${new Date().toISOString().slice(0, 10)}.json`, backupJSON(), 'application/json');
      log('Backup downloaded. Your data lives only in this browser, so keep that file.', 'ok', 'money');
      return Promise.resolve();
    }

    if (verb === 'import') {
      bus.emit('finance:pick', {});
      log('Choose a bank CSV or a Jarvis backup (.json).', 'sys', 'money');
      return Promise.resolve();
    }

    if (verb === 'forget') {
      if ((args[1] || '').toLowerCase() !== 'all') return warn('This deletes every transaction, debt and budget. To confirm: money forget all');
      forgetAll();
      log('All financial data erased from this browser.', 'ok', 'money');
      return respond('Financial records cleared, sir.');
    }

    // Default: a month's summary.
    let month = thisMonth();
    if (verb === 'last') month = monthKey(addMonths(new Date(), -1).getTime());
    else if (/^\d{4}-\d{2}$/.test(verb)) month = verb;
    else if (verb) return warn(`Unknown option "${verb}". Try: help money`);

    const s = monthSummary(month);
    if (!s.count && !data.debts.length) {
      log('Nothing recorded yet. Try: spend 12 fuel · earn 1500 salary · debt add card 2000 24 60 15', 'sys', 'money');
      return respond('There is nothing in the books yet, sir.');
    }
    log(`— ${month} ————————————————`, 'ok', 'money');
    log(`  ${'IN'.padEnd(12)} ${fmt(s.income)}`, 'sys', 'money');
    log(`  ${'OUT'.padEnd(12)} ${fmt(s.spend)}`, 'sys', 'money');
    if (s.debtPaid) log(`  ${'DEBT PAID'.padEnd(12)} ${fmt(s.debtPaid)}`, 'sys', 'money');
    log(`  ${'NET'.padEnd(12)} ${(s.net >= 0 ? '+' : '−') + fmt(Math.abs(s.net))}`, s.net >= 0 ? 'ok' : 'warn', 'money');
    for (const c of s.categories.slice(0, 6)) log(`    ${c.name.padEnd(14)} ${fmt(c.total)}`, 'sys', 'money');
    for (const b of budgetStatus(data.budgets, s)) {
      log(`  budget ${b.category.padEnd(12)} ${b.pct}%  ${b.over ? 'OVER by ' + fmt(-b.left) : fmt(b.left) + ' left'}`, b.over ? 'warn' : 'sys', 'money');
    }
    if (data.debts.length) log(`  ${'DEBT'.padEnd(12)} ${fmt(debtTotal())} across ${data.debts.length}`, 'sys', 'money');

    const tone = s.net >= 0 ? `You are ahead by ${fmt(s.net)}` : `You are behind by ${fmt(-s.net)}`;
    return respond(`${month}: ${fmt(s.income)} in, ${fmt(s.spend)} out. ${tone}.`);
  },
});

register({
  name: 'budget',
  summary: 'Monthly limits — budget | budget <category> <amount> | budget remove <category>.',
  private: true,
  run(args) {
    if (args[0]?.toLowerCase() === 'remove') {
      const ok = removeBudget(args[1] || '');
      log(ok ? `Budget for ${slug(args[1])} removed.` : `No budget for "${args[1]}".`, ok ? 'ok' : 'warn', 'money');
      return Promise.resolve();
    }
    if (args.length >= 2) {
      const limit = parseAmount(args[args.length - 1]);
      const category = args.slice(0, -1).join(' ');
      if (limit === null || limit <= 0) return warn('Usage: budget <category> <monthly amount>');
      setBudget(category, limit);
      log(`Budget: ${slug(category)} ≤ ${fmt(limit)} a month.`, 'ok', 'money');
      return respond('Budget set.');
    }
    const status = budgetStatus(data.budgets, monthSummary());
    if (!status.length) return warn('No budgets yet. Try: budget groceries 200');
    log('BUDGETS THIS MONTH', 'ok', 'money');
    for (const b of status) {
      log(`  ${b.category.padEnd(14)} ${fmt(b.spent)} of ${fmt(b.limit)}  ${b.pct}%${b.over ? '  OVER' : ''}`, b.over ? 'warn' : 'sys', 'money');
    }
    return respond(`${status.filter((b) => b.over).length} of ${status.length} budgets exceeded, sir.`);
  },
});

function planLines(label, result) {
  if (result.neverPaid) {
    log(`  ${label}: never — payments do not outrun interest${result.stuck.length ? ` on ${result.stuck.join(', ')}` : ''}.`, 'warn', 'money');
    return;
  }
  const date = addMonths(new Date(), result.months);
  log(`  ${label}: ${result.months} months (${date.toISOString().slice(0, 7)}), interest ${fmt(result.totalInterest)}`, 'sys', 'money');
}

register({
  name: 'debt',
  aliases: ['debts', 'loan'],
  summary: 'Debts — debt | add <name> <balance> <apr%> <min> [dueDay] | pay <name> <amount> | plan [extra] [snowball] | remove <name>.',
  private: true,
  run(args) {
    const verb = (args[0] || 'list').toLowerCase();

    if (verb === 'add') {
      const [, name, balance, apr, min, dueDay] = args;
      try {
        const debt = addDebt({
          name,
          balance: parseAmount(balance),
          apr: Number.parseFloat(apr),
          min: parseAmount(min),
          dueDay: dueDay === undefined ? null : Number.parseInt(dueDay, 10),
        });
        log(`${debt.name}: ${fmt(debt.balance)} at ${debt.apr}% a year, minimum ${fmt(debt.min)}${debt.dueDay ? `, due on the ${debt.dueDay}th` : ''}.`, 'ok', 'money');
        return respond(`${debt.name} recorded, sir.`);
      } catch (error) {
        return warn(`${error.message}. Usage: debt add <name> <balance> <apr%> <min> [dueDay]`);
      }
    }

    if (verb === 'pay') {
      const amount = parseAmount(args[2]);
      if (!findDebt(args[1])) return warn(`No debt called "${args[1] || ''}". Try: debt`);
      if (amount === null || amount <= 0) return warn('Usage: debt pay <name> <amount>');
      const { debt, paid } = payDebt(args[1], amount);
      log(`Paid ${fmt(paid)} to ${debt.name}. Remaining ${fmt(debt.balance)}.`, 'ok', 'money');
      return respond(debt.balance === 0 ? `${debt.name} is cleared, sir. Well done.` : `Payment recorded. ${fmt(debt.balance)} remaining on ${debt.name}.`);
    }

    if (verb === 'remove' || verb === 'delete') {
      const ok = removeDebt(args[1] || '');
      log(ok ? `${args[1]} removed.` : `No debt called "${args[1] || ''}".`, ok ? 'ok' : 'warn', 'money');
      return Promise.resolve();
    }

    if (verb === 'plan') {
      let extra = 0;
      let strategy = 'avalanche';
      for (const a of args.slice(1)) {
        if (/^(snowball|avalanche)$/i.test(a)) strategy = a.toLowerCase();
        else if (parseAmount(a) !== null) extra = Math.max(0, parseAmount(a));
      }
      const open = data.debts.filter((d) => d.balance > 0);
      if (!open.length) return warn('No debts to plan. Add one: debt add card 2000 24 60 15');

      const chosen = simulatePayoff(open, { extra, strategy });
      const other = simulatePayoff(open, { extra, strategy: strategy === 'avalanche' ? 'snowball' : 'avalanche' });
      const minimums = simulatePayoff(open, { extra: 0, strategy });

      log(`PAYOFF PLAN — ${strategy.toUpperCase()}${extra ? `, ${fmt(extra)} extra a month` : ''}`, 'ok', 'money');
      log(`  Monthly budget ${fmt(chosen.budget)}. Order: ${chosen.order.join(' → ')}`, 'sys', 'money');
      planLines('Debt-free in', chosen);
      for (const p of chosen.payoffs) {
        log(`    ${p.name.padEnd(14)} cleared in month ${p.month} (${addMonths(new Date(), p.month).toISOString().slice(0, 7)})`, 'sys', 'money');
      }
      log(`  Compared with:`, 'sys', 'money');
      planLines(strategy === 'avalanche' ? 'snowball ' : 'avalanche', other);
      if (extra) planLines('minimums only', minimums);

      if (chosen.neverPaid) {
        return respond('At these payments the debt never clears, sir. The interest is outrunning you.');
      }
      let saved = '';
      if (extra && !minimums.neverPaid) {
        saved = ` The extra ${fmt(extra)} a month saves ${fmt(minimums.totalInterest - chosen.totalInterest)} in interest and ${minimums.months - chosen.months} months.`;
      }
      return respond(`Debt-free in ${chosen.months} months, paying ${fmt(chosen.totalInterest)} in interest.${saved}`);
    }

    // list
    if (!data.debts.length) return warn('No debts recorded. Try: debt add card 2000 24 60 15');
    log('DEBTS', 'ok', 'money');
    const due = new Map(dueDebts().map((d) => [d.id, d.days]));
    for (const d of [...data.debts].sort((a, b) => b.apr - a.apr)) {
      const days = due.get(d.id);
      const dueText = d.balance <= 0 ? 'cleared' : settledThisMonth(d) ? 'paid this month' : days === undefined ? '' : days === 0 ? 'DUE TODAY' : `due in ${days}d`;
      log(`  ${d.name.padEnd(14)} ${fmt(d.balance).padStart(16)}  ${String(d.apr).padStart(5)}%  min ${fmt(d.min)}  ${dueText}`, days !== undefined && days <= 3 ? 'warn' : 'sys', 'money');
    }
    log(`  ${'TOTAL'.padEnd(14)} ${fmt(debtTotal()).padStart(16)}`, 'ok', 'money');
    const next = dueDebts()[0];
    return respond(`You owe ${fmt(debtTotal())} in total.${next ? ` ${next.name} is due ${next.days === 0 ? 'today' : `in ${next.days} days`}.` : ''}`);
  },
});
