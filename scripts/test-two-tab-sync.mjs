import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const port = Number(process.env.TEST_PORT || 3210);
const host = process.env.TEST_HOST || "127.0.0.1";
const serverUrl = `http://${host}:${port}`;
const puzzleId = process.env.TEST_PUZZLE_ID || "94Qq6qGjh2";
const roomId = `sync-${Date.now()}`;
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
  if (await startButton.count()) {
    await startButton.click();
  }
}

async function main() {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(serverUrl);

    const browser = await chromium.launch({
      headless: true,
      executablePath: browserPath
    });

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1000 }
      });
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      const url = `${serverUrl}/${puzzleId}?room=${roomId}`;

      await Promise.all([
        pageA.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }),
        pageB.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
      ]);

      await Promise.all([
        dismissStartPuzzle(pageA),
        dismissStartPuzzle(pageB)
      ]);

      await Promise.all([
        pageA.waitForFunction(() => document.querySelector(".collab-dock__status")?.textContent === "Live", { timeout: 30_000 }),
        pageB.waitForFunction(() => document.querySelector(".collab-dock__status")?.textContent === "Live", { timeout: 30_000 })
      ]);

      const box = await pageA.locator("#svgrenderer").boundingBox();
      if (!box) {
        throw new Error("Could not find Sudoku board SVG.");
      }

      await pageA.mouse.click(box.x + 40, box.y + 40);
      await pageA.keyboard.press("5");

      await pageB.waitForFunction(
        () => {
          const replay = Replay?.create?.(Framework?.app?.puzzle);
          return Array.isArray(replay?.actions) && replay.actions.some((action) => action.startsWith("vl:5"));
        },
        { timeout: 10_000 }
      );

      const result = await Promise.all([
        pageA.evaluate(() => ({
          actions: Replay.create(Framework.app.puzzle).actions,
          selectedCells: Framework.app.puzzle.selectedCells.length
        })),
        pageB.evaluate(() => ({
          actions: Replay.create(Framework.app.puzzle).actions,
          selectedCells: Framework.app.puzzle.selectedCells.length
        }))
      ]);

      console.log(JSON.stringify({ serverUrl, roomId, pageA: result[0], pageB: result[1] }, null, 2));
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error("Two-tab sync test failed.");
    if (serverOutput) {
      console.error(serverOutput);
    }
    throw error;
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
