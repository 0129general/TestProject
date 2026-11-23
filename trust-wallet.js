// Drives the Trust Wallet extension's onboarding in Playwright's Chromium, once per recovery phrase
// in words.txt: "I already have a wallet" -> Password -> Continue -> "Other mobile wallet or extension",
// types the phrase, Import, ticks the three confirmations, Import, then clicks "Open my wallet" -- or,
// if the extension asks which derived wallet to use, leaves the window open for the user to pick.
// Each phrase gets its own fresh browser profile -- there is no "already set up" state to add to.
//
// Run:  node trust-wallet.js
// By default this cycles through every phrase in words.txt, one at a time. To do a subset, set
// PHRASE_START and/or PHRASE_END (1-based, inclusive) -- e.g. PHRASE_START=2 PHRASE_END=2 for just
// the second phrase.
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { chromium } = require('playwright');

// Unpacked copy of the Trust Wallet extension (copied from Chrome, minus its _metadata folder).
const EXTENSION_PATH = path.join(__dirname, 'trust-wallet-extension');

// Password typed into the wallet's "Create password" screen.
const WALLET_PASSWORD = 'qwe123!@#';

// Recovery phrases: one wallet per line, words separated by spaces. They are never printed or logged.
// Set the WORDS_FILE environment variable to read a different file.
const WORDS_FILE = process.env.WORDS_FILE || path.join(__dirname, 'words.txt');

// Where the wallet's balance gets appended to.
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(__dirname, 'results.txt');

const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'history.txt');


// Phrases loaded so far, kept only so they can be scrubbed from error output: Playwright's error
// messages echo the text passed to fill(), which would otherwise print a recovery phrase.
const loadedPhrases = [];

function readRecoveryPhrases(file) {
  const phrases = fs.readFileSync(file, 'utf8')
    .replace(/^﻿/, '')                           // drop a UTF-8 byte-order mark
    .split(/\r?\n/)                                    // Windows or Unix line endings
    .map(line => line.trim().split(/\s+/).join(' '))   // one space between words
    .filter(Boolean);                                  // skip blank lines
  if (phrases.length === 0) throw new Error(`${path.basename(file)} has no recovery phrases`);
  return phrases;
}

async function main() {
  const startTime = Date.now();
  // Load the recovery phrases first, so a missing or empty words file fails before a browser opens.
  const phrases = readRecoveryPhrases(WORDS_FILE);
  loadedPhrases.push(...phrases);
  // console.log(`Loaded ${phrases.length} recovery phrase(s) from ${path.basename(WORDS_FILE)}.`);

  // 1-based, inclusive range of phrases to process. Defaults to all of them.
  const start = clampPhraseIndex(process.env.PHRASE_START, 1, phrases.length);
  const end = clampPhraseIndex(process.env.PHRASE_END, phrases.length, phrases.length);
  if (start > end) throw new Error(`PHRASE_START (${start}) is after PHRASE_END (${end})`);

  for (let i = start; i <= end; i++) {
    // console.log(`\n=== Phrase ${i} of ${phrases.length} ===`);
    // Each phrase gets its own fresh browser profile: the wallet isn't "already set up" to add to.
    const context = await importOnePhrase(phrases[i - 1], i, phrases.length);
    const isLast = i === end;
    // Created fresh right before use, not reused across the loop: readline auto-closes once stdin
    // reaches EOF with no pending question(), which (with piped/non-interactive input) can otherwise
    // happen during a phrase's long browser automation, well before this prompt is ever reached.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // await rl.question(isLast ? 'Press Enter to close the browser...' : 'Press Enter to continue to the next phrase...');
    rl.close();
    await context.close();
  }

  console.log(`Total time: ${formatDuration(Date.now() - startTime)}`);
}

