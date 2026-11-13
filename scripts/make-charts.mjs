// Draws the charts the README shows, as SVG files in a light and a dark version, from the
// measurements in bench/results.json: `npm run charts`.
//
//   node scripts/make-charts.mjs [--measure] [--out docs/media]
//
// `--measure` first re-runs `vertskim bench` on this repository (after `npm run build`) and
// writes what it finds into bench/results.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = join(ROOT, "bench/results.json");
const { values } = parseArgs({ options: { measure: { type: "boolean" }, out: { type: "string" } } });
const OUT = resolve(ROOT, values.out ?? "docs/media");

const results = JSON.parse(readFileSync(RESULTS, "utf8"));

if (values.measure) {
  const run = spawnSync(process.execPath, [join(ROOT, "packages/cli/dist/bin.js"), "--root", ROOT, "bench", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`vertskim bench failed:\n${run.stderr}`);
  const bench = JSON.parse(run.stdout);
  results.tokens = {
    measured: new Date().toISOString().slice(0, 10),
    project: bench.project,
    files: bench.files,
    symbols: bench.symbols,
    rows: bench.rows.map((row) => ({
      question: row.question,
      without: row.without,
      withGraph: row.withGraph,
      samples: row.samples,
      medianWithout: row.medianWithout,
      medianWith: row.medianWith,
      larger: row.larger,
    })),
  };
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
}

/**
 * Colours for GitHub's two page grounds. One hue carries the data; the lighter step of the
 * same hue is the track a bar is measured against. Text is never drawn in the data colour.
 */
const THEMES = {
  light: { ink: "#1f2328", soft: "#59636e", faint: "#6e7781", rule: "#d1d9e0", fill: "#2a78d6", track: "#b7d3f6" },
  dark: { ink: "#f0f6fc", soft: "#9198a1", faint: "#848d97", rule: "#3d444d", fill: "#3987e5", track: "#104281" },
};

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const WIDTH = 860;
const BAR = 14;
const ROW = 40;

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const number = (n) => n.toLocaleString("en-US");

/** A bar from the baseline: square where it starts, rounded where the value ends. */
function bar(x, y, width, colour) {
  const w = Math.max(width, 2);
  const r = Math.min(4, w / 2);
  const d = `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${BAR - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - r}z`;
  return `<path d="${d}" fill="${colour}"/>`;
}

/**
 * A chart of horizontal bars, one row each: a name on the left, the bar, and its value in
 * words at the end. With `legend`, every bar lies on a track that stands for the whole.
 *
 * rows: { name, detail?, share (0..1 of the bar area), value, aside? }
 */
function chart(theme, { title, subtitle, legend, rows, labelWidth, valueWidth, description }) {
  const c = THEMES[theme];
  const barX = labelWidth + 16;
  const barWidth = WIDTH - barX - valueWidth - 12;
  const top = 58 + (legend ? 30 : 0);
  const height = top + rows.length * ROW + 6;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" font-family='${FONT}'>`,
    `<title>${xml(title)}</title>`,
    `<desc>${xml(description)}</desc>`,
    `<text x="0" y="20" font-size="16" font-weight="600" fill="${c.ink}">${xml(title)}</text>`,
    `<text x="0" y="40" font-size="12" fill="${c.soft}">${xml(subtitle)}</text>`,
  );
  if (legend) {
    let x = 0;
    for (const [key, text] of legend) {
      out.push(`<rect x="${x}" y="57" width="12" height="12" rx="3" fill="${c[key]}"/>`);
      out.push(`<text x="${x + 18}" y="67" font-size="12" fill="${c.soft}">${xml(text)}</text>`);
      x += 18 + text.length * 6.4 + 22;
    }
  }
  rows.forEach((row, index) => {
    const y = top + index * ROW;
    const mid = y + ROW / 2;
    out.push(`<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="${c.rule}" stroke-width="1" opacity="0.6"/>`);
    out.push(`<text x="0" y="${mid + (row.detail ? -2 : 4.5)}" font-size="13" fill="${c.ink}">${xml(row.name)}</text>`);
    if (row.detail) {
      out.push(`<text x="0" y="${mid + 13}" font-size="11" fill="${c.faint}">${xml(row.detail)}</text>`);
    }
    if (legend) out.push(bar(barX, mid - BAR / 2, barWidth, c.track));
    out.push(bar(barX, mid - BAR / 2, row.share * barWidth, c.fill));
    const valueX = barX + barWidth + 12;
    out.push(
      `<text x="${valueX}" y="${mid + 4.5}" font-size="13" fill="${c.ink}">` +
        `<tspan font-weight="600">${xml(row.value)}</tspan>` +
        (row.aside ? `<tspan dx="8" font-size="12" fill="${c.soft}">${xml(row.aside)}</tspan>` : "") +
        "</text>",
    );
  });
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}

const { tokens, indexing, accuracy } = results;
const slowest = Math.max(...indexing.rows.map((row) => row.seconds));

const charts = {
  tokens: {
    title: "Tokens an assistant reads to answer one question",
    subtitle:
      `Medians on this repository (${number(tokens.files)} files, ${number(tokens.symbols)} symbols), ` +
      `from vertskim bench on ${tokens.measured}. Shorter is better.`,
    description: tokens.rows
      .map((row) => `${row.question}: ${row.medianWith} tokens with the graph, ${row.medianWithout} without.`)
      .join(" "),
    legend: [
      ["track", "Without the graph: reading files and searching text"],
      ["fill", "With Vertskim"],
    ],
    labelWidth: 236,
    valueWidth: 196,
    rows: tokens.rows.map((row) => ({
      name: row.question,
      detail: row.withGraph,
      share: row.medianWith / row.medianWithout,
      value: `${Math.round((1 - row.medianWith / row.medianWithout) * 100)}% less`,
      aside: `${number(row.medianWith)} vs ${number(row.medianWithout)}`,
    })),
  },
  indexing: {
    title: "Time to index a project for the first time",
    subtitle: "Seconds on one machine, single-threaded. Later updates only process the files that changed.",
    description: indexing.rows
      .map((row) => `${row.project} (${row.language}, ${row.files} files): ${row.seconds} seconds.`)
      .join(" "),
    labelWidth: 190,
    valueWidth: 150,
    rows: indexing.rows.map((row) => ({
      name: row.project,
      detail: row.language,
      share: row.seconds / slowest,
      value: `${row.seconds.toFixed(1)} s`,
      aside: `${number(row.files)} files`,
    })),
  },
  accuracy: {
    title: "How much of what a compiler knows, syntax alone gets right",
    subtitle: "Checked against a scip-typescript index of this repository with vertskim bench --scip.",
    description: accuracy.rows.map((row) => `${row.label}: ${row.part} of ${row.whole}.`).join(" "),
    legend: [
      ["track", "What the compiler says"],
      ["fill", "Found or confirmed"],
    ],
    labelWidth: 340,
    valueWidth: 170,
    rows: accuracy.rows.map((row) => ({
      name: row.label,
      share: row.part / row.whole,
      value: `${Math.round((row.part / row.whole) * 100)}%`,
      aside: `${number(row.part)} of ${number(row.whole)}`,
    })),
  },
};

mkdirSync(OUT, { recursive: true });
for (const [name, spec] of Object.entries(charts)) {
  for (const theme of Object.keys(THEMES)) {
    const file = `chart-${name}-${theme}.svg`;
    writeFileSync(join(OUT, file), chart(theme, spec));
    console.log(`${values.out ?? "docs/media"}/${file}`);
  }
}
