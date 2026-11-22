// Drives the Coinbase Wallet extension's onboarding in Playwright's Chromium, once per recovery phrase
// in words.txt: opens the onboarding page, clicks "Import a Wallet", then "Enter recovery phrase or
// private key", then "Acknowledge" on the recovery-phrase scam warning, types the phrase and clicks
// "Import wallet", sets the password, ticks the terms checkbox and clicks "Submit", then loads the
// wallet's own page (index.html), waits for its balance to settle, and appends it to results.txt.
// Each phrase gets its own fresh browser profile -- there is no "already set up" state to add to.
//
// Run:  node coinbase-wallet.js
// By default this cycles through every phrase in words.txt, one at a time. To do a subset, set
// PHRASE_START and/or PHRASE_END (1-based, inclusive) -- e.g. PHRASE_START=2 PHRASE_END=2 for just
// the second phrase.
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { chromium } = require('playwright');

// Unpacked copy of the Coinbase Wallet extension (copied from Chrome, minus its _metadata folder).
const EXTENSION_PATH = path.join(__dirname, 'coinbase-wallet-extension');

// Password typed into the wallet's "Create password" screen.
const WALLET_PASSWORD = 'qwe123!@#';

// Where the wallet's balance gets appended to.
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(__dirname, 'results.txt');

const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'history.txt');


// Recovery phrases: one wallet per line, words separated by spaces. They are never printed or logged.
// Set the WORDS_FILE environment variable to read a different file.
const WORDS_FILE = process.env.WORDS_FILE || path.join(__dirname, 'words.txt');

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
}

// Returns a 1-based phrase index from an env var string, clamped to [1, max]. Falls back to
// `fallback` when the env var is unset or not a number.
function clampPhraseIndex(envValue, fallback, max) {
  const n = envValue === undefined ? fallback : Number(envValue);
  if (!Number.isInteger(n)) throw new Error(`Not a whole number: ${envValue}`);
  return Math.min(Math.max(n, 1), max);
}

// Runs the full "import a wallet from a recovery phrase" flow once, in its own fresh browser profile,
// and appends the resulting balance to RESULTS_FILE.
async function importOnePhrase(phrase, phraseNumber, totalPhrases) {
  // Extensions only load in a persistent context.
  // '' = a fresh temporary profile every time, so the wallet always starts at onboarding.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // Playwright's bundled browser; regular Google Chrome no longer allows --load-extension
    // headless: process.env.HEADLESS === '1',
    headless: true,
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

    const importWallet = page.getByRole('button', { name: 'Import a Wallet', exact: true });
    await importWallet.click();
    await importWallet.waitFor({ state: 'hidden' }); // the next onboarding screen has replaced it
    // console.log('Clicked "Import a Wallet".');

    // "Use an existing wallet" screen: choose "Enter recovery phrase or private key".
    const recoveryOption = page.getByRole('button', { name: 'Enter recovery phrase or private key' });
    await recoveryOption.click();
    await recoveryOption.waitFor({ state: 'hidden' }); // the next screen has replaced it
    // console.log('Clicked "Enter recovery phrase or private key".');

    // The "Import wallet" screen opens with a "Beware of recovery phrase scams" warning on top: click Acknowledge.
    const acknowledge = page.getByRole('button', { name: 'Acknowledge', exact: true });
    await acknowledge.click();
    await acknowledge.waitFor({ state: 'hidden' }); // the warning has closed
    // console.log('Clicked "Acknowledge".');

    // "Import wallet" screen: type this phrase, then click "Import wallet"
    // (click() waits until the button is enabled, i.e. until the phrase is accepted).
    const secretInput = page.getByTestId('secret-input');
    await secretInput.fill(phrase);
    // console.log(`Typed recovery phrase ${phraseNumber} of ${totalPhrases}.`);
    await page.getByTestId('btn-import-wallet').click();
    await secretInput.waitFor({ state: 'hidden', timeout: 60_000 }); // the next screen has replaced the form
    // console.log('Clicked "Import wallet".');

    // "Create password" screen: type the password into both fields, tick the terms checkbox, click Submit.
    const passwordInput = page.getByTestId('setPassword');
    await passwordInput.fill(WALLET_PASSWORD);
    await page.getByTestId('setPasswordVerify').fill(WALLET_PASSWORD);
    await page.getByTestId('terms-and-privacy-policy').check();
    await page.getByTestId('btn-password-continue').click(); // click() waits until Submit is enabled
    await passwordInput.waitFor({ state: 'hidden', timeout: 60_000 }); // the next screen has replaced the form
    // console.log('Entered the password, ticked the terms checkbox and clicked "Submit".');

    // Load the wallet's own page (without the onboarding query string) in this same tab.
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    // console.log(`Opened ${page.url()}`);

    // The balance heading renders fast but keeps changing for several more seconds as price/balance
    // data streams in (seen jumping between values ~10s apart in testing), so wait for it to hold
    // still rather than reading it right away.
    const balanceEl = page.getByTestId('wallet-balance');
    await balanceEl.waitFor();
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
 
    const line = `[${new Date().toISOString()}] Coinbase Wallet (words.txt phrase ${phraseNumber} of ${totalPhrases}): ${balance}\n`;

    fs.appendFileSync(HISTORY_FILE, line);
    
    // console.log(`Saved balance to ${RESULTS_FILE}`);
    // ...continue with the next steps here...
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
  // Left open on success: the caller closes it once the user has had a chance to look (see main()).
  return context;
}

// On install the extension is meant to open its onboarding page in a new tab, but in Playwright's Chromium that
// tab did not show up. So wait a moment for it, and if it never appears open the same page ourselves.
async function getOnboardingPage(context, extensionId) {
  const extensionUrl = `chrome-extension://${extensionId}/`;
  for (let i = 0; i < 12; i++) {
    const page = context.pages().find(p => p.url().startsWith(extensionUrl));
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const page = await context.newPage();
  await page.goto(`${extensionUrl}index.html?launchedForOnboarding=true`);
  return page;
}

// Polls a locator's text until it reads the same value on `stableReads` consecutive checks (the
// balance heading keeps updating for a while after it first appears), or gives up after `timeoutMs`
// and returns whatever was last read.
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
