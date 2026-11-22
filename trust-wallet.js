// Drives the Trust Wallet extension's onboarding in Playwright's Chromium:
// "I already have a wallet" -> Password -> Continue -> "Other mobile wallet or extension",
// then imports the first recovery phrase from words.txt: type it, Import, tick the three confirmations, Import,
// and finally clicks "Open my wallet".
//
// Run:  node trust-wallet.js
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
  console.log(`Loaded ${phrases.length} recovery phrase(s) from ${path.basename(WORDS_FILE)}.`);

  // Extensions only load in a persistent context.
  // '' = a fresh temporary profile on every run, so Trust Wallet always starts at onboarding.
  // Use a folder path instead (e.g. path.join(__dirname, 'profile')) to keep the wallet between runs.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // Playwright's bundled browser; regular Google Chrome no longer allows --load-extension
    headless: process.env.HEADLESS === '1',
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

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
  console.log('Clicked "I already have a wallet".');

  // Next screen ("Secure your wallet"): if it offers a "Password" option, click it.
  // The screen can take a moment to render, so wait a few seconds before deciding it isn't there.
  const passwordOption = page.getByRole('button', { name: 'Password', exact: true });
  const offered = await passwordOption.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (offered) {
    await passwordOption.click();
    await passwordOption.waitFor({ state: 'hidden' }); // the next screen has replaced it
    console.log('Clicked "Password".');

    // "Create password" screen: type the password into both fields, then click Continue.
    // Both inputs share data-testid="password-field", so tell them apart by placeholder
    // (the "Confirm password" field's placeholder is just "Password").
    await page.getByPlaceholder('Min 8 characters').fill(WALLET_PASSWORD);
    await page.getByPlaceholder('Password', { exact: true }).fill(WALLET_PASSWORD);
    // Continue stays disabled until both fields are valid; click() waits for it to become enabled.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Create password' }).waitFor({ state: 'hidden' });
    console.log('Entered the password and clicked "Continue".');
  } else {
    console.log('No "Password" option on this screen, skipping.');
  }

  // "Import a wallet" screen ("Select your existing wallet"): click "Other mobile wallet or extension".
  const otherWallet = page.getByRole('button', { name: 'Other mobile wallet or extension', exact: true });
  await otherWallet.click();
  await otherWallet.waitFor({ state: 'hidden' }); // the next screen has replaced it
  console.log('Clicked "Other mobile wallet or extension".');

  // "Import with Secret Phrase or Private Key" screen: type the first recovery phrase from words.txt,
  // then click Import (click() waits until Import is enabled, i.e. until the phrase is accepted).
  await page.getByTestId('import-wallet-secret').fill(phrases[0]);
  console.log(`Typed recovery phrase 1 of ${phrases.length}.`);
  await page.getByTestId('import-wallet-submit').click();

  // Import opens a "Check your Secret Phrase is safe" dialog.
  // (Wait for its heading: the dialog's outer container has no size, so Playwright treats it as hidden.)
  const dialogHeading = page.getByRole('heading', { name: 'Check your Secret Phrase is safe' });
  await dialogHeading.waitFor();
  console.log('Clicked "Import"; the "Check your Secret Phrase is safe" dialog is open.');

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
  console.log('Ticked the three confirmations and clicked "Import" in the dialog.');

  // The extension now checks the wallet (about 10 s), then shows "Start exploring" with an "Open my wallet" button.
  // For some phrases it first asks "Select wallet for <chain>": that choice is not scripted, so nothing is clicked then.
  const openWallet = page.getByRole('button', { name: 'Open my wallet', exact: true });
  const chooseWallet = page.getByRole('heading', { name: /^Select wallet for / });
  await openWallet.or(chooseWallet).first().waitFor({ timeout: 60_000 });
  if (await chooseWallet.isVisible()) {
    console.log('The extension is asking which wallet to use ("Select wallet for ..."); not clicking anything, pick one in the window.');
  } else {
    await openWallet.click();
    // The page stays after the click: "Open my wallet" turns disabled once the wallet has been opened.
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open my wallet');
      return !button || button.disabled;
    });
    console.log('Clicked "Open my wallet".');
  }

  // ...continue with the next steps here...

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter to close the browser...');
  rl.close();
  await context.close();
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
  await page.goto(`${homeUrl}#/onboarding`);
  return page;
}

main().catch(err => {
  let text = err && err.stack ? err.stack : String(err);
  for (const phrase of loadedPhrases) text = text.split(phrase).join('[recovery phrase hidden]');
  console.error(text);
  process.exit(1);
});
