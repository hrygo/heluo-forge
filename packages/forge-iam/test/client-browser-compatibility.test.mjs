import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPanel } from './support/client-panel.mjs';

test('unsupported browsers receive a dismissible compatibility notice', async (t) => {
  const panel = await mountPanel(() => { throw new Error('unexpected request'); }, {
    componentId: 'forge-iam-browser-compatibility', abortSignal: {},
  });
  t.after(() => panel.close());
  assert.match(panel.text(panel.render()), /浏览器.*工作区/);
  assert.match(panel.text(panel.render()), /Chrome.*Chromium/);
  panel.findButton(panel.render(), '关闭').props.onClick();
  assert.equal(panel.render(), null);
});

test('browsers with AbortSignal.any receive no compatibility notice', async (t) => {
  const panel = await mountPanel(() => { throw new Error('unexpected request'); }, {
    componentId: 'forge-iam-browser-compatibility', abortSignal: { any() {} },
  });
  t.after(() => panel.close());
  assert.equal(panel.render(), null);
});
