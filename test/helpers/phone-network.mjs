import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { HOST } from "./fake-tailscale.mjs";

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = server => new Promise(resolve => {
  server.closeAllConnections();
  server.close(resolve);
});

// Real TLS and HTTP, with an explicit network boundary. Only the externally
// published name is resolvable off the tailnet. The fixture replaces Tailscale
// and DNS infrastructure, not Reach's browser-readiness check or QR generator.
export async function phoneNetwork(t, root, fake, { privatePort = 8444 } = {}) {
  const openssl = process.platform === "win32"
    ? [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "mingw64", "bin", "openssl.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL-Win64", "bin", "openssl.exe"),
      ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "openssl.exe")),
    ].find(fs.existsSync)
    : "/usr/bin/openssl";
  if (!openssl) throw Error("The required QR onboarding TLS fixture needs OpenSSL (provided by Git for Windows on CI).");
  const keyFile = path.join(root, "fixture-tls.key"), certFile = path.join(root, "fixture-tls.crt");
  const configFile = path.join(root, "fixture-tls.cnf");
  fs.writeFileSync(configFile, `[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=${HOST}\n[v3]\nsubjectAltName=DNS:${HOST}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-config", configFile, "-subj", `/CN=${HOST}`], { stdio: "pipe", timeout: 15000, env: { ...process.env, RANDFILE: path.join(root, "fixture-random") } });
  const cert = fs.readFileSync(certFile), key = fs.readFileSync(keyFile);
  const file = path.join(root, "phone-network.json");
  const write = value => {
    fs.writeFileSync(file + ".next", JSON.stringify(value));
    fs.renameSync(file + ".next", file);
  };
  let published = false;
  const requests = [];
  const relay = kind => https.createServer({ key, cert }, async (req, res) => {
    const port = kind === "public" ? 443 : privatePort;
    const session = (await fake.sessions()).find(s => s.config.TCP?.[port] && s.proxy);
    requests.push({ kind, path: req.url });
    if (!session) { res.writeHead(503); return res.end("Tailscale route not ready"); }
    const upstream = http.request({ hostname: "127.0.0.1", port: session.proxy, path: req.url, method: req.method, agent: false,
      headers: { ...req.headers, host: kind === "public" ? HOST : req.headers.host } }, answer => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  const publicServer = relay("public"), privateServer = relay("private");
  t.after(async () => { await close(publicServer); await close(privateServer); });
  const publicTLS = await listen(publicServer), privateTLS = await listen(privateServer);
  write({ published, publicTLS });

  const request = async (input, { mode = "no-app", ip = "100.64.0.50", method = "GET", body, token } = {}) => {
    const url = new URL(input);
    if (url.hostname !== HOST || url.protocol !== "https:") throw Error(`Unexpected fixture destination: ${url.origin}`);
    const onTailnet = mode === "same-tailnet" || mode === "browser-node";
    if (url.port && url.port !== String(privatePort)) throw Error(`No Tailscale route for ${url.origin}`);
    if (!onTailnet && (!published || url.port))
      throw Object.assign(Error("The phone cannot resolve or route this private Tailscale link."), { code: "ENOTFOUND" });
    return new Promise((resolve, reject) => {
      const req = https.request(url, { port: url.port ? privateTLS : publicTLS, ca: cert, servername: HOST,
        lookup: (_host, options, done) => options?.all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4),
        method, agent: false, headers: { Host: url.host, "x-fake-from": ip, ...(onTailnet && { "x-fake-tailnet": "1" }), ...(body !== undefined && { "Content-Type": "application/json" }), ...(token && { Authorization: `Bearer ${token}` }) } }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const data = Buffer.concat(chunks), text = data.toString();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data, text, json });
        });
      });
      req.setTimeout(5000, () => req.destroy(Error("Phone network request timed out.")));
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };

  const preload = "data:text/javascript," + encodeURIComponent(`
    import fs from "node:fs";
    import dns from "node:dns";
    import https from "node:https";
    import { syncBuiltinESMExports } from "node:module";
    const file = ${JSON.stringify(file)};
    dns.promises.resolveNs = async () => ["authoritative.example.test"];
    dns.promises.resolve4 = async () => ["127.0.0.53"];
    dns.promises.Resolver = class {
      setServers(servers) { if (servers[0] !== "127.0.0.53") throw Error("Not the authoritative fixture"); }
      async resolve4(host) {
        if (host !== ${JSON.stringify(HOST)} || !JSON.parse(fs.readFileSync(file)).published)
          throw Object.assign(Error("No public name"), { code: "ENOTFOUND" });
        return ["127.0.0.1"];
      }
    };
    const get = https.get;
    https.get = function(url, options, callback) {
      // Virtual public :443 maps to this fixture's unprivileged TLS port.
      // Keep the production DNS lookup pin, SNI and certificate validation.
      if (url.hostname === ${JSON.stringify(HOST)} && !url.port)
        return get.call(this, url, { ...options, port: JSON.parse(fs.readFileSync(file)).publicTLS }, callback);
      return get.apply(this, arguments);
    };
    syncBuiltinESMExports();
  `);
  return {
    request, preload, certFile, requests,
    publish: value => { published = value; write({ published, publicTLS }); },
  };
}
