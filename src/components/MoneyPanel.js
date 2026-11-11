import { Component } from '../core/component.js';
import { bus } from '../core/bus.js';
import { budgetStatus } from '../core/finance-math.js';
import {
  monthSummary, thisMonth, debts, budgets, debtTotal, dueDebts, fmt, importText, transactions,
} from '../core/finance.js';

/**
 * The month, and what you owe, at a glance.
 *
 * Three questions, in the order they are asked: am I ahead this month, am I
 * inside my budgets, and what is due. Anything deeper is a directive away
 * (`money`, `debt plan`) — a panel that tries to be the spreadsheet is a
 * spreadsheet that is worse at it.
 *
 * Text that came from the user or from an imported file is escaped before it
 * goes near innerHTML. A bank statement's merchant name is not trusted markup.
 */

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const REFRESH_MS = 60_000;   // the month rolls over, and due-in days tick, without any event

export class MoneyPanel extends Component {
  render() {
    this.body = this.$('[data-money-body]');
    this.monthLabel = this.$('[data-money-month]');
    this.file = this.$('[data-money-file]');
    this.importButton = this.$('[data-money-import]');

    this.on('finance:change', () => this.paint());
    this.on('finance:pick', () => this.file?.click());

    if (this.importButton && this.file) {
      this.listen(this.importButton, 'click', () => this.file.click());
      this.listen(this.file, 'change', () => this.readFile());
    }

    const timer = setInterval(() => this.paint(), REFRESH_MS);
    this.track(() => clearInterval(timer));
    this.paint();
  }

  async readFile() {
    const file = this.file.files?.[0];
    this.file.value = '';           // so choosing the same file again still fires
    if (!file) return;
    try {
      const text = await file.text();
      const result = importText(text, file.name);
      bus.emit('log', { level: result.ok ? 'ok' : 'warn', tag: 'money', text: result.message });
    } catch (error) {
      bus.emit('log', { level: 'warn', tag: 'money', text: `Could not read ${file.name} — ${error.message}` });
    }
  }

  paint() {
    if (!this.body) return;
    if (this.monthLabel) this.monthLabel.textContent = thisMonth();

    const owed = debts();
    const empty = !transactions().length && !owed.length;
    if (empty) {
      this.body.innerHTML = `
        <p class="font-mono text-[0.6875rem] leading-relaxed text-ink-dim">
          Nothing on the books. Log as you go —
          <span class="text-hud">spend 12 fuel</span>,
          <span class="text-hud">earn 1500 salary</span>,
          <span class="text-hud">debt add card 2000 24 60 15</span> —
          or import a statement CSV with the button above.
        </p>`;
      return;
    }

    const month = monthSummary();
    const net = month.net;
    const rows = [];

    rows.push(`
      <div class="grid grid-cols-3 gap-2 text-center">
        ${this.stat('IN', fmt(month.income), 'flat')}
        ${this.stat('OUT', fmt(month.spend), 'flat')}
        ${this.stat('NET', `${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}`, net >= 0 ? 'good' : 'bad')}
      </div>`);

    const status = budgetStatus(budgets(), month);
    if (status.length) {
      rows.push(`<div class="space-y-1.5">${status.slice(0, 5).map((b) => this.budget(b)).join('')}</div>`);
    } else if (month.categories.length) {
      rows.push(`
        <div class="font-mono text-[0.6875rem] text-ink-dim">
          ${month.categories.slice(0, 3).map((c) => `${escapeHtml(c.name)} <span class="text-ink">${fmt(c.total)}</span>`).join(' · ')}
        </div>`);
    }

    if (owed.length) rows.push(this.debtBlock());

    this.body.innerHTML = rows.join('');
  }

  stat(label, value, tone) {
    const colour = tone === 'good' ? 'text-hud' : tone === 'bad' ? 'text-caution' : 'text-ink';
    return `
      <div class="min-w-0">
        <div class="label-hud">${label}</div>
        <div class="truncate font-mono text-[0.8rem] ${colour} tabular" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
      </div>`;
  }

  budget(b) {
    const width = Math.min(100, b.pct);
    const tone = b.over ? 'alert' : b.pct >= 80 ? 'warn' : 'ok';
    return `
      <div>
        <div class="flex items-baseline justify-between font-mono text-[0.6875rem]">
          <span class="label-hud">${escapeHtml(b.category)}</span>
          <span class="${b.over ? 'text-alert' : 'text-ink-dim'} tabular">${fmt(b.spent)} / ${fmt(b.limit)}</span>
        </div>
        <div class="meter" data-tone="${tone}">
          <div class="meter-track"><div class="meter-fill" style="width:${width}%"></div></div>
        </div>
      </div>`;
  }

  debtBlock() {
    const due = new Map(dueDebts().map((d) => [d.id, d.days]));
    const lines = [...debts()]
      .filter((d) => d.balance > 0)
      .sort((a, b) => (due.get(a.id) ?? 99) - (due.get(b.id) ?? 99) || b.apr - a.apr)
      .slice(0, 4)
      .map((d) => {
        const days = due.get(d.id);
        const soon = days !== undefined && days <= 3;
        const dueText = days === undefined ? '' : days === 0 ? 'TODAY' : `${days}d`;
        return `
          <div class="flex items-baseline justify-between gap-2 font-mono text-[0.6875rem]">
            <span class="truncate text-ink-dim">${escapeHtml(d.name)}</span>
            <span class="shrink-0 tabular ${soon ? 'text-caution' : 'text-ink'}">
              ${fmt(d.balance)}${dueText ? ` <span class="${soon ? 'text-caution' : 'text-ink-mute'}">· ${dueText}</span>` : ''}
            </span>
          </div>`;
      }).join('');

    return `
      <div class="border-t border-hud/10 pt-2">
        <div class="mb-1 flex items-baseline justify-between">
          <span class="label-hud">DEBT</span>
          <span class="font-mono text-[0.75rem] text-ink tabular">${fmt(debtTotal())}</span>
        </div>
        <div class="space-y-0.5">${lines}</div>
      </div>`;
  }
}
