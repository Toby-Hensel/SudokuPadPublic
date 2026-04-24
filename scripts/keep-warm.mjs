import process from "node:process";

const targetUrl = process.env.WARM_TARGET_URL || "https://sudokupad-party.onrender.com/api/health";
const timeoutMs = Number(process.env.WARM_TIMEOUT_MS || 15_000);

const controller = new AbortController();
const timeoutId = setTimeout(() => {
  controller.abort(new Error(`Keep-warm request timed out after ${timeoutMs}ms.`));
}, timeoutMs);

try {
  const startedAt = Date.now();
  const response = await fetch(targetUrl, {
    method: "GET",
    headers: {
      "user-agent": "SudokuPad Party Keep-Warm"
    },
    signal: controller.signal
  });

  const durationMs = Date.now() - startedAt;
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Keep-warm request failed with ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    status: response.status,
    durationMs
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    targetUrl,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
} finally {
  clearTimeout(timeoutId);
}
