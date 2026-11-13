import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const IAM_SRC = readFileSync(join(ROOT, 'packages/forge-iam/client.js'), 'utf8');
const ENG_SRC = readFileSync(join(ROOT, 'packages/forge-engineering/client.js'), 'utf8');
const DEVOPS_SRC = readFileSync(join(ROOT, 'packages/forge-devops/client.js'), 'utf8');
const GITEE_SRC = readFileSync(join(ROOT, 'packages/forge-gitee/client.js'), 'utf8');

const SHARED_CARD_SURFACE_TOKENS = [
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-border-l4',
  '--dsw-alias-state-business-primary',
  '--dsw-radius-xl',
  '--dsw-radius-lg',
];

const SHARED_FORM_AND_BUTTON_TOKENS = [
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-border-l3',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-radius-md',
  '--dsw-radius-xs',
];

test('all engineering suite UI packages align core design tokens with @heluo/forge-iam', () => {
  for (const token of [...SHARED_CARD_SURFACE_TOKENS, ...SHARED_FORM_AND_BUTTON_TOKENS]) {
    assert.ok(IAM_SRC.includes(token), `reference forge-iam must contain ${token}`);
  }

  for (const token of SHARED_CARD_SURFACE_TOKENS) {
    assert.ok(ENG_SRC.includes(token), `forge-engineering missing shared IAM token ${token}`);
    assert.ok(DEVOPS_SRC.includes(token), `forge-devops missing shared IAM token ${token}`);
    assert.ok(GITEE_SRC.includes(token), `forge-gitee missing shared IAM token ${token}`);
  }

  for (const token of SHARED_FORM_AND_BUTTON_TOKENS) {
    assert.ok(DEVOPS_SRC.includes(token), `forge-devops missing shared IAM form/button token ${token}`);
    assert.ok(GITEE_SRC.includes(token), `forge-gitee missing shared IAM form/button token ${token}`);
  }
});

test('engineering suite UI contains zero legacy/static color tokens', () => {
  for (const [name, src] of [
    ['forge-engineering', ENG_SRC],
    ['forge-devops', DEVOPS_SRC],
    ['forge-gitee', GITEE_SRC],
  ]) {
    assert.doesNotMatch(
      src,
      /--dsw-static-|--dsw-alias-brand-primary|--dsw-alias-border-secondary|--dsw-alias-bg-primary|--dsw-alias-label-primary-inverted/u,
      `${name} must not regress to legacy/static tokens`,
    );
  }
});
