import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const port = Number(process.env.TEST_PORT || 3210);
const host = process.env.TEST_HOST || "127.0.0.1";
const baseUrl = process.env.TEST_BASE_URL || `http://${host}:${port}`;
const puzzleId = process.env.TEST_PUZZLE_ID || "94Qq6qGjh2";
const browserPath = process.env.BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const maxSyncMs = Number(process.env.MAX_SYNC_MS || 2_000);

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

async function getReplayActions(page) {
  return page.evaluate(() => Replay.create(Framework.app.puzzle).actions || []);
}

async function clickDigitButton(page, digit) {
  await page.locator(`button.digit[title="${digit}"]`).click({ force: true });
}

async function pressDigitKey(page, digit) {
  await page.keyboard.press(String(digit));
}

async function clickControlButton(page, name) {
  await page.getByRole("button", { name }).click({ force: true });
}

async function waitForReplaySync(pageA, pageB, previousActions, timeoutMs = 10_000) {
  const previousHash = JSON.stringify(previousActions);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [actionsA, actionsB] = await Promise.all([
      getReplayActions(pageA),
      getReplayActions(pageB)
    ]);
    const hashA = JSON.stringify(actionsA);
    const hashB = JSON.stringify(actionsB);

    if (hashA !== previousHash && hashA === hashB) {
      return actionsB;
    }

    await wait(100);
  }

  const [finalActionsA, finalActionsB] = await Promise.all([
    getReplayActions(pageA),
    getReplayActions(pageB)
  ]);
  throw new Error(`Replay mismatch after timeout. Sender=${JSON.stringify(finalActionsA)} Receiver=${JSON.stringify(finalActionsB)}`);
}

async function runScenario(browser, scenario) {
  const roomId = `${scenario.label}-${Date.now()}`;
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

  if (scenario.disableStream) {
    await Promise.all([
      ctxA.route("**/api/collab/stream/**", (route) => route.abort()),
      ctxB.route("**/api/collab/stream/**", (route) => route.abort())
    ]);
  }

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const url = `${baseUrl}/${puzzleId}?room=${roomId}`;

  try {
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

    const box = await pageA.locator("#svgrenderer").boundingBox();
    if (!box) {
      throw new Error("Could not find Sudoku board SVG.");
    }

    const metrics = [];
    for (const action of scenario.actions) {
      await dismissStartPuzzle(pageA);
      await dismissStartPuzzle(pageB);
      const syncStartedAt = Date.now();
      const previousActions = await getReplayActions(pageA);
      await action.run(pageA, box);
      const syncedActions = await waitForReplaySync(pageA, pageB, previousActions);

      const syncMs = Date.now() - syncStartedAt;
      if (syncMs > maxSyncMs) {
        throw new Error(`${scenario.label}:${action.label} exceeded ${maxSyncMs}ms (actual ${syncMs}ms).`);
      }

      metrics.push({
        label: action.label,
        syncMs,
        actions: syncedActions
      });
    }

    return {
      label: scenario.label,
      disableStream: scenario.disableStream,
      roomId,
      metrics
    };
  } finally {
    await Promise.all([
      ctxA.close(),
      ctxB.close()
    ]);
  }
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
        ALLOW_LOCAL_ROOMS: "1"
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
      executablePath: browserPath
    });

    try {
      const scenarios = [
        {
          label: "stream",
          disableStream: false,
          actions: [
            {
              label: "digit",
              run: async (page, box) => {
                await page.mouse.click(box.x + 40, box.y + 40);
                await clickDigitButton(page, 5);
              }
            },
            {
              label: "undo",
              run: (page) => clickControlButton(page, "Undo")
            },
            {
              label: "corner",
              run: async (page, box) => {
                await clickControlButton(page, "Corner");
                await page.mouse.click(box.x + 40, box.y + 40);
                await pressDigitKey(page, 3);
              }
            },
            {
              label: "centre",
              run: async (page, box) => {
                await clickControlButton(page, "Centre");
                await page.mouse.click(box.x + 100, box.y + 40);
                await pressDigitKey(page, 4);
              }
            },
            {
              label: "color",
              run: async (page, box) => {
                await clickControlButton(page, "Color");
                await page.mouse.click(box.x + 160, box.y + 40);
                await pressDigitKey(page, 2);
              }
            }
          ]
        },
        {
          label: "poll-only",
          disableStream: true,
          actions: [
            {
              label: "digit",
              run: async (page, box) => {
                await page.mouse.click(box.x + 40, box.y + 40);
                await clickDigitButton(page, 7);
              }
            },
            {
              label: "corner",
              run: async (page, box) => {
                await clickControlButton(page, "Corner");
                await page.mouse.click(box.x + 100, box.y + 40);
                await pressDigitKey(page, 8);
              }
            }
          ]
        }
      ];

      const results = [];
      for (const scenario of scenarios) {
        results.push(await runScenario(browser, scenario));
      }

      console.log(JSON.stringify({ baseUrl, results }, null, 2));
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
    server?.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
