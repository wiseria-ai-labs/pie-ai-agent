// PR #7（fix/custom-provider-model-edit）真机验收 — 功能批。
// 环境搭建 / 配方坑见 docs/agents/auto-acceptance.md。纯 UI 功能流：不起 daemon、
// 不用 eval bridge（全部走真实 UI 操作 + IDB 持久化）；baseUrl 运行时生效项用
// PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 拦 SW fetch + mock SSE 断言。
//
// 导航配方（六态顶栏 IA，#290 后）：设置入口 = 齿轮 aria "Open settings"；设置内
// 无齿轮，二级页/根页均靠顶栏 aria "Back" 逐级返回，根页 Back 即回聊天。
// Models 二级页入口行叫 "Model Configs"。
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_ACCEPT_BASE;
if (!BASE) throw new Error('PIE_ACCEPT_BASE 未设置');
const DIST = process.env.PIE_ACCEPT_DIST || `${BASE}/dist-pilot`;
const TAG = 'pr7';
const REPORT = `${BASE}/report`;
fs.mkdirSync(REPORT, { recursive: true });
const results = [];
let shot = 0;

function record(item, status, note = '') {
  results.push({ item, status, note });
  console.log(`[${status}] ${item}${note ? ' — ' + note : ''}`);
}
async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: `${REPORT}/${TAG}-${String(shot).padStart(2, '0')}-${name}.png` });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(`${BASE}/profile-${TAG}`, {
  headless: false,
  viewport: { width: 420, height: 900 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=en-US'],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

// —— item 7 的 SW fetch 拦截：mock 上游，记录命中 URL ——
const hitUrls = [];
await ctx.route('**/chat/completions', (route) => {
  hitUrls.push(route.request().url());
  route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: [
      'data: {"choices":[{"delta":{"content":"mock-ok"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
  });
});

const page = await ctx.newPage();
page.setDefaultTimeout(12000);
await page.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
await sleep(3500); // SW startup pipeline 落定

// ————— 导航 helpers —————
const composer = () => page.getByPlaceholder(/Tell the agent what to do/);
// 关掉可能盖在顶栏上的 popover（ModelPicker 只认 outside mousedown，不认 Esc）
async function dismissPopover() {
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.mouse.click(4, 500);
    await sleep(300);
  }
}
async function gotoModelsPage() {
  await dismissPopover();
  if ((await composer().count()) > 0) {
    // 六态顶栏：chat 态无齿轮，设置入口 = ☰ 抽屉右上角 aria "Settings"；
    // 首启空态才有裸 "Open settings" 按钮
    const gear = page.getByRole('button', { name: 'Open settings', exact: true });
    if ((await gear.count()) > 0) {
      await gear.click();
    } else {
      await page.getByRole('button', { name: 'Open sessions list', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
  }
  const entry = page.getByText('Model Configs', { exact: true });
  if ((await entry.count()) > 0) await entry.click();
  await page.getByRole('button', { name: '+ Add config' }).waitFor();
}
async function gotoChat() {
  await dismissPopover();
  for (let i = 0; i < 4; i++) {
    if ((await composer().count()) > 0) return;
    const back = page.getByRole('button', { name: 'Back', exact: true });
    if ((await back.count()) === 0) break;
    await back.first().click();
    await sleep(300);
  }
  await composer().waitFor();
}
// 模型行内按钮：行 = 模型 id 文本的父级 div
const rowBtn = (modelId, label) =>
  page.getByText(modelId, { exact: true }).locator('..').getByLabel(label);

// ============ 1. 向导创建 custom provider ============
try {
  await gotoModelsPage();
  await page.getByRole('button', { name: '+ Add config' }).click();
  await page.getByRole('button', { name: 'Select provider' }).click();
  await page.getByRole('button', { name: '+ New custom provider' }).click();
  await page.getByPlaceholder('My custom provider').fill('AccProxy');
  await page.getByPlaceholder('https://api.example.com/v1').fill('https://acc.mock/v1');
  await page.getByLabel('api key', { exact: true }).fill('sk-acc-test');
  for (const id of ['m-alpha', 'm-beta']) {
    await page.getByRole('button', { name: '+ add custom model' }).click();
    await page.getByPlaceholder(/^(model id|gpt-4o-mini)$/).fill(id);
    await page.getByRole('button', { name: 'Save', exact: true }).last().click();
    await sleep(300);
  }
  await snap(page, 'wizard-filled');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('AccProxy', { exact: true }).first().waitFor();
  record('1. 向导创建 custom provider + 2 模型', 'PASS');
} catch (e) {
  record('1. 向导创建 custom provider + 2 模型', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item1-error');
}

// ============ 2. 设置卡模型行可编辑（#3 主诉）============
try {
  await page.getByText('AccProxy', { exact: true }).first().click(); // 展开卡
  await page.getByText('m-alpha', { exact: true }).waitFor();
  const edits = await page.getByLabel('edit').count();
  const removes = await page.getByLabel('remove').count();
  await snap(page, 'card-editable-rows');
  if (edits >= 2 && removes >= 2) {
    record('2. 模型行有 edit/remove 按钮', 'PASS', `edit=${edits} remove=${removes}`);
  } else {
    record('2. 模型行有 edit/remove 按钮', 'FAIL', `edit=${edits} remove=${removes}（期望各≥2）`);
  }
} catch (e) {
  record('2. 模型行有 edit/remove 按钮', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item2-error');
}

// ============ 3. 编辑 meta 持久 + 重挂载仍可编辑 ============
try {
  await rowBtn('m-alpha', 'edit').click();
  const modal = page.locator('div.fixed.inset-0'); // ModelMetaEditor 全屏遮罩容器
  await modal.getByText('EDIT MODEL').waitFor();
  await modal.getByRole('checkbox').check(); // Vision on（圈定模态内，别撞页面其它 checkbox）
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await sleep(600);
  // 收起 → 重新展开（强制重挂载，杀「短暂可编辑」假通过）
  await page.getByText('AccProxy', { exact: true }).first().click();
  await sleep(400);
  await page.getByText('AccProxy', { exact: true }).first().click();
  await page.getByText('m-alpha', { exact: true }).waitFor();
  const editsAfter = await page.getByLabel('edit').count();
  const visionChips = await page.getByText('vision', { exact: true }).count();
  // 磁盘级证据：直接读 IDB 里的 provider 实体，确认 vision 真持久化
  const entityVision = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('pie');
    req.onsuccess = () => {
      const all = req.result.transaction('config', 'readonly').objectStore('config').getAll();
      all.onsuccess = () => {
        const cp = all.result.find((r) => String(r.key).startsWith('custom_provider_'));
        resolve(cp?.value?.models?.find((m) => m.id === 'm-alpha')?.vision ?? '(entity missing)');
      };
      all.onerror = () => resolve('(idb error)');
    };
    req.onerror = () => resolve('(idb open error)');
  }));
  await snap(page, 'remount-still-editable');
  if (editsAfter >= 2 && visionChips >= 1 && entityVision === true) {
    record('3. meta 编辑持久 + 重挂载仍可编辑', 'PASS', `edit=${editsAfter} chip=${visionChips} entity.vision=${entityVision}`);
  } else {
    record('3. meta 编辑持久 + 重挂载仍可编辑', 'FAIL', `edit=${editsAfter} chip=${visionChips} entity.vision=${entityVision}`);
  }
} catch (e) {
  record('3. meta 编辑持久 + 重挂载仍可编辑', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item3-error');
}

// ============ 4. 删除模型 + 重挂载仍删 ============
try {
  await rowBtn('m-beta', 'remove').click();
  // 轮询 5s：区分「异步 reload 延迟」vs「行被 merge-only effect 复活直到重挂载」
  let goneMs = -1;
  for (let t = 0; t <= 5000; t += 250) {
    if ((await page.getByText('m-beta', { exact: true }).count()) === 0) { goneMs = t; break; }
    await sleep(250);
  }
  const goneNow = goneMs >= 0;
  await page.getByText('AccProxy', { exact: true }).first().click();
  await sleep(400);
  await page.getByText('AccProxy', { exact: true }).first().click();
  await page.getByText('m-alpha', { exact: true }).waitFor();
  const goneAfter = (await page.getByText('m-beta', { exact: true }).count()) === 0;
  await snap(page, 'model-deleted');
  if (goneNow && goneAfter) record('4. 删除模型（entity 真删、重挂载不复活）', 'PASS', `行消失耗时=${goneMs}ms`);
  else record('4. 删除模型', 'FAIL', `goneMs=${goneMs} goneAfter=${goneAfter}（-1=5s 内未消失，疑 merge-only effect 复活）`);
} catch (e) {
  record('4. 删除模型', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item4-error');
}

// ============ 5. ModelPicker 同步（选得到 m-alpha、看不到 m-beta）============
try {
  await gotoChat();
  const trigger = page.locator('button').filter({ hasText: /AccProxy|\(select model\)/ }).first();
  await trigger.click();
  await sleep(400);
  const picker = page.getByRole('dialog'); // Popover 有 role=dialog，隔离 trigger 同名文本
  await picker.waitFor();
  // ⚠ accordion 收起态的行是「挂载但 0fr clip」——rect 非零，Playwright 可见性
  // 判定会被骗过（isVisible 恒 true）。不能靠可见性判展开态；直接点 provider 行
  // 展开（mount 时 expandedId=null → 初始必收起），点不到模型行就再 toggle 重试。
  const provRow = picker.locator('button').filter({ hasText: 'AccProxy' }).first();
  const alphaRow = picker.getByText('m-alpha', { exact: true }).last();
  await provRow.click();
  await sleep(500);
  const betaInPicker = await picker.getByText('m-beta', { exact: true }).count();
  await snap(page, 'picker-open');
  try {
    await alphaRow.click({ timeout: 4000 });
  } catch {
    await provRow.click(); // 初始态若已展开则刚才被收起——再 toggle 回来
    await sleep(500);
    await alphaRow.click({ timeout: 4000 });
  }
  await sleep(400);
  const triggerHasAlpha = await page.locator('button').filter({ hasText: 'm-alpha' }).count();
  if (betaInPicker === 0 && triggerHasAlpha >= 1) {
    record('5. ModelPicker：m-alpha 可选、m-beta 已同步消失', 'PASS');
  } else {
    record('5. ModelPicker 同步', 'FAIL', `betaInPicker=${betaInPicker} triggerHasAlpha=${triggerHasAlpha}`);
  }
} catch (e) {
  record('5. ModelPicker 同步', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item5-error');
}

// ============ 6. 设置卡改 name/baseUrl → 列表即时更新 ============
try {
  await gotoModelsPage();
  await page.getByText('AccProxy', { exact: true }).first().click(); // 展开
  const nameInput = page.getByPlaceholder('My custom provider');
  const urlInput = page.getByPlaceholder('https://api.example.com/v1');
  await nameInput.waitFor();
  const nameVal = await nameInput.inputValue();
  const urlVal = await urlInput.inputValue();
  await nameInput.fill('AccProxy2');
  await urlInput.fill('https://acc2.mock/v1');
  await snap(page, 'entity-fields-edited');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('AccProxy2', { exact: true }).first().waitFor({ timeout: 6000 });
  if (nameVal === 'AccProxy' && urlVal === 'https://acc.mock/v1') {
    record('6. 设置卡 name/baseUrl 预填正确、保存后列表即时更新', 'PASS');
  } else {
    record('6. 设置卡 name/baseUrl', 'FAIL', `预填 name=${nameVal} url=${urlVal}`);
  }
  await snap(page, 'renamed-in-list');
} catch (e) {
  record('6. 设置卡 name/baseUrl 可编辑', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item6-error');
}

// ============ 7. baseUrl 运行时生效（SW fetch 打到新 host）============
try {
  await gotoChat();
  hitUrls.length = 0; // 只认本次发送后的命中
  await composer().fill('say hi');
  await composer().press('Enter');
  let waited = 0;
  while (hitUrls.length === 0 && waited < 20000) { await sleep(500); waited += 500; }
  await snap(page, 'task-sent');
  const url = hitUrls.at(-1) ?? '(no hit)';
  if (url.startsWith('https://acc2.mock/v1/')) {
    record('7. baseUrl 改后运行时生效', 'PASS', `hit=${url}`);
  } else {
    record('7. baseUrl 改后运行时生效', 'FAIL', `hit=${url}（期望 acc2.mock/v1/*）`);
  }
} catch (e) {
  record('7. baseUrl 运行时生效', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item7-error');
}

// ============ 8. builtin 卡回归（anthropic）============
try {
  await gotoModelsPage();
  await page.getByRole('button', { name: '+ Add config' }).click();
  await page.getByRole('button', { name: 'Select provider' }).click();
  await page.getByRole('button', { name: /^Anthropic/ }).click();
  await page.getByLabel('api key', { exact: true }).fill('sk-ant-test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await sleep(800);
  await page.getByText('Anthropic', { exact: true }).first().click(); // 展开卡
  await sleep(600);
  const cpFieldsInCard = await page.getByPlaceholder('My custom provider').count();
  const addModelBtn = await page.getByRole('button', { name: '+ add custom model' }).count();
  await snap(page, 'builtin-card');
  if (cpFieldsInCard === 0 && addModelBtn >= 1) {
    record('8. builtin 卡无 name/baseUrl 字段、模型区正常', 'PASS');
  } else {
    record('8. builtin 卡回归', 'FAIL', `cpFields=${cpFieldsInCard} addModelBtn=${addModelBtn}`);
  }
  await page.getByText('Anthropic', { exact: true }).first().click(); // 收起
} catch (e) {
  record('8. builtin 卡回归', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item8-error');
}

// ============ 9. 向导下拉 Configured chip + Edit provider ============
try {
  await page.getByRole('button', { name: '+ Add config' }).click();
  await page.getByRole('button', { name: 'Select provider' }).click();
  const chipCount = await page.getByText('Configured', { exact: true }).count();
  await page.getByRole('button', { name: 'Edit provider' }).first().click();
  await sleep(400);
  const keyForm = await page.getByLabel('api key', { exact: true }).count();
  const namePrefill = await page.getByPlaceholder('My custom provider').inputValue().catch(() => '(missing)');
  await snap(page, 'wizard-edit-configured');
  if (chipCount >= 1 && keyForm === 0 && namePrefill === 'AccProxy2') {
    record('9. 向导下拉 Configured chip + 就地编辑（无 key 表单）', 'PASS', `chips=${chipCount}`);
  } else {
    record('9. 向导下拉编辑入口', 'FAIL', `chips=${chipCount} keyForm=${keyForm} name=${namePrefill}`);
  }
} catch (e) {
  record('9. 向导下拉编辑入口', 'ERROR', String(e).slice(0, 160));
  await snap(page, 'item9-error');
}

fs.writeFileSync(`${REPORT}/results-${TAG}.json`, JSON.stringify(results, null, 2));
console.log('\n==== SUMMARY ====');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.item}${r.note ? ' — ' + r.note : ''}`);
await ctx.close();
const bad = results.filter((r) => r.status !== 'PASS');
process.exit(bad.length ? 1 : 0);
