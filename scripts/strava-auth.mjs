// One-time Strava OAuth setup.
// 1. Create a Strava API app at https://www.strava.com/settings/api
// 2. Set the "Authorization Callback Domain" to "localhost"
// 3. Put your Client ID and Client Secret in .env.local:
//      STRAVA_CLIENT_ID=your_id
//      STRAVA_CLIENT_SECRET=your_secret
// 4. Run: node scripts/strava-auth.mjs
// 5. A browser window will open — authorize the app
// 6. Tokens will be saved to .env.local automatically

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");

// Load existing .env.local
function loadEnv() {
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

function saveEnv(env) {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(envPath, content);
}

const env = loadEnv();
const clientId = env.STRAVA_CLIENT_ID;
const clientSecret = env.STRAVA_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("❌ Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env.local");
  console.error("   Create a Strava API app at https://www.strava.com/settings/api");
  console.error("   Then add your credentials to .env.local:");
  console.error("     STRAVA_CLIENT_ID=your_id");
  console.error("     STRAVA_CLIENT_SECRET=your_secret");
  process.exit(1);
}

const PORT = 8384;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "activity:read_all";

const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&approval_prompt=auto`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error || !code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Authorization failed</h1><p>Please try again.</p>");
      server.close();
      process.exit(1);
    }

    // Exchange code for tokens
    try {
      const tokenRes = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
        }),
      });

      const data = await tokenRes.json();

      if (!data.access_token) {
        throw new Error(data.message || "Failed to get tokens");
      }

      // Save tokens to .env.local
      env.STRAVA_ACCESS_TOKEN = data.access_token;
      env.STRAVA_REFRESH_TOKEN = data.refresh_token;
      env.STRAVA_TOKEN_EXPIRES_AT = String(data.expires_at);
      saveEnv(env);

      console.log("✅ Strava tokens saved to .env.local");
      console.log(`   Athlete: ${data.athlete.firstname} ${data.athlete.lastname}`);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html><body style="font-family: system-ui; padding: 2rem; background: #111125; color: #eee;">
          <h1 style="color: #FC6719;">✅ Authorized!</h1>
          <p>Welcome, ${data.athlete.firstname}! Tokens saved. You can close this tab.</p>
        </body></html>
      `);
    } catch (err) {
      console.error("❌ Token exchange failed:", err.message);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<h1>Token exchange failed</h1>");
    }

    setTimeout(() => { server.close(); process.exit(0); }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n🔗 Open this URL to authorize Strava:\n\n   ${authUrl}\n`);
  console.log(`Waiting for callback on http://localhost:${PORT}/callback ...\n`);

  // Try to open browser automatically
  import("child_process").then(({ exec }) => {
    exec(`open "${authUrl}"`);
  });
});
