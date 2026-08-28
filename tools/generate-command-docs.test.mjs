import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { COMMAND_REGISTRY } from '../skill/scripts/command-registry.mjs';
import { renderCommandDirectory, replaceGeneratedBlock } from './generate-command-docs.mjs';

const guide = await readFile(new URL('../docs/COMMANDS.md', import.meta.url), 'utf8');

function generatedBlock(text) {
  const begin = text.indexOf('<!-- BEGIN GENERATED COMMAND TABLE: command-registry -->');
  const endMarker = '<!-- END GENERATED COMMAND TABLE: command-registry -->';
  const end = text.indexOf(endMarker, begin);
  assert.ok(begin >= 0 && end >= begin, 'generated command table markers must be present');
  return text.slice(begin, end + endMarker.length);
}

test('正式命令目录字节级等于注册表生成结果', () => {
  assert.equal(replaceGeneratedBlock(guide), guide);
  assert.equal(generatedBlock(guide), renderCommandDirectory());
});

test('正式命令目录与注册表 commandId 双向覆盖且无重复', () => {
  const block = generatedBlock(guide);
  const tableIds = [...block.matchAll(/^\| ([a-z][a-z0-9-]+) \|/gmu)].map((match) => match[1]);
  const registryIds = COMMAND_REGISTRY.map((entry) => entry.commandId);
  assert.deepEqual(new Set(tableIds), new Set(registryIds));
  assert.equal(tableIds.length, registryIds.length);
  assert.equal(new Set(tableIds).size, tableIds.length);
});

test('能力详单行为文档覆盖注册表每个 commandId 且恰好一次', async () => {
  const { capabilitiesCoverageErrors } = await import('./behavior-coverage.mjs');
  assert.deepEqual(await capabilitiesCoverageErrors(), []);
});
