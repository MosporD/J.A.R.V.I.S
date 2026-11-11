import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmount, summarise, budgetStatus, simulatePayoff, parseCsv, parseDate,
  daysUntilDue, addMonths, fingerprint, monthKey, r3,
} from '../src/core/finance-math.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('amounts parse across the formats banks actually emit', () => {
  assert.equal(parseAmount('12'), 12);
  assert.equal(parseAmount('1,250.50'), 1250.5);
  assert.equal(parseAmount('1.250,50'), 1250.5);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('1,250'), 1250);
  assert.equal(parseAmount('(40.00)'), -40);
  assert.equal(parseAmount('-12.345'), -12.345);
  assert.equal(parseAmount('JOD 99.9'), 99.9);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('--5'), null);
});

test('a month sums income and spending and keeps debt payments out of consumption', () => {
  const tx = [
    { at: at(2026, 11, 2), kind: 'income', category: 'salary', amount: 1500 },
    { at: at(2026, 11, 3), kind: 'spend', category: 'groceries', amount: 60.5 },
    { at: at(2026, 11, 9), kind: 'spend', category: 'groceries', amount: 39.5 },
    { at: at(2026, 11, 10), kind: 'spend', category: 'fuel', amount: 25 },
    { at: at(2026, 11, 11), kind: 'spend', category: 'debt', amount: 300 },
    { at: at(2026, 10, 30), kind: 'spend', category: 'fuel', amount: 999 },   // another month
  ];
  const s = summarise(tx, { month: '2026-11' });
  assert.equal(s.income, 1500);
  assert.equal(s.spend, 125);
  assert.equal(s.debtPaid, 300);
  assert.equal(s.net, 1075);
  assert.deepEqual(s.categories, [
    { name: 'groceries', total: 100 },
    { name: 'fuel', total: 25 },
  ]);
  assert.equal(summarise(tx, { month: '2026-11', includeDebtPayments: true }).spend, 425);
});

test('budget status reports what is left and flags an overspend', () => {
  const s = summarise([
    { at: at(2026, 11, 3), kind: 'spend', category: 'groceries', amount: 230 },
    { at: at(2026, 11, 4), kind: 'spend', category: 'fuel', amount: 20 },
  ], { month: '2026-11' });
  const status = budgetStatus({ groceries: 200, fuel: 80, fun: 50 }, s);
  const by = Object.fromEntries(status.map((b) => [b.category, b]));
  assert.equal(by.groceries.over, true);
  assert.equal(by.groceries.left, -30);
  assert.equal(by.fuel.pct, 25);
  assert.equal(by.fun.spent, 0);
  assert.equal(status[0].category, 'groceries', 'sorted by how close to the limit');
});

test('a single debt pays off in the number of months the maths says', () => {
  // 1,200 at 0% with 100 a month is exactly twelve months and no interest.
  const r = simulatePayoff([{ id: 'a', name: 'A', balance: 1200, apr: 0, min: 100 }]);
  assert.equal(r.months, 12);
  assert.equal(r.totalInterest, 0);
  assert.equal(r.totalPaid, 1200);

  // 1,000 at 12% APR (1% a month), 100 a month: the standard annuity result is 11 months.
  const q = simulatePayoff([{ id: 'a', name: 'A', balance: 1000, apr: 12, min: 100 }]);
  assert.equal(q.months, 11);
  assert.ok(q.totalInterest > 50 && q.totalInterest < 70, `interest ${q.totalInterest}`);
});

test('avalanche costs less interest than snowball, and both rolled minimums forward', () => {
  const debts = [
    { id: 'card', name: 'Card', balance: 3000, apr: 24, min: 90 },
    { id: 'car', name: 'Car', balance: 9000, apr: 6, min: 250 },
    { id: 'friend', name: 'Friend', balance: 500, apr: 0, min: 50 },
  ];
  const av = simulatePayoff(debts, { extra: 200, strategy: 'avalanche' });
  const sb = simulatePayoff(debts, { extra: 200, strategy: 'snowball' });
  assert.equal(av.order[0], 'Card');
  assert.equal(sb.order[0], 'Friend');
  assert.ok(av.totalInterest <= sb.totalInterest, 'avalanche never loses on interest');
  assert.ok(av.months <= sb.months + 1);

  // Money paid is principal plus interest, to the fils.
  const principal = debts.reduce((s, d) => s + d.balance, 0);
  assert.ok(Math.abs(av.totalPaid - (principal + av.totalInterest)) < 0.05);

  // Extra money must shorten the schedule.
  const without = simulatePayoff(debts, { extra: 0 });
  assert.ok(av.months < without.months);

  // The snowball clears the smallest debt first.
  assert.equal(sb.payoffs[0].name, 'Friend');
});

