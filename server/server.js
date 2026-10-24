import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { networkInterfaces } from "node:os";
import { createApp, DEMO_PASSWORD } from "./app.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 9000);
const host = process.env.HOST ?? "0.0.0.0";
const demo = process.env.DEMO === "1";
const dbPath = resolve(process.env.DB_PATH ?? join(root, "data", "008.db"));

const poll = Number(process.env.GITHUB_POLL_SECONDS ?? 180);
const githubPollMs = poll > 0 ? Math.max(60, poll) * 1000 : 0;

const app = createApp({ dbPath, publicDir: join(root, "public"), demo, trustProxy: process.env.TRUST_PROXY === "1", githubPollMs });

app.server.listen(port, host, () => {
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
  console.log(`008 workspace listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}${lan ? `  (LAN: http://${lan}:${port})` : ""}`);
  console.log(`Database: ${dbPath}`);
  if (app.demoLogins) {
    console.log(`Demo data loaded. Sign in as one of: ${app.demoLogins.join(", ")}`);
    console.log(`Password for every demo account: ${DEMO_PASSWORD}  (joseph is the admin)`);
  } else if (app.db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0) {
    console.log("No accounts yet. Open the site to create the first admin.");
  }
});

const stop = () => app.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
