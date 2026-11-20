const assert = require('node:assert/strict')
const { chromium } = require('/opt/expert-tools/test-web/node_modules/playwright')
const baseUrl = process.argv[2]

async function main() {
  const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true })
  try {
    assert.equal(browser.version(), '159.0.8154.6')
    const page = await browser.newPage()
    await page.goto(baseUrl + '/form')
    await page.getByLabel('名称').fill('河洛')
    await page.getByRole('button', { name: '提交' }).click()
    await page.waitForURL('**/submitted?*')
    assert.equal(await page.getByRole('heading').textContent(), '河洛样例')
    const image = await page.screenshot({ path: 'screenshot.png' })
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