test('a payment that does not cover interest is reported, not looped on', () => {
  const r = simulatePayoff([{ id: 'a', name: 'Trap', balance: 10000, apr: 36, min: 100 }]);
  assert.equal(r.neverPaid, true);
  assert.equal(r.months, null);
  assert.deepEqual(r.stuck, ['Trap']);

  // A zero budget is the same answer, reached without simulating 600 months.
  const z = simulatePayoff([{ id: 'a', name: 'Z', balance: 100, apr: 5, min: 0 }]);
  assert.equal(z.neverPaid, true);
});

test('no debts is a finished schedule, not an error', () => {
  const r = simulatePayoff([]);
  assert.equal(r.months, 0);
  assert.equal(r.neverPaid, false);
  assert.equal(simulatePayoff([{ id: 'a', name: 'A', balance: 0, apr: 5, min: 10 }]).months, 0);
});

test('due dates count days to the next occurrence, including month-end clamping', () => {
  const now = at(2026, 11, 10);
  assert.equal(daysUntilDue(10, now), 0);
  assert.equal(daysUntilDue(13, now), 3);
  assert.equal(daysUntilDue(5, now), 25);              // rolls into December
  assert.equal(daysUntilDue(31, at(2026, 2, 10)), 18); // February has no 31st → the 28th
  assert.equal(daysUntilDue(0, now), null);
  assert.equal(daysUntilDue(32, now), null);
  assert.equal(addMonths(new Date(2026, 0, 31), 1).getDate(), 28);
});

test('dates read day-first unless the data proves otherwise', () => {
  assert.equal(parseDate('2026-11-05'), at(2026, 11, 5));
  assert.equal(parseDate('05/11/2026'), at(2026, 11, 5));        // ambiguous → day first
  assert.equal(parseDate('05/11/2026', { dayFirst: false }), at(2026, 5, 11));
  assert.equal(parseDate('25/11/2026'), at(2026, 11, 25));       // only a day can be 25
  assert.equal(parseDate('11/25/2026'), at(2026, 11, 25));       // only a month-first reading works
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate(''), null);
});

test('a single signed Amount column imports with directions and categories', () => {
  const csv = [
    'Date,Description,Amount,Balance',
    '03/11/2026,CARREFOUR MALL,-45.250,1000',
    '04/11/2026,"Salary, Zain",1500.000,2455',
    '05/11/2026,Careem ride,-3.5,2451',
    'not a date,garbage,-1,0',
  ].join('\n');
  const { transactions, skipped, problem } = parseCsv(csv);
  assert.equal(problem, null);
  assert.equal(skipped, 1);
  assert.equal(transactions.length, 3);
  assert.deepEqual(
    transactions.map((t) => [t.kind, t.amount, t.category]),
    [['spend', 45.25, 'groceries'], ['income', 1500, 'salary'], ['spend', 3.5, 'transport']],
  );
  assert.equal(transactions[1].note, 'Salary, Zain', 'a quoted comma stays inside its field');
});

test('separate Debit and Credit columns, semicolons and a BOM all import', () => {
  const csv = '﻿Date;Details;Debit;Credit\n2026-11-02;Zain bill;12,5;\n2026-11-03;Refund;;7,25\n';
  const { transactions, problem } = parseCsv(csv);
  assert.equal(problem, null);
  assert.deepEqual(transactions.map((t) => [t.kind, t.amount]), [['spend', 12.5], ['income', 7.25]]);
});

test('a file with no recognisable columns says so instead of importing nothing', () => {
  assert.match(parseCsv('foo,bar\n1,2').problem, /date/i);
  assert.match(parseCsv('Date,Memo\n2026-01-01,x').problem, /amount/i);
  assert.match(parseCsv('Date,Amount').problem, /no data rows/i);
});

test('re-importing the same statement is recognised row for row', () => {
  const a = { at: at(2026, 11, 3), kind: 'spend', amount: 45.25, note: 'Carrefour' };
  const b = { ...a, at: at(2026, 11, 3) + 3_600_000, note: ' CARREFOUR ' };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, amount: 45.26 }));
  assert.equal(monthKey(at(2026, 11, 3)), '2026-11');
  assert.equal(r3(0.1 + 0.2), 0.3);
});
