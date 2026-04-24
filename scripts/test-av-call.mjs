import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const port = Number(process.env.TEST_PORT || 3352);
const host = process.env.TEST_HOST || "127.0.0.1";
const baseUrl = process.env.TEST_BASE_URL || `http://${host}:${port}`;
const puzzleId = process.env.TEST_PUZZLE_ID || "94Qq6qGjh2";
const browserPath = process.env.BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await wait(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function dismissStartPuzzle(page) {
  const startButton = page.getByRole("button", { name: "Start Puzzle" });
  if (await startButton.count() && await startButton.isVisible().catch(() => false)) {
    await startButton.click({ force: true });
  }
}

async function waitForLive(page, timeout = 30_000) {
  await page.waitForFunction(
    () => document.querySelector(".collab-dock__status")?.textContent === "Live",
    { timeout }
  );
}

async function main() {
  const shouldStartLocalServer = !process.env.TEST_BASE_URL;
  const server = shouldStartLocalServer
    ? spawn(process.execPath, ["server.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: host,
        ALLOW_LOCAL_ROOMS: "1",
        PUBLIC_APP_ORIGIN: baseUrl
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    : null;

  let serverOutput = "";
  server?.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server?.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    if (shouldStartLocalServer) {
      await waitForServer(baseUrl);
    }

    const browser = await chromium.launch({
      headless: true,
      executablePath: browserPath,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    });

    try {
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const url = `${baseUrl}/${puzzleId}?room=av-smoke-${Date.now()}`;

      await Promise.all([
        pageA.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }),
        pageB.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
      ]);

      await Promise.all([
        dismissStartPuzzle(pageA),
        dismissStartPuzzle(pageB)
      ]);

      await Promise.all([
        waitForLive(pageA, 45_000),
        waitForLive(pageB, 45_000)
      ]);

      await pageA.getByRole("button", { name: "Join AV" }).click();
      await pageB.getByRole("button", { name: "Join AV" }).click();

      await Promise.all([
        pageA.waitForFunction(() => document.querySelectorAll(".collab-media-panel__remote-grid .collab-media-panel__video").length >= 1, { timeout: 20_000 }),
        pageB.waitForFunction(() => document.querySelectorAll(".collab-media-panel__remote-grid .collab-media-panel__video").length >= 1, { timeout: 20_000 })
      ]);

      console.log(JSON.stringify({
        aStatus: await pageA.locator(".collab-dock__media-status").textContent(),
        bStatus: await pageB.locator(".collab-dock__media-status").textContent(),
        aRemote: await pageA.locator(".collab-media-panel__remote-grid .collab-media-panel__video").count(),
        bRemote: await pageB.locator(".collab-media-panel__remote-grid .collab-media-panel__video").count()
      }, null, 2));

      await Promise.all([
        ctxA.close(),
        ctxB.close()
      ]);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error("AV smoke test failed.");
    if (serverOutput) {
      console.error(serverOutput);
    }
    throw error;
  } finally {
    server?.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
