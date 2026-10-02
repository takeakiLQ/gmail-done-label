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
  const test = async (name, setup, check, fullConfig = false) => {
    const context = await browser.newContext();
    await context.route('https://mail.google.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const page = await context.newPage();
    await page.goto('https://mail.google.com/mail/u/0/#inbox/thread');
    if (setup) await setup(page);
        await page.addScriptTag({ content: fullConfig ? sources[0] : 'globalThis.GmailDoneConfig={actions:[{id:"done",label:"✅処理済",undo:true}]};' });
    await page.addScriptTag({ content: sources[1] });
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'extension', 'content.css'), 'utf8') });
    try {
      await check(page);
      console.log(`PASS ${name}`);
      passed++;
    } finally { await context.close(); }
  };
  const click = async page => { await page.locator('.gd-button').click(); await page.locator('#gd-notice').waitFor(); };
  const cancel = async (page, action = 'done') => {
    await page.locator(`.gd-toggle[data-action="${action}"]`).click();
    await page.locator(`.gd-toggle[data-action="${action}"] + .gd-cancel-menu .gd-undo`).click();
  };
  const applied = async page => page.evaluate(() => window.applied);
  try {
    const statusSetup = ({doneState = 'false', replyState = 'false', immediate = false} = {}) => p => p.evaluate(({doneState, replyState, immediate}) => {
      const picker = document.getElementById('picker');
      const done = picker.querySelector('[title="✅処理済"]');
      done.setAttribute('aria-checked', doneState);
      const reply = done.cloneNode(true);
      reply.title = '✉️要返信'; reply.textContent = '✉️要返信';
      reply.setAttribute('aria-checked', replyState);
      done.after(reply);
      const toggle = event => {
        const row = event.currentTarget;
        row.setAttribute('aria-checked', row.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
        if (immediate) window.applied++;
      };
      done.onclick = reply.onclick = toggle;
      if (immediate) {
        document.getElementById('apply').remove();
        picker.onkeydown = null;
        document.getElementById('native').onclick = () => {
          picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
        };
      }
    }, {doneState, replyState, immediate});
    for (const immediate of [false, true]) {
      for (const action of ['reply', 'done']) {
        await test(`exclusive ${action} transition (${immediate ? 'immediate' : 'Apply'})`,
          statusSetup({doneState: action === 'reply' ? 'true' : 'false', replyState: action === 'done' ? 'true' : 'false', immediate}), async p => {
            await p.locator(`.gd-button[data-action="${action}"]`).click();
            await p.locator('#gd-notice').waitFor();
            assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), String(action === 'done'));
            assert.equal(await p.locator('[title="✉️要返信"]').getAttribute('aria-checked'), String(action === 'reply'));
            assert.equal(await p.locator('[title="既存ラベル"]').getAttribute('aria-checked'), 'true');
            assert.equal(await p.locator('#picker').isVisible(), false);
            assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'false');
          }, true);
      }
    }
    for (const action of ['reply', 'done']) {
      await test(`cancel ${action} removes only that label`, statusSetup({doneState: 'true', replyState: 'true'}), async p => {
        await cancel(p, action); await p.locator('#gd-notice').waitFor();
        assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), String(action !== 'done'));
        assert.equal(await p.locator('[title="✉️要返信"]').getAttribute('aria-checked'), String(action !== 'reply'));
        assert.equal(await p.locator('[title="既存ラベル"]').getAttribute('aria-checked'), 'true');
      }, true);
    }
    await test('mixed selection switches all selected mail to done', statusSetup({doneState: 'mixed', replyState: 'mixed'}), async p => {
      await p.locator('.gd-button[data-action="done"]').click(); await p.locator('#gd-notice').waitFor();
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'true');
      assert.equal(await p.locator('[title="✉️要返信"]').getAttribute('aria-checked'), 'false');
    }, true);
    await test('missing paired label prevents any state change', null, async p => {
      await p.locator('.gd-button[data-action="done"]').click(); await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 0);
      assert.match(await p.locator('#gd-notice').innerText(), /✉️要返信/);
    }, true);
    await test('partial transition stops if target changes between steps', async p => {
      await statusSetup({replyState: 'true'})(p);
      await p.evaluate(() => {
        const apply = document.getElementById('apply'); const save = apply.onclick;
        apply.onclick = () => { save(); location.hash = '#inbox/other'; };
      });
    }, async p => {
      await p.locator('.gd-button[data-action="done"]').click(); await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'false');
      assert.match(await p.locator('#gd-notice').innerText(), /途中/);
    }, true);
    await test('cancel menus close on Escape and outside click without label writes', statusSetup(), async p => {
      const toggle = p.locator('.gd-toggle[data-action="reply"]');
      await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await p.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click(); await p.locator('h2').click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await applied(p), 0);
    }, true);
    await test('cold menu handlers and delayed autofocus are ready before label action', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      document.getElementById('apply').remove();
      picker.onkeydown = null;
      const native = document.getElementById('native');
      const done = document.querySelector('[title="✅処理済"]');
      done.onclick = null;
      native.onclick = () => {
        if (picker.style.display !== 'none') {
          if (document.activeElement === native) picker.style.display = 'none';
          return;
        }
        picker.style.display = 'block';
        setTimeout(() => {
          picker.querySelector('input').focus();
          done.onclick = () => { done.setAttribute('aria-checked', 'true'); window.applied++; };
        }, 250);
      };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('#picker').isVisible(), false);
      assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'false');
    });
    await test('cold menu closes asynchronously without a second toggle', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      document.getElementById('apply').remove();
      picker.onkeydown = null;
      const native = document.getElementById('native');
      native.onclick = () => {
        window.nativeClicks = (window.nativeClicks || 0) + 1;
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      };
      native.onmousedown = () => {
        if (picker.style.display !== 'none') setTimeout(() => { picker.style.display = 'none'; }, 400);
      };
      const done = document.querySelector('[title="✅処理済"]');
      done.onclick = () => { done.setAttribute('aria-checked', 'true'); window.applied++; };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.evaluate(() => window.nativeClicks), 1);
      assert.equal(await p.locator('#picker').isVisible(), false);
    });
    for (const phase of ['focus', 'mousedown', 'mouseup']) {
      await test(`closing never reopens a menu dismissed on ${phase}`, p => p.evaluate(phase => {
        const picker = document.getElementById('picker');
        document.getElementById('apply').remove();
        picker.onkeydown = null;
        const native = document.getElementById('native');
        native.onclick = () => {
          window.nativeClicks = (window.nativeClicks || 0) + 1;
          picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
        };
        native.addEventListener(phase, () => {
          if (picker.style.display !== 'none') {
            if (phase === 'mousedown') setTimeout(() => { picker.style.display = 'none'; }, 80);
            else picker.style.display = 'none';
          }
        });
        const done = document.querySelector('[title="✅処理済"]');
        done.onclick = () => {
          done.setAttribute('aria-checked', 'true');
          window.applied++;
          picker.querySelector('input').focus();
        };
      }, phase), async p => {
        await click(p);
        assert.equal(await applied(p), 1);
        assert.equal(await p.locator('#picker').isVisible(), false);
        assert.equal(await p.evaluate(() => window.nativeClicks), 1);
        assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'true');
      });
    }
    for (const changed of [false, true]) {
      await test(`thread heading redraw with ${changed ? 'different' : 'same'} thread ID`, p => p.evaluate(changed => {
        const heading = document.querySelector('h2');
        heading.setAttribute('data-legacy-thread-id', 'thread-A');
        const native = document.getElementById('native');
        const open = native.onclick;
        native.onclick = () => {
          open();
          const clone = heading.cloneNode(true);
          if (changed) clone.setAttribute('data-legacy-thread-id', 'thread-B');
          heading.replaceWith(clone);
        };
      }, changed), async p => {
        await click(p);
        assert.equal(await applied(p), changed ? 0 : 1);
        assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), String(changed));
      });
    }
    await test('hidden thread marker and heading replacement do not change route target', p => p.evaluate(() => {
      const hidden = document.createElement('div');
      hidden.setAttribute('data-thread-id', 'hidden-marker');
      hidden.style.display = 'none';
      document.querySelector('main').prepend(hidden);
      const native = document.getElementById('native');
      const open = native.onclick;
      native.onclick = () => {
        open();
        const heading = document.querySelector('h2');
        heading.replaceWith(heading.cloneNode(true));
      };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'false');
    });
    await test('successful immediate operation closes with native toggle before Escape', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      document.getElementById('apply').remove();
      const native = document.getElementById('native');
      native.onclick = () => {
        window.toggleCount = (window.toggleCount || 0) + 1;
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      };
      picker.onkeydown = () => { window.escapeCount = (window.escapeCount || 0) + 1; };
      const done = document.querySelector('[title="✅処理済"]');
      done.onclick = () => { done.setAttribute('aria-checked', 'true'); window.applied++; };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.evaluate(() => window.toggleCount), 2);
      assert.equal(await p.evaluate(() => window.escapeCount || 0), 0);
      assert.equal(await p.locator('#picker').isVisible(), false);
    });
    await test('immediate commit redraw does not cause a target-change error', p => p.evaluate(() => {
      const done = document.querySelector('[title="✅処理済"]');
      done.onclick = () => {
        done.setAttribute('aria-checked', 'true');
        window.applied++;
        document.getElementById('picker').style.display = 'none';
        document.querySelector('h2').remove();
        document.getElementById('native').remove();
        location.hash = '#inbox';
      };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'false');
    });
    for (const changed of [false, true]) {
      await test(`row redraw with ${changed ? 'different' : 'same'} stable target ID`, p => p.evaluate(changed => {
        document.querySelector('h2').remove();
        const row = document.getElementById('mail-row');
        row.style.display = '';
        row.setAttribute('data-legacy-thread-id', 'fixture-A');
        const native = document.getElementById('native');
        const open = native.onclick;
        native.onclick = () => {
          open();
          const clone = row.cloneNode(true);
          if (changed) clone.setAttribute('data-legacy-thread-id', 'fixture-B');
          row.replaceWith(clone);
          native.setAttribute('aria-disabled', 'true');
        };
      }, changed), async p => {
        await click(p);
        assert.equal(await applied(p), changed ? 0 : 1);
        assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), String(changed));
      });
    }
    for (const remove of [false, true]) {
      await test(`label text click commits and closes immediately (${remove ? 'remove' : 'add'})`, p => p.evaluate(remove => {
        const picker = document.getElementById('picker');
        const done = picker.querySelector('[title="✅処理済"]');
        done.innerHTML = '<span class="J-LC-Jo">□</span><span class="J-LC-Jz">✅処理済</span>';
        done.setAttribute('aria-checked', String(remove));
        document.getElementById('apply').remove();
        done.onclick = event => {
          done.setAttribute('aria-checked', done.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          if (event.target.matches('.J-LC-Jz')) {
            window.applied++;
            picker.style.display = 'none';
          }
        };
      }, remove), async p => {
        if (remove) await cancel(p); else await p.locator('.gd-button').click();
        await p.locator('#gd-notice').waitFor();
        assert.equal(await applied(p), 1);
        assert.equal(await p.locator('#picker').isVisible(), false);
        assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), String(!remove));
        assert.equal(await p.locator('[title="既存ラベル"]').getAttribute('aria-checked'), 'true');
      });
    }
    await test('cancel button removes only the done label', p => p.evaluate(() => {
      document.querySelector('[title="✅処理済"]').setAttribute('aria-checked', 'true');
    }), async p => {
      await cancel(p);
      await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 1);
      assert.deepEqual(await p.evaluate(() => window.commits[0]), ['false', 'true']);
      assert.equal(await p.locator('#picker').isVisible(), false);
    });
    await test('cancel on an unlabeled target makes no change', null, async p => {
      await cancel(p);
      await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 0);
      assert.match(await p.locator('#gd-notice').innerText(), /付いていません/);
    });
    await test('cancel mixed selection ends unchecked', p => p.evaluate(() => {
      document.querySelector('[title="✅処理済"]').setAttribute('aria-checked', 'mixed');
    }), async p => {
      await cancel(p);
      await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 1);
      assert.deepEqual(await p.evaluate(() => window.commits[0]), ['false', 'true']);
    });
    await test('cancel works with immediate-save menu and closes it', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      picker.onkeydown = null;
      document.getElementById('apply').remove();
      document.getElementById('native').onclick = () => {
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      };
      const done = document.querySelector('[title="✅処理済"]');
      done.setAttribute('aria-checked', 'true');
      done.onclick = event => { event.currentTarget.setAttribute('aria-checked', 'false'); window.applied++; };
    }), async p => {
      await cancel(p);
      await p.locator('#gd-notice').waitFor();
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('#picker').isVisible(), false);
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'false');
    });
    await test('native toolbar dismissal closes menu without a second label operation', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      picker.onkeydown = null;
      document.getElementById('apply').remove();
      document.getElementById('native').onclick = () => {
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      };
      document.querySelector('[title="✅処理済"]').onclick = event => {
        event.currentTarget.setAttribute('aria-checked', 'true');
        window.applied++;
      };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'true');
      assert.equal(await p.locator('#picker').isVisible(), false);
      assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'false');
      await click(p);
      assert.equal(await applied(p), 1);
      assert.equal(await p.locator('#picker').isVisible(), false);
    });
    await test('already checked immediate menu closes without removing label', p => p.evaluate(() => {
      const picker = document.getElementById('picker');
      picker.onkeydown = null;
      document.getElementById('apply').remove();
      document.querySelector('[title="✅処理済"]').setAttribute('aria-checked', 'true');
      document.getElementById('native').onclick = () => {
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      };
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 0);
      assert.equal(await p.locator('#picker').isVisible(), false);
      assert.equal(await p.locator('[title="✅処理済"]').getAttribute('aria-checked'), 'true');
    });
    await test('delayed Apply is clicked before closing the menu', p => p.evaluate(() => {
      const apply = document.getElementById('apply');
      apply.style.display = 'none';
      const done = document.querySelector('[title="✅処理済"]');
      const original = done.onclick;
      done.onclick = event => { original(event); setTimeout(() => { apply.style.display = ''; }, 450); };
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('disabled Apply is not mistaken for immediate save', p => p.evaluate(() => {
      document.getElementById('apply').setAttribute('aria-disabled', 'true');
    }), async p => {
      await click(p);
      assert.equal(await applied(p), 0);
      assert.equal(await p.locator('#gd-notice').getAttribute('data-error'), 'true');
    });
    await test('Apply appears only after selecting a label', p => p.evaluate(() => {
      const apply = document.getElementById('apply');
      apply.style.display = 'none';
      const done = document.querySelector('[title="✅処理済"]');
      const clickHandler = done.onclick;
      done.onclick = event => { clickHandler(event); apply.style.display = ''; };
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('native label selection can commit and close menu immediately', p => p.evaluate(() => {
      const done = document.querySelector('[title="✅処理済"]');
      const clickHandler = done.onclick;
      document.getElementById('apply').style.display = 'none';
      done.onclick = event => {
        clickHandler(event);
        window.applied++;
        document.getElementById('picker').style.display = 'none';
      };
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('native toolbar that opens on mousedown', p => p.evaluate(() => {
      const native = document.getElementById('native');
      native.onmousedown = native.onclick;
      native.onclick = null;
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('Apply disabled until checkbox changes', p => p.evaluate(() => {
      const apply = document.getElementById('apply');
      apply.setAttribute('aria-disabled', 'true');
      const done = document.querySelector('[title="✅処理済"]');
      const clickHandler = done.onclick;
      done.onclick = event => { clickHandler(event); apply.setAttribute('aria-disabled', 'false'); };
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
    await test('checkbox and Apply react to mouseup', p => p.evaluate(() => {
      for (const control of [document.querySelector('[title="✅処理済"]'), document.getElementById('apply')]) {
        control.onmouseup = control.onclick;
        control.onclick = null;
      }
    }), async p => { await click(p); assert.equal(await applied(p), 1); });
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
