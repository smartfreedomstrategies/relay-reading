// Relay Reading: local server. No internet, no npm packages, no accounts.
// Serves the page over HTTPS (needed so phones may use the microphone) and keeps the
// shared reading state in memory. Devices stay in sync through Server-Sent Events.
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT) || 8443;
const DIR = __dirname;
const CERTS = path.join(DIR, "certs");

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  return out;
}

function ensureCert(ips) {
  const key = path.join(CERTS, "key.pem"), cert = path.join(CERTS, "cert.pem"), ipFile = path.join(CERTS, "ips.txt");
  const sig = ips.join(",");
  if (fs.existsSync(key) && fs.existsSync(cert) && fs.existsSync(ipFile) && fs.readFileSync(ipFile, "utf8") === sig) return { key, cert };
  fs.mkdirSync(CERTS, { recursive: true });
  const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map(a => "IP:" + a)].join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
    "-keyout", key, "-out", cert, "-subj", "/CN=Relay Reading", "-addext", "subjectAltName=" + san], { stdio: "ignore" });
  fs.writeFileSync(ipFile, sig);
  return { key, cert };
}

// ---- shared state ----
let people = {};   // section index (as text) -> {n, done, live, fin}
let epoch = 0;     // bumps on "restart for everyone" and whenever the text changes
const clients = new Set(); // {res, name}

// The document the host set up: a title and sections, each with a reader ("" = not read aloud).
// null means "use the example built into the page".
const CONFIG_FILE = path.join(DIR, "config.json");
const LIMITS = { sections: 300, textPerSection: 5000, totalText: 300000, name: 20 };

function cleanConfig(b) {
  if (!b) return null;
  let secs = b.sections;
  if (!Array.isArray(secs) && Array.isArray(b.names) && Array.isArray(b.texts)) secs = b.names.map((n, i) => ({ reader: n, text: b.texts[i] }));   // older saved format
  if (!Array.isArray(secs) || secs.length < 1 || secs.length > LIMITS.sections) return null;
  let total = 0;
  const out = [];
  for (const s of secs) {
    const reader = String((s && s.reader) || "").trim().replace(/\s+/g, " ");
    const text = String((s && s.text) || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > LIMITS.textPerSection) return null;
    if (reader.length > LIMITS.name || reader.startsWith("__")) return null;
    total += text.length;
    out.push({ reader, text });
  }
  if (total > LIMITS.totalText || !out.some(s => s.reader)) return null;
  return { title: String(b.title || "").trim().slice(0, 80) || "Untitled reading", sections: out };
}

let config = null;
try { config = cleanConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))); } catch { config = null; }

const DEFAULT_READERS = ["Ava", "Ben", "Cleo"];
const readers = () => config ? [...new Set(config.sections.map(s => s.reader).filter(Boolean))] : DEFAULT_READERS;
const sectionCount = () => config ? config.sections.length : 3;

function snapshot() {
  const here = [...new Set([...clients].map(c => c.name).filter(Boolean))];
  return JSON.stringify({ people, here, epoch, config });
}
function broadcast() {
  const msg = "data: " + snapshot() + "\n\n";
  for (const c of clients) c.res.write(msg);
}

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", d => { b += d; if (b.length > 2000000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const files = ensureCert(lanAddresses());
const tls = { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) };
const make = process.env.RELAY_HTTP ? h => require("http").createServer(h) : h => https.createServer(tls, h);   // RELAY_HTTP=1 is for local tests only
const server = make(async (req, res) => {
  const url = new URL(req.url, "https://x");
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const name = readers().includes(url.searchParams.get("name")) ? url.searchParams.get("name") : "";
    const c = { res, name };
    clients.add(c);
    res.write("data: " + snapshot() + "\n\n");
    broadcast();
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clients.delete(c); broadcast(); });
    return;
  }
  if (req.method === "POST" && url.pathname === "/progress") {
    const b = await readBody(req);
    const sec = Number.isInteger(b.sec) ? b.sec : -1;
    if (sec >= 0 && sec < sectionCount()) {
      people[sec] = { n: Math.max(0, Math.min(100000, +b.n || 0)), done: !!b.done, live: !!b.live, fin: !!b.fin };
      broadcast();
    }
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/config") {
    const c = cleanConfig(await readBody(req));
    if (!c) { res.writeHead(400).end("Needs 1 to " + LIMITS.sections + " sections, at least one with a reader, each up to " + LIMITS.textPerSection + " characters."); return; }
    config = c; people = {}; epoch++;
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {}
    const rs = readers();
    for (const cl of clients) if (!rs.includes(cl.name)) cl.name = "";
    broadcast();
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/reset") {
    people = {}; epoch++; broadcast();
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET") {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.join(DIR, "..", "docs", rel);
    if (file.startsWith(path.join(DIR, "..", "docs") + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".gz": "application/gzip" };
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": rel.startsWith("vendor/") ? "public, max-age=86400" : "no-store" });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404).end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("\nRelay Reading is running.\n");
  console.log("  On this computer:  https://localhost:" + PORT);
  for (const ip of lanAddresses()) console.log("  On other devices:  https://" + ip + ":" + PORT + "   (same Wi-Fi)");
  console.log("\nThe first time, each device shows a security warning (the certificate is self-made).");
  console.log("Tap 'Advanced' and then 'Continue' once. Stop the server with Ctrl+C.\n");
});
