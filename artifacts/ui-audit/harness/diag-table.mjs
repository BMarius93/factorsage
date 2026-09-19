import { launch, personaContext, settle } from "./lib.mjs";
const b = await launch();
const ctx = await personaContext(b, "pro-heavy");
const p = await ctx.newPage();
for (const r of ["/backtests", "/monitors"]) {
  await p.goto(r); await settle(p, 800);
  const d = await p.evaluate(() => {
    const t = document.querySelector("[role=table]");
    let sc = t; while (sc && getComputedStyle(sc).overflowX === "visible") sc = sc.parentElement;
    const heads = [...t.querySelectorAll("[role=columnheader]")].map(h => `${h.textContent.trim()}:${Math.round(h.getBoundingClientRect().width)}`);
    const chip = [...t.querySelectorAll("a,span")].filter(e => /Global dividend/.test(e.textContent) && e.children.length===0)[0];
    const chain = []; for (let e = chip; e && e !== t; e = e.parentElement) chain.push(`${e.tagName}.${(e.className||"").toString().split(" ")[0].replace(/-module__\w+__/,"::")} w=${Math.round(e.getBoundingClientRect().width)} sw=${e.scrollWidth} ${getComputedStyle(e).display}`);
    return { scroller: sc && `${sc.className.toString().slice(0,60)} client=${sc.clientWidth} scroll=${sc.scrollWidth} overflowX=${getComputedStyle(sc).overflowX}`, heads, chain: chain.slice(0,6) };
  });
  console.log(r, JSON.stringify(d, null, 1));
}
await b.close();
