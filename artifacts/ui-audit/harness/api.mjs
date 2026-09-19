// Audit-only API client: signs a persona in and calls the public API with its cookie.
import { chromium, API, WEB, PERSONAS } from "./lib.mjs";
import { request as pwRequest } from "./pw-request.mjs";

export async function apiAs(persona) {
  const ctx = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Origin: WEB } });
  const [email, password] = PERSONAS[persona].creds();
  const r = await ctx.post("/auth/login", { data: { email, password } });
  if (r.status() !== 200) throw new Error(`login ${persona}: ${r.status()}`);
  const call = async (method, path, data) => {
    const res = await ctx.fetch(path, { method, data });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (res.status() >= 400) {
      const err = new Error(`${method} ${path} -> ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
      err.status = res.status();
      err.body = body;
      throw err;
    }
    return body;
  };
  return {
    get: (p) => call("GET", p),
    post: (p, d) => call("POST", p, d ?? {}),
    put: (p, d) => call("PUT", p, d ?? {}),
    patch: (p, d) => call("PATCH", p, d ?? {}),
    del: (p) => call("DELETE", p),
    dispose: () => ctx.dispose(),
  };
}
void chromium;
