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
let people = {};   // name -> {n, done, live, fin}
let epoch = 0;     // bumps on "restart for everyone"
const clients = new Set(); // {res, name}

function snapshot() {
  const here = [...new Set([...clients].map(c => c.name).filter(Boolean))];
  return JSON.stringify({ people, here, epoch });
}
function broadcast() {
  const msg = "data: " + snapshot() + "\n\n";
  for (const c of clients) c.res.write(msg);
}

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", d => { b += d; if (b.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const NAMES = ["Ava", "Ben", "Cleo"];
const files = ensureCert(lanAddresses());
const tls = { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) };
const server = https.createServer(tls, async (req, res) => {
  const url = new URL(req.url, "https://x");
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const name = NAMES.includes(url.searchParams.get("name")) ? url.searchParams.get("name") : "";
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
    if (NAMES.includes(b.name)) {
      people[b.name] = { n: Math.max(0, Math.min(500, +b.n || 0)), done: !!b.done, live: !!b.live, fin: !!b.fin };
      broadcast();
    }
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
