/**
 * Output presentation.
 *
 * Two modes, chosen automatically:
 *  - interactive (stderr is a TTY): colors, a live progress bar, aligned
 *    tables and a styled summary.
 *  - plain (CI, agents, pipes): no ANSI, no carriage returns, one line per
 *    event on stderr, and stable machine-readable `key: value` result lines
 *    on stdout.
 *
 * `NO_COLOR`, `TERM=dumb` and `FORCE_COLOR` are honoured independently of
 * interactivity.
 */

import { humanSize, isQuiet } from "./util";

export const interactive: boolean = Boolean(process.stderr.isTTY);

const colorEnabled: boolean =
  process.env["FORCE_COLOR"] !== undefined
    ? process.env["FORCE_COLOR"] !== "0"
    : interactive && process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";

const wrap =
  (open: string, close: string) =>
  (s: string): string =>
    colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

/** ANSI helpers — identity functions when color is disabled. */
export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  cyan: wrap("36", "39"),
  magenta: wrap("35", "39"),
};

/** Write a line to stderr without console.error's own TTY colorization. */
function eprintln(line: string) {
  process.stderr.write(line + "\n");
}

/** A single-line status message (stderr). */
export function status(msg: string) {
  if (isQuiet()) return;
  eprintln(interactive ? `${c.cyan("→")} ${msg}` : msg);
}

/** A success line (stderr). */
export function ok(msg: string) {
  if (isQuiet()) return;
  eprintln(interactive ? `${c.green("✓")} ${msg}` : msg);
}

/** A warning line (stderr). Never suppressed by --quiet. */
export function warn(msg: string) {
  eprintln(interactive ? `${c.yellow("!")} ${msg}` : `warning: ${msg}`);
}

/** An indented note line (stderr). */
export function note(msg: string) {
  if (isQuiet()) return;
  eprintln(interactive ? `  ${c.dim(msg)}` : `  ${msg}`);
}

/**
 * Final results go to stdout so scripts and agents can capture them.
 * In plain mode each entry is a stable `key: value` line; interactively the
 * same data is rendered as an aligned, colored block.
 */
export function result(pairs: [key: string, value: string][]) {
  if (interactive) {
    const w = Math.max(...pairs.map(([k]) => k.length));
    for (const [k, v] of pairs) console.log(`  ${c.dim(k.padEnd(w))}  ${v}`);
  } else {
    for (const [k, v] of pairs) console.log(`${k}: ${v}`);
  }
}

/** Render an aligned table. Interactive mode gets a bold, underlined header. */
export function table(rows: string[][]) {
  if (rows.length === 0) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (row: string[], decorate: (s: string) => string) =>
    "  " +
    row.map((cell, i) => decorate(i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
  rows.forEach((row, idx) => {
    if (idx === 0) console.log(fmt(row, (s) => c.bold(s)));
    else console.log(fmt(row, (s) => s));
  });
}

/**
 * Single-line progress reporter. Renders a live bar on a TTY; in plain mode
 * it stays silent until `finish()`, which the caller pairs with a one-line
 * summary so CI logs get exactly one line per download/extract.
 */
export class Progress {
  private last = 0;
  constructor(
    private label: string,
    private total: number,
  ) {}

  update(done: number) {
    if (isQuiet() || !interactive) return;
    const now = Date.now();
    if (now - this.last < 100 && done < this.total) return;
    this.last = now;
    const pct = this.total > 0 ? Math.min(100, Math.floor((done / this.total) * 100)) : 0;

    // Fit the whole line within the terminal width: a wrapped progress line
    // breaks \r-based redraws and leaves stale fragments on screen.
    const cols = process.stderr.columns || 80;
    let suffix = ` ${String(pct).padStart(3)}% ${humanSize(done)} / ${humanSize(this.total)}`;
    let label = this.label;
    let width = Math.min(28, cols - 1 - 2 - label.length - 1 - suffix.length);
    if (width < 10) {
      // Try a shorter suffix, then a shorter label.
      suffix = ` ${String(pct).padStart(3)}%`;
      width = Math.min(28, cols - 1 - 2 - label.length - 1 - suffix.length);
    }
    if (width < 10) {
      const room = Math.max(4, cols - 1 - 2 - 1 - suffix.length - 10);
      label = label.length > room ? label.slice(0, room - 1) + "…" : label;
      width = Math.min(28, cols - 1 - 2 - label.length - 1 - suffix.length);
    }
    if (width < 4) {
      // Hopelessly narrow terminal; skip the bar entirely.
      process.stderr.write(`\r  ${String(pct).padStart(3)}%\x1b[K`);
      return;
    }
    const filled = Math.min(width, Math.floor((width * pct) / 100));
    const bar = c.cyan("█".repeat(filled)) + c.dim("░".repeat(width - filled));
    process.stderr.write(`\r  ${label} ${bar}${suffix}\x1b[K`);
  }

  /** Clear the live bar (interactive only); the caller logs the summary line. */
  finish() {
    if (isQuiet() || !interactive) return;
    process.stderr.write(`\r\x1b[K`);
  }
}
