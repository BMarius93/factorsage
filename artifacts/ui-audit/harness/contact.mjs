// Review aid: composes several screenshots into one labelled sheet (scratch output, not evidence).
// usage: node contact.mjs <out.png> <colWidthPx> <file1> <file2> ...
import { chromium, OUT } from "./lib.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const [out, colWidth, ...files] = process.argv.slice(2);
const w = Number(colWidth) || 480;
const html = `<html><body style="margin:0;background:#333;font:12px sans-serif;color:#fff;display:flex;flex-wrap:wrap;gap:8px;padding:8px;align-items:flex-start">
${files
  .map((spec) => {
    // "file.png@y:h" crops to source pixels y..y+h (source width assumed = natural width).
    const [f, crop] = spec.split("@");
    const src = pathToFileURL(resolve(OUT, f)).href;
    if (!crop) return `<figure style="margin:0;width:${w}px"><figcaption style="padding:2px 0">${f}</figcaption><img style="width:${w}px;display:block;background:#fff" src="${src}"></figure>`;
    const [y, h, x = 0, cw = 0] = crop.split(":").map(Number);
    return `<figure style="margin:0;width:${w}px"><figcaption style="padding:2px 0">${f} [${y}+${h}]</figcaption><div style="width:${w}px;overflow:hidden;position:relative" data-y="${y}" data-h="${h}" data-x="${x}" data-w="${cw}"><img class="crop" style="display:block;background:#fff;max-width:none" src="${src}"></div></figure>`;
  })
  .join("\n")}</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.min(8 + files.length * (w + 8), 2400), height: 400 } });
const tmp = out.replace(/\.png$/, ".html");
writeFileSync(tmp, html);
await page.goto(pathToFileURL(tmp).href);
await page.waitForLoadState("load");
await page.evaluate(() => {
  for (const d of document.querySelectorAll("div[data-y]")) {
    const img = d.querySelector("img");
    const cw = Number(d.dataset.w) || img.naturalWidth;
    const k = d.clientWidth / cw;
    img.style.width = `${img.naturalWidth * k}px`;
    img.style.marginLeft = `${-Number(d.dataset.x) * k}px`;
    d.style.height = `${Number(d.dataset.h) * k}px`;
    img.style.marginTop = `${-Number(d.dataset.y) * k}px`;
  }
});
await page.screenshot({ path: out, fullPage: true });
await browser.close();