// Formats a millisecond duration as e.g. "1m 23.4s" or "23.4s".
function formatDuration(ms) {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Returns a 1-based phrase index from an env var string, clamped to [1, max]. Falls back to
// `fallback` when the env var is unset or not a number.
function clampPhraseIndex(envValue, fallback, max) {
  const n = envValue === undefined ? fallback : Number(envValue);
  if (!Number.isInteger(n)) throw new Error(`Not a whole number: ${envValue}`);
  return Math.min(Math.max(n, 1), max);
}

// Runs the full "import a wallet from a recovery phrase" flow once, in its own fresh browser profile.
async function importOnePhrase(phrase, phraseNumber, totalPhrases) {
  // Extensions only load in a persistent context.
  // '' = a fresh temporary profile every time, so Trust Wallet always starts at onboarding.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // Playwright's bundled browser; regular Google Chrome no longer allows --load-extension
    // headless: process.env.HEADLESS === '1',
    headless: true, // for debugging, so you can see the extension's UI
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  try {
    // The extension ID is the host part of its background service worker URL.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];

    const page = await getOnboardingPage(context, extensionId);
    await page.bringToFront();

    const haveWallet = page.getByRole('button', { name: 'I already have a wallet', exact: true });
    await haveWallet.waitFor();

    // A fresh install first shows an "I have read and agree to the Terms of Use..." checkbox,
    // and the buttons stay disabled until it is ticked. Screens without it skip this step.
    const terms = page.getByRole('checkbox', { name: /I have read and agree/ });
    if (await terms.isVisible()) await terms.check();

    await haveWallet.click();
    await haveWallet.waitFor({ state: 'hidden' }); // the next onboarding screen has replaced it
    // console.log('Clicked "I already have a wallet".');

    // Next screen ("Secure your wallet"): if it offers a "Password" option, click it.
    // The screen can take a moment to render, so wait a few seconds before deciding it isn't there.
    const passwordOption = page.getByRole('button', { name: 'Password', exact: true });
    const offered = await passwordOption.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (offered) {
      await passwordOption.click();
      await passwordOption.waitFor({ state: 'hidden' }); // the next screen has replaced it
      // console.log('Clicked "Password".');

      // "Create password" screen: type the password into both fields, then click Continue.
      // Both inputs share data-testid="password-field", so tell them apart by placeholder
      // (the "Confirm password" field's placeholder is just "Password").
      await page.getByPlaceholder('Min 8 characters').fill(WALLET_PASSWORD);
      await page.getByPlaceholder('Password', { exact: true }).fill(WALLET_PASSWORD);
      // Continue stays disabled until both fields are valid; click() waits for it to become enabled.
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('heading', { name: 'Create password' }).waitFor({ state: 'hidden' });
      // console.log('Entered the password and clicked "Continue".');
    } else {
      // console.log('No "Password" option on this screen, skipping.');
    }

    // "Import a wallet" screen ("Select your existing wallet"): click "Other mobile wallet or extension".
    const otherWallet = page.getByRole('button', { name: 'Other mobile wallet or extension', exact: true });
    await otherWallet.click();
    await otherWallet.waitFor({ state: 'hidden' }); // the next screen has replaced it
    // console.log('Clicked "Other mobile wallet or extension".');

    // "Import with Secret Phrase or Private Key" screen: type this recovery phrase,
    // then click Import (click() waits until Import is enabled, i.e. until the phrase is accepted).
    await page.getByTestId('import-wallet-secret').fill(phrase);
    // console.log(`Typed recovery phrase ${phraseNumber} of ${totalPhrases}.`);
    await page.getByTestId('import-wallet-submit').click();

    // Import opens a "Check your Secret Phrase is safe" dialog.
    // (Wait for its heading: the dialog's outer container has no size, so Playwright treats it as hidden.)
    const dialogHeading = page.getByRole('heading', { name: 'Check your Secret Phrase is safe' });
    await dialogHeading.waitFor();
    // console.log('Clicked "Import"; the "Check your Secret Phrase is safe" dialog is open.');

    // Tick the dialog's three confirmations, then click its Import button (disabled until all are ticked).
    for (const statement of [
      'Only I know this Secret Phrase.',
      'No one gave it to me, including a company representative or someone offering money.',
      'Anyone who has it can control the wallet and steal its funds.',
    ]) {
      await page.getByRole('checkbox', { name: statement, exact: true }).check();
    }
    await page.getByTestId('accept-import-secret-warning').click();
    await dialogHeading.waitFor({ state: 'hidden' });
    // console.log('Ticked the three confirmations and clicked "Import" in the dialog.');

    // The extension now checks the wallet (about 10 s), then shows "Start exploring" with an "Open my wallet" button.
    // For some phrases it first asks "Select wallet for <chain>": that choice is not scripted, so nothing is clicked then.
    const openWallet = page.getByRole('button', { name: 'Open my wallet', exact: true });
    const chooseWallet = page.getByRole('heading', { name: /^Select wallet for / });
    await openWallet.or(chooseWallet).first().waitFor({ timeout: 60_000 });
    if (await chooseWallet.isVisible()) {
      // console.log('The extension is asking which wallet to use ("Select wallet for ..."); not clicking anything, pick one in the window.');
    } else {
      await openWallet.click();
      // The page stays after the click: "Open my wallet" turns disabled once the wallet has been opened.
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open my wallet');
        return !button || button.disabled;
      });
      // console.log('Clicked "Open my wallet".');

      // Load the wallet's home page fresh (confirmed in testing: this only shows the dashboard
      // rather than an "#/unlock" screen because "Open my wallet" was already clicked above).
      await page.goto(`chrome-extension://${extensionId}/home.html`);
      // console.log(`Opened ${page.url()}`);

      // Click the wallet switcher to open the list showing this wallet's balance. The balance text
      // itself has no data-testid (and its class also matches an unrelated warning paragraph
      // elsewhere in the same list), so anchor on "wallet-select-popup-wallet-name" -- unique to
      // this list -- and take the next <p> after it, which is the balance right next to the name.
      await page.getByTestId('wallet-select-button').click();
      const walletNameInPopup = page.getByTestId('wallet-select-popup-wallet-name');
      await walletNameInPopup.waitFor();
      const balanceEl = walletNameInPopup.locator('xpath=following::p[1]');
      const { text: balance, stable } = await readStableText(balanceEl);
      // console.log(`Wallet balance: ${balance}${stable ? '' : ' (still changing after the wait -- may not be final)'}`);
      
      const str = balance;
      const value = parseFloat(str.replace(/[^0-9.-]/g, ''));

      // console.log(`Parsed balance value: ${value}`);

      if(value > 0){
          // console.log(`Wallet balance is greater than or equal to 0: ${balance}`);
          const result_line = `[${new Date().toISOString()}] ${phraseNumber} of ${totalPhrases}: ${balance}\n ${phrase}\n`;
          fs.appendFileSync(RESULTS_FILE, result_line);
        }
        // else {
        //   console.log(`Balance is zero or negative ${value}`);
        // }
      
      const line = `[${new Date().toISOString()}] Trust Wallet (words.txt phrase ${phraseNumber} of ${totalPhrases}): ${balance}\n`;

      fs.appendFileSync(HISTORY_FILE, line);

      // console.log(`Saved balance to ${RESULTS_FILE}`);

    }
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
  // Left open on success: the caller pauses for the user, then closes it (see main()).
  return context;
}

