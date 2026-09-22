import type { SectionResult } from "./artifacts";

/** `SUMMARY.md`: the manifest, for a reader. Every number comes from the manifest itself. */
export function renderSummary(manifest: {
  generatedAt: string;
  git: { commit: string | null; branch: string | null };
  durationMs: number;
  context: Record<string, unknown>;
  totals: {
    comparisons: number;
    passed: number;
    failed: number;
    skipped: number;
    tolerancePasses: number;
  };
  status: string;
  sections: SectionResult[];
}): string {
  const lines = [
    "# Data-correctness audit — summary",
    "",
    `Generated ${manifest.generatedAt} at \`${manifest.git.commit ?? "?"}\` (${manifest.git.branch ?? "?"}), ` +
      `${Math.round(manifest.durationMs / 60000)} min. Database \`${String(manifest.context.database ?? "?")}\`, ` +
      `data as of ${String(manifest.context.asOf ?? "?")}.`,
    "",
    `**${manifest.status}** — ${manifest.totals.comparisons.toLocaleString("en-US")} comparisons: ` +
      `${manifest.totals.passed.toLocaleString("en-US")} passed (${manifest.totals.tolerancePasses.toLocaleString("en-US")} of them within a stated tolerance), ` +
      `${manifest.totals.failed.toLocaleString("en-US")} failed, ${manifest.totals.skipped.toLocaleString("en-US")} skipped.`,
    "",
    "| Section | Status | Comparisons | Pass | Fail | Skipped | Tolerance passes | Independent oracle | End to end |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...manifest.sections.map(
      (entry) =>
        `| ${entry.section} | ${entry.status} | ${entry.comparisons.toLocaleString("en-US")} | ${entry.passed.toLocaleString("en-US")} | ` +
        `${entry.failed.toLocaleString("en-US")} | ${entry.skipped.toLocaleString("en-US")} | ${entry.tolerancePasses.toLocaleString("en-US")} | ` +
        `${entry.independentOracle ? "yes" : "no"} | ${entry.endToEnd ? "yes" : "no"} |`,
    ),
    "",
    "Section detail is in each section's `summary.json`; failing items are listed under `failures/` and in each summary's `differences`.",
    "",
  ];
  for (const entry of manifest.sections) {
    if (entry.notes.length > 0) {
      lines.push(`- **${entry.section}**: ${entry.notes.join(" ")}`);
    }
  }
  return lines.join("\n");
}
