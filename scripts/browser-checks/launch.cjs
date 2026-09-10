const { chromium } = require("playwright");

/**
 * Chromium for a dashboard served over plain http.
 *
 * `--unsafely-treat-insecure-origin-as-secure` is the documented escape hatch for this and does
 * NOT work without a persistent profile, so there is no point paying for one: the checks read the
 * clipboard through `readClipboard` below instead, which needs no secure context at all.
 */
exports.launchFor = function launchFor(_base, extraArgs = []) {
  return chromium.launch({ args: [...extraArgs] });
};

/**
 * What is actually on the clipboard, by pasting it the way a person would.
 *
 * `navigator.clipboard.readText` exists only in a secure context — https, or localhost — so a
 * check built on it passes against http://127.0.0.1:<port> and dies against the real dashboard on
 * the lab. Ctrl+V into a scratch input works on any origin, and it verifies the outcome rather
 * than the mechanism: whichever path the page took to copy, this is what a paste would get.
 */
exports.readClipboard = async function readClipboard(page) {
  const id = `__clip_${Math.random().toString(36).slice(2)}`;
  await page.evaluate((sel) => {
    const i = document.createElement("textarea");
    i.id = sel;
    i.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(i);
    i.focus();
  }, id);
  await page.keyboard.press("Control+V");
  // The paste is delivered asynchronously; a tick is enough and a poll would hide a real failure.
  await page.waitForTimeout(250);
  const text = await page.inputValue(`#${id}`);
  await page.evaluate((sel) => document.getElementById(sel)?.remove(), id);
  return text;
};

exports.chromium = chromium;
