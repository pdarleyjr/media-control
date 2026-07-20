const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-csp-"));
const DB_PATH = path.join(dbDir, "csp.db");

function parseCSP(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    const dir = trimmed.slice(0, sp);
    const vals = trimmed.slice(sp + 1).trim().split(/\s+/).filter(Boolean);
    out[dir] = vals;
  }
  return out;
}

let server;
function startServer() {
  server = spawn("node", ["server.js"], {
    cwd: "/app/server",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      DB_PATH,
      APP_URL: BASE,
      DISABLE_REGISTRATION: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.unref();
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/version");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server never became ready");
}

async function cspFor(route) {
  const r = await fetch(BASE + route, { redirect: "manual" });
  return { status: r.status, csp: parseCSP(r.headers.get("content-security-policy")) };
}

after(() => {
  try { server && server.kill("SIGKILL"); } catch {}
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
});

test("route-scoped CSP isolates the podium USB-agent loopback origin", async () => {
  startServer();
  await waitReady();

  const app = await cspFor("/app");
  const cons = await cspFor("/console/classroom-1");
  const root = await cspFor("/");
  const player = await cspFor("/player");
  const widget = await cspFor("/widget");
  const kiosk = await cspFor("/kiosk");

  console.log("CSP /app connect-src:", app.csp["connect-src"]);
  console.log("CSP /console/classroom-1 connect-src:", cons.csp["connect-src"]);
  console.log("routes:", JSON.stringify({ app: app.status, root: root.status, player: player.status, widget: widget.status, kiosk: kiosk.status }));

  // 1) console permits the podium USB-agent loopback origin ONLY there
  assert.ok(cons.csp["connect-src"], "/console should have connect-src");
  assert.ok(
    cons.csp["connect-src"].includes("http://127.0.0.1:8755"),
    "/console should allow http://127.0.0.1:8755 in connect-src"
  );

  // 2) /app must NOT permit the podium-agent origin
  assert.ok(app.csp["connect-src"], "/app should have connect-src");
  assert.ok(
    !app.csp["connect-src"].includes("http://127.0.0.1:8755"),
    "/app must NOT allow http://127.0.0.1:8755"
  );

  // 3) normal dashboard route (root) redirects and does not carry the agent origin
  assert.equal(root.status, 302, "root should redirect to /app");
  if (root.csp["connect-src"]) {
    assert.ok(!root.csp["connect-src"].includes("http://127.0.0.1:8755"), "root must NOT allow agent origin");
  }

  // 4) /player is a CSP opt-out render route; must not carry the agent origin
  const playerStr = Object.values(player.csp).flat().join(" ");
  assert.ok(!playerStr.includes("http://127.0.0.1:8755"), "/player must NOT allow http://127.0.0.1:8755");

  // 5) widget and kiosk exemptions unchanged: present, no agent origin
  for (const [name, r] of [["/widget", widget], ["/kiosk", kiosk]]) {
    assert.ok(r.csp["connect-src"] || r.csp["default-src"], `${name} should have a CSP`);
    const all = Object.values(r.csp).flat();
    assert.ok(!all.includes("http://127.0.0.1:8755"), `${name} must NOT allow http://127.0.0.1:8755`);
  }

  // 6) existing websocket / cloudflare / media / image / frame sources remain
  for (const csp of [app.csp, cons.csp]) {
    assert.ok(csp["connect-src"].includes("wss:"), "connect-src should keep wss:");
    assert.ok(csp["connect-src"].includes("ws:"), "connect-src should keep ws:");
    assert.ok(csp["connect-src"].includes("https:"), "connect-src should keep https:");
    assert.ok(csp["img-src"].includes("https:"), "img-src should keep https:");
    assert.ok(csp["frame-src"].some((v) => v.includes("youtube")), "frame-src should keep youtube");
    assert.ok(csp["script-src"].some((v) => v.includes("cloudflareinsights")), "script-src should keep cloudflareinsights");
  }

  // 7) upgrade-insecure-requests remains disabled
  const allCons = Object.values(cons.csp).flat().join(" ");
  const allApp = Object.values(app.csp).flat().join(" ");
  assert.ok(!allCons.includes("upgrade-insecure-requests"), "console CSP must not enable upgrade-insecure-requests");
  assert.ok(!allApp.includes("upgrade-insecure-requests"), "dashboard CSP must not enable upgrade-insecure-requests");

  // 8) no wildcard http or loopback-port wildcard added
  const consStr = cons.csp["connect-src"].join(" ");
  assert.ok(!/http:\/\/\*/.test(consStr), "no wildcard http://* in console connect-src");
  assert.ok(!/http:\/\/127\.0\.0\.1:\*/.test(consStr), "no loopback-port wildcard in console connect-src");
  assert.ok(consStr.includes("http://127.0.0.1:8755"), "exact agent origin present");
});

