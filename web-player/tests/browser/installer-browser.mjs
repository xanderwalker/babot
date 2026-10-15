/** Software-only integration. Requires local Vite on 127.0.0.1:5190; never opens real USB. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BABOT_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'qa/installer');
const fixture = fileURLToPath(new URL('./installer-mock.js', import.meta.url));
const video = path.join(output, 'clock.mp4');
await fs.mkdir(output, { recursive: true });
try { await fs.access(video); } catch {
  const encoded = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=50', '-t', '95', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', video], { encoding: 'utf8' });
  assert.equal(encoded.status, 0, `Test clock video generation failed: ${encoded.stderr}`);
}

const report = { kind: 'software-only; no physical USB device', started: new Date().toISOString(), scenarios: [], pageErrors: [], screenshots: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
let currentPage;
const snapshot = page => page.evaluate(() => ({
  ...window.__installerTest.stats,
  installed: window.__installerTest.installed,
  mode: window.__installerTest.mode,
  resetVector: Array.from(window.__installerTest.flash.slice(0, 2)),
  eepromUnchanged: window.__installerTest.originalEeprom.every((value, index) => value === window.__installerTest.eeprom[index]),
  savedMounting: JSON.parse(localStorage.getItem('babot.mounting.v1')),
}));
async function start(query = '', viewport = { width: 1440, height: 1100 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript({ path: fixture });
  await context.route(/brightcove|bcovlive|bcov.|boltdns/i, route => route.abort());
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', error => report.pageErrors.push({ scenario: query || 'happy-path', message: error.message }));
  await page.goto(`http://127.0.0.1:5190/?installer-test=1${query}#setup`, { waitUntil: 'networkidle' });
  await page.getByText('FIRMWARE 1.0.0', { exact: true }).waitFor();
  assert.equal((await snapshot(page)).requests, 0, 'Cold setup must never open a USB chooser');
  assert.equal((await snapshot(page)).writes.length, 0, 'Cold setup must never write firmware');
  assert.equal((await snapshot(page)).motion.length, 0, 'Cold setup must never arm/move');
  assert.equal(await page.getByRole('button', { name: /Continue to installation/ }).isEnabled(), false);
  return { context, page };
}
async function prepare(page, { installed = false } = {}) {
  await page.getByRole('checkbox').nth(0).check();
  assert.equal(await page.getByRole('button', { name: /Continue to installation/ }).isEnabled(), false, 'Both power/cable confirmations are required');
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: installed ? 'I already have BaBot Motion' : /Continue to installation/ }).click();
}
async function resetAndFlash(page) {
  await page.getByRole('button', { name: 'Reset BaBot', exact: true }).click();
  await page.getByRole('button', { name: 'Restart BaBot again' }).waitFor();
  await page.getByRole('button', { name: /Choose bootloader and install/ }).click();
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  report.screenshots.push(name);
}

try {
  const { context, page } = await start();
  await screenshot(page, 'setup-desktop.png');
  await prepare(page);
  await screenshot(page, 'install-desktop.png');
  await resetAndFlash(page);
  await page.getByRole('heading', { name: 'Installed. Now check the device.' }).waitFor();
  const flashed = await snapshot(page);
  assert.equal(flashed.requests, 2);
  assert.equal(flashed.eepromWrites, 0);
  assert.equal(flashed.eepromUnchanged, true);
  assert.equal(flashed.exits, 1);
  assert.equal(flashed.writes.at(-1).address, 0, 'Reset vector page must be the last committed page');
  assert.equal(flashed.motion.length, 0);
  await page.getByRole('button', { name: /Check installed firmware/ }).click();
  await page.getByRole('heading', { name: 'Your firmware is ready.' }).waitFor();
  await screenshot(page, 'firmware-verified-desktop.png');
  assert.equal((await snapshot(page)).requests, 3);
  await page.getByRole('button', { name: /Continue to mounting/ }).click();
  await page.getByRole('heading', { name: 'Make the motion match your model.' }).waitFor();
  await page.getByRole('button', { name: 'Close check' }).waitFor();
  const handoff = await snapshot(page);
  assert.equal(handoff.savedMounting.mounting.verified, false, 'Setup must revoke the previously verified browser mounting profile');
  assert.equal(handoff.motion.length, 0, 'Setup handoff must never automatically ARM');
  await page.getByRole('checkbox', { name: /Platform clear/ }).check();
  await page.getByRole('button', { name: 'Run +roll · 1°', exact: true }).click();
  await page.locator('.axis-calibration-check').nth(0).getByRole('combobox').selectOption('right-down');
  await page.getByRole('button', { name: 'Run +pitch · 1°', exact: true }).click();
  await page.locator('.axis-calibration-check').nth(1).getByRole('combobox').selectOption('nose-down');
  await page.getByRole('button', { name: 'Verify mounting', exact: true }).click();
  await page.getByRole('heading', { name: 'Ready for the Singapore lap.' }).waitFor();
  const calibrated = await snapshot(page);
  assert.equal(calibrated.savedMounting.mounting.verified, true);
  assert.equal(calibrated.motion.filter(line => line.startsWith('ARM ')).length, 2, 'Each explicit axis pulse must ARM exactly once');
  await page.locator('input[type="file"][accept^="video/"]').setInputFiles(video);
  await page.getByRole('checkbox', { name: 'Start-line alignment checked' }).check();
  const beforePlayback = (await snapshot(page)).motion.length;
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.waitForFunction(before => window.__installerTest.stats.motion.length >= before + 12, beforePlayback);
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  await page.waitForFunction(() => window.__installerTest.stats.runtimeLines.at(-1)?.startsWith('STOP '));
  const replayed = await snapshot(page);
  assert.ok(replayed.motion.slice(beforePlayback).some(line => line.startsWith('ARM ')));
  assert.ok(replayed.motion.slice(beforePlayback).filter(line => line.startsWith('POSE ')).length >= 10);
  const stoppedMotionCount = replayed.motion.length;
  await page.waitForTimeout(180);
  assert.equal((await snapshot(page)).motion.length, stoppedMotionCount, 'Paused replay must stop sending poses');
  await screenshot(page, 'mounting-verified-replay.png');
  report.scenarios.push({ name: 'stock install → firmware verification → mounting checks → local-video replay → Pause STOP', passed: true, flashPagesWritten: flashed.writes.length, flashBytesWritten: flashed.writes.reduce((sum, write) => sum + write.length, 0), resetPageCommittedLast: true, eepromUnchanged: true, replayPoses: replayed.motion.slice(beforePlayback).filter(line => line.startsWith('POSE ')).length, usbRequests: replayed.requests });
  await context.close();

  const mobile = await start('', { width: 390, height: 844 });
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile setup must fit viewport');
  await screenshot(mobile.page, 'setup-mobile.png');
  await prepare(mobile.page);
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile installer must fit viewport');
  await screenshot(mobile.page, 'install-mobile.png');
  report.scenarios.push({ name: '390px mobile layout', passed: true });
  await mobile.context.close();

  for (const failure of [
    { query: '&bad-signature=1', text: /not ATmega32U4/, name: 'wrong signature refuses all writes' },
    { query: '&bad-readback=1', text: /Flash verification failed/, name: 'readback failure keeps reset page blank and does not exit bootloader' },
  ]) {
    const failed = await start(failure.query);
    await prepare(failed.page);
    await resetAndFlash(failed.page);
    await failed.page.getByRole('alert').filter({ hasText: failure.text }).waitFor();
    const state = await snapshot(failed.page);
    assert.equal(state.exits, 0);
    assert.equal(state.eepromWrites, 0);
    assert.equal(state.eepromUnchanged, true);
    assert.equal(state.motion.length, 0);
    if (failure.query.includes('signature')) assert.equal(state.writes.length, 0);
    else assert.deepEqual(state.resetVector, [255, 255]);
    report.scenarios.push({ name: failure.name, passed: true, writes: state.writes.length });
    await failed.context.close();
  }

  const cancelled = await start('&cancel-picker=1');
  await prepare(cancelled.page);
  await cancelled.page.getByRole('button', { name: 'Reset BaBot', exact: true }).click();
  await cancelled.page.getByRole('alert').filter({ hasText: /cancel|selected/i }).waitFor();
  const cancelledState = await snapshot(cancelled.page);
  assert.equal(cancelledState.writes.length, 0);
  assert.equal(cancelledState.opens.length, 0);
  report.scenarios.push({ name: 'picker cancellation leaves firmware and USB untouched', passed: true });
  await cancelled.context.close();

  const existing = await start('&initial=motion');
  await prepare(existing.page, { installed: true });
  await existing.page.getByRole('button', { name: /Check installed firmware/ }).click();
  await existing.page.getByRole('heading', { name: 'Your firmware is ready.' }).waitFor();
  const existingState = await snapshot(existing.page);
  assert.equal(existingState.writes.length, 0);
  assert.equal(existingState.motion.length, 0);
  assert.equal(existingState.requests, 1);
  assert.equal(existingState.opens.some(open => open.baudRate === 1200), false);
  report.scenarios.push({ name: 'already-installed path reads firmware without reset, writes, or motion', passed: true });
  await existing.context.close();

  assert.deepEqual(report.pageErrors, [], 'Browser page errors must be empty');
  await fs.rm(path.join(output, 'failure.png'), { force: true });
  report.finished = new Date().toISOString();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    report.failureBody = await currentPage.locator('body').innerText().catch(() => '');
    report.failureFixture = await snapshot(currentPage).catch(() => null);
  }
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios, pageErrors: report.pageErrors, output }, null, 2));
}