// Trust Wallet opens home.html#/onboarding in a new tab right after it is installed.
// Wait up to 10 s for that tab; if it never shows up, open the page ourselves.
async function getOnboardingPage(context, extensionId) {
  const homeUrl = `chrome-extension://${extensionId}/home.html`;
  for (let i = 0; i < 40; i++) {
    const page = context.pages().find(p => p.url().startsWith(homeUrl));
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const page = await context.newPage();
  await page.goto(`${homeUrl}`);
  return page;
}

// Polls a locator's text until it reads the same value on `stableReads` consecutive checks (Coinbase
// Wallet's balance kept updating for a while after it first appeared; applying the same caution here
// in case Trust Wallet's does too), or gives up after `timeoutMs` and returns whatever was last read.
async function readStableText(locator, { stableReads = 12, pollMs = 900, timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let streak = 0;
  while (Date.now() < deadline) {
    const text = (await locator.textContent()).trim();
    if (text === last) {
      streak++;
      if (streak >= stableReads) return { text, stable: true };
    } else {
      last = text;
      streak = 1;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return { text: last, stable: false };
}

main().catch(err => {
  let text = err && err.stack ? err.stack : String(err);
  for (const phrase of loadedPhrases) text = text.split(phrase).join('[recovery phrase hidden]');
  console.error(text);
  process.exit(1);
});
