// Generates the evidence index (Markdown) and summary counts from manifest.json.
import { readFileSync, writeFileSync } from "node:fs";
const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")).entries;
const byArea = {};
for (const e of m) (byArea[e.file.split("/")[0]] ??= []).push(e);
let md = "";
for (const [area, rows] of Object.entries(byArea).sort()) {
  md += `\n#### ${area}/ (${rows.length})\n\n| File | Persona | Viewport | State | Mocks |\n|---|---|---|---|---|\n`;
  for (const e of rows) md += `| \`${e.file.split("/")[1]}\` | ${e.persona} | ${e.viewport} | ${e.state.replace(/\|/g, "/")} | ${(e.mocks || []).join("; ").replace(/\|/g, "/") || "—"} |\n`;
}
writeFileSync(new URL("../EVIDENCE_INDEX.md", import.meta.url), `# UI audit evidence index\n\nGenerated from \`manifest.json\` (${m.length} screenshots).\n${md}`);
const count = (k) => Object.entries(m.reduce((a, e) => ((a[e[k]] = (a[e[k]] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
console.log(m.length, JSON.stringify(count("persona")), JSON.stringify(count("viewport")), JSON.stringify(Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, v.length]))));
console.log("mocked:", m.filter((e) => e.mocks?.length).length);
