// Offline DOM contract tests. These do not certify the current live Gmail UI.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const sources = ['config.js', 'content.js'].map(f => fs.readFileSync(path.join(root, 'extension', f), 'utf8'));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  let passed = 0;
  const test = async (name, setup, check) => {
    const context = await browser.newContext();
    await context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const page = await context.newPage();
    await page.goto('https://mail.google.com/mail/u/0/#inbox/thread');
    if (setup) await setup(page);
    for (const source of sources) await page.addScriptTag({ content: source });
    try {
      await check(page);
      console.log(`PASS ${name}`);
      passed++;
    } finally { await context.close(); }
  };
  const click = async page => { await page.locator('.gd-button').click(); await page.locator('#gd-notice').waitFor(); };
  const applied = async page => page.evaluate(() => window.applied);
  try {
    await test('open thread adds label and preserves existing label', null, async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.deepEqual(await p.evaluate(() => window.commits[0]), ['true', 'true']);
    });
    await test('selected list messages', p => p.evaluate(() => {
      document.querySelector('h2').remove(); document.querySelector('tr').style.display = '';
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('mixed state becomes checked', p => p.locator('[title="✅処理済"]').evaluate(e => e.setAttribute('aria-checked', 'mixed')),
      async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('idempotent already checked', p => p.locator('[title="✅処理済"]').evaluate(e => e.setAttribute('aria-checked', 'true')),
      async p => { await click(p); assert.equal(await applied(p), 0); assert.match(await p.locator('#gd-notice').innerText(), /既に/); });
    await test('second click never removes label', null, async p => {
      await click(p); await click(p); assert.equal(await applied(p), 1);
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'true');
    });
    await test('missing label produces setup guidance', p => p.locator('[title="✅処理済"]').evaluate(e => e.title = 'different'),
      async p => { await click(p); assert.equal(await applied(p), 0); assert.match(await p.locator('#gd-notice').innerText(), /作成/); });
    await test('no selection prevents native action', p => p.locator('h2').evaluate(e => e.remove()),
      async p => { await click(p); assert.equal(await applied(p), 0); assert.match(await p.locator('#gd-notice').innerText(), /チェック/); });
    await test('unknown checkbox state fails closed', p => p.locator('[title="✅処理済"]').evaluate(e => e.setAttribute('aria-checked', 'unknown')),
      async p => { await click(p); assert.equal(await applied(p), 0); });
    await test('state does not become checked fails closed', p => p.evaluate(() => window.mode.unknown = true),
      async p => { await click(p); assert.equal(await applied(p), 0); });
    await test('unrelated label change aborts and discards menu', p => p.evaluate(() => window.mode.changeOther = true),
      async p => { await click(p); assert.equal(await applied(p), 0); assert.equal(await p.locator('[title="既存ラベル"]').getAttribute('aria-checked'), 'true'); });
    await test('navigation during operation aborts', p => p.evaluate(() => window.mode.navigate = true),
      async p => { await click(p); assert.equal(await applied(p), 0); });
    await test('selection changes while waiting abort', p => p.evaluate(() => {
      document.querySelector('h2').remove(); document.querySelector('tr').style.display = ''; window.mode.delay = 300;
    }), async p => {
      await p.locator('.gd-button').click();
      await p.locator('#mail-row [role=checkbox]').evaluate(e => e.setAttribute('aria-checked', 'false'));
      await p.locator('#gd-notice').waitFor(); assert.equal(await applied(p), 0);
    });
    await test('English toolbar and Apply', p => p.evaluate(() => {
      document.getElementById('native').setAttribute('aria-label', 'Labels'); document.getElementById('apply').textContent = 'Apply';
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('pre-existing menu is not hijacked', p => p.evaluate(() => document.getElementById('picker').style.display = 'block'),
      async p => { await click(p); assert.equal(await applied(p), 0); });
    await test('disabled native control receives no extension button', p => p.locator('#native').evaluate(e => e.setAttribute('aria-disabled', 'true')),
      async p => { assert.equal(await p.locator('.gd-button').count(), 0); });
    await test('compose/dialog controls ignored', p => p.evaluate(() => document.querySelector('main').setAttribute('role', 'dialog')),
      async p => { assert.equal(await p.locator('.gd-button').count(), 0); });
    await test('DOM rerender and repeated initialization create one button', null, async p => {
      await p.addScriptTag({ content: sources[1] });
      await p.locator('#native').evaluate(e => { const clone = e.cloneNode(true); e.replaceWith(clone); });
      await p.waitForFunction(() => document.querySelectorAll('.gd-actions').length === 1 && document.querySelector('.gd-actions').previousElementSibling?.id === 'native');
      assert.equal(await p.locator('.gd-button').count(), 1);
    });
    await test('config supports additional independent actions', p => p.evaluate(() => {
      document.querySelector('[title="✅処理済"]').title = '⏳保留'; document.querySelector('[title="⏳保留"]').textContent = '⏳保留';
    }), async p => {
      // Recreate page with edited configuration to emulate the documented distribution workflow.
      await p.reload();
      await p.locator('[title="✅処理済"]').evaluate(e => { e.title = '⏳保留'; e.textContent = '⏳保留'; });
      await p.addScriptTag({ content: 'globalThis.GmailDoneConfig={actions:[{id:"pending",label:"⏳保留"}]};' });
      await p.addScriptTag({ content: sources[1] });
      await click(p); assert.equal(await applied(p), 1);
    });
    console.log(`${passed} tests passed. Live Gmail verification still required.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
