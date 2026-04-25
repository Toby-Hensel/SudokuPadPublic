import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const port = Number(process.env.TEST_PORT || 3211);
const host = process.env.TEST_HOST || "127.0.0.1";
const baseUrl = process.env.TEST_BASE_URL || `http://${host}:${port}`;
const puzzleId = process.env.TEST_PUZZLE_ID || "94Qq6qGjh2";
const browserPath = process.env.BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const maxSyncMs = Number(process.env.MAX_SYNC_MS || 2_000);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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

async function setDisplayName(page, name) {
  const input = page.locator(".collab-dock__input");
  await input.fill(name);
  await input.dispatchEvent("change");
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

async function waitForSummary(page, pattern, timeoutMs = 15_000) {
  await page.waitForFunction(
    (expected) => {
      const text = document.querySelector(".collab-dock__control-summary")?.textContent || "";
      return new RegExp(expected, "i").test(text);
    },
    pattern.source,
    { timeout: timeoutMs }
  );
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
      return {
        actions: actionsB,
        syncMs: Date.now() - startedAt
      };
    }

    await wait(100);
  }

  const [finalActionsA, finalActionsB] = await Promise.all([
    getReplayActions(pageA),
    getReplayActions(pageB)
  ]);
  throw new Error(`Replay mismatch after timeout. Sender=${JSON.stringify(finalActionsA)} Receiver=${JSON.stringify(finalActionsB)}`);
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
      const roomId = `control-${Date.now()}`;
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const url = `${baseUrl}/${puzzleId}?room=${roomId}`;

      try {
        await pageA.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await dismissStartPuzzle(pageA);
        await waitForLive(pageA, 45_000);
        await setDisplayName(pageA, "Host Alpha");

        await pageB.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await dismissStartPuzzle(pageB);
        await waitForLive(pageB, 45_000);
        await setDisplayName(pageB, "Guest Beta");
        await wait(1500);

        await waitForSummary(pageA, /You are controlling/i);
        await waitForSummary(pageB, /Host Alpha is controlling the board/i);

        const box = await pageB.locator("#svgrenderer").boundingBox();
        if (!box) {
          throw new Error("Could not find Sudoku board SVG.");
        }

        const beforeBlockedAttempt = await getReplayActions(pageB);
        await pageB.mouse.click(box.x + 40, box.y + 40);
        await pressDigitKey(pageB, 5);
        await wait(700);
        const afterBlockedAttempt = await getReplayActions(pageB);
        if (JSON.stringify(beforeBlockedAttempt) !== JSON.stringify(afterBlockedAttempt)) {
          throw new Error("Non-controller was able to change the board before getting access.");
        }

        await pageB.getByRole("button", { name: "Request control" }).click();
        await pageA.getByRole("button", { name: /^Grant / }).click();
        await waitForSummary(pageB, /You are controlling/i);

        const beforeGrantedEdit = await getReplayActions(pageB);
        await pageB.mouse.click(box.x + 40, box.y + 40);
        await clickDigitButton(pageB, 6);
        const grantedEditResult = await waitForReplaySync(pageB, pageA, beforeGrantedEdit);
        if (grantedEditResult.syncMs > maxSyncMs) {
          throw new Error(`Granted-control sync exceeded ${maxSyncMs}ms (actual ${grantedEditResult.syncMs}ms).`);
        }

        await pageB.getByRole("button", { name: "Enable free-for-all" }).click();
        await waitForSummary(pageA, /Free-for-all is on/i);

        const beforeFreeForAllEdit = await getReplayActions(pageA);
        await pageA.mouse.click(box.x + 100, box.y + 40);
        await clickDigitButton(pageA, 7);
        const freeForAllResult = await waitForReplaySync(pageA, pageB, beforeFreeForAllEdit);
        if (freeForAllResult.syncMs > maxSyncMs) {
          throw new Error(`Free-for-all sync exceeded ${maxSyncMs}ms (actual ${freeForAllResult.syncMs}ms).`);
        }

        console.log(JSON.stringify({
          baseUrl,
          roomId,
          results: {
            blockedEditUnchanged: true,
            grantedControlSyncMs: grantedEditResult.syncMs,
            freeForAllSyncMs: freeForAllResult.syncMs
          }
        }, null, 2));
      } finally {
        await Promise.all([
          ctxA.close(),
          ctxB.close()
        ]);
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error("Room control test failed.");
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
