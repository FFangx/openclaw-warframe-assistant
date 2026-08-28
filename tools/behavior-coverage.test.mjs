import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { COMMAND_REGISTRY } from '../skill/scripts/command-registry.mjs';
import { behaviorCoverageErrors, capabilitiesCoverageErrors, parseBehaviorMarkers } from './behavior-coverage.mjs';

const capabilitiesUrl = new URL('../skill/references/capabilities.md', import.meta.url);
const registryCommandIds = COMMAND_REGISTRY.map((entry) => entry.commandId);

function documentWith(...sections) {
  return `# 能力详单\n\n${sections.join('\n\n')}\n`;
}

test('能力详单覆盖注册表全部 commandId 且恰好一次（无未知、无重复、无缺失）', async () => {
  const document = await readFile(capabilitiesUrl, 'utf8');
  assert.deepEqual(behaviorCoverageErrors({ document, commandIds: registryCommandIds }), []);
});

test('能力详单文件级检查通过（capabilitiesCoverageErrors 返回空）', async () => {
  assert.deepEqual(await capabilitiesCoverageErrors(), []);
});

test('行为标记数量恰等于注册表命令数且每枚只映射一个章节', async () => {
  const document = await readFile(capabilitiesUrl, 'utf8');
  const { mappings, errors } = parseBehaviorMarkers(document);
  assert.deepEqual(errors, []);
  assert.equal(mappings.length, registryCommandIds.length);
  assert.equal(new Set(mappings.map((mapping) => mapping.commandId)).size, mappings.length);
});

test('章节归属与行为章节标题一致（抽查典型命令）', async () => {
  const document = await readFile(capabilitiesUrl, 'utf8');
  const byId = new Map(parseBehaviorMarkers(document).mappings.map((mapping) => [mapping.commandId, mapping]));
  assert.equal(byId.get('market')?.sectionTitle, 'wm 查价');
  assert.equal(byId.get('relic-farm')?.sectionTitle, '遗物');
  assert.equal(byId.get('trader')?.sectionTitle, '裂缝 / 世界状态');
  assert.equal(byId.get('subscription')?.sectionTitle, '订阅（十四类）');
  assert.equal(byId.get('wishlist')?.sectionTitle, '愿望单（Warframe.Market 公共市场只读）');
});

test('负例：注册表新增命令未写行为文档映射时被拒绝', () => {
  const document = documentWith(
    '<!-- behavior-doc: market -->\n### 查价\n正文。',
    '<!-- behavior-doc: weekly -->\n### 周常\n正文。',
  );
  const errors = behaviorCoverageErrors({ document, commandIds: ['market', 'weekly', 'new-command'] });
  assert.ok(errors.some((error) => error.includes('new-command') && error.includes('missing')));
  assert.ok(errors.every((error) => !error.includes('market') && !error.includes('weekly')));
});

test('负例：同一 commandId 跨章节重复映射被拒绝', () => {
  const document = documentWith(
    '<!-- behavior-doc: market -->\n### 查价\n正文。',
    '<!-- behavior-doc: market -->\n### 另一章\n正文。',
  );
  const errors = behaviorCoverageErrors({ document, commandIds: ['market'] });
  assert.ok(errors.some((error) => error.includes('market') && error.includes('duplicate')));
});

test('负例：同一标记内重复 commandId 被拒绝', () => {
  const document = documentWith('<!-- behavior-doc: market, market -->\n### 查价\n正文。');
  const errors = behaviorCoverageErrors({ document, commandIds: ['market'] });
  assert.ok(errors.some((error) => error.includes('market') && error.includes('duplicate')));
});

test('负例：未知 commandId 出现在文档映射中被拒绝', () => {
  const document = documentWith('<!-- behavior-doc: market, not-a-command -->\n### 查价\n正文。');
  const errors = behaviorCoverageErrors({ document, commandIds: ['market'] });
  assert.ok(errors.some((error) => error.includes('not-a-command') && error.includes('unknown')));
  assert.ok(errors.every((error) => !error.includes('missing')));
});

test('负例：标记未紧跟章节标题（写在标题之后或孤悬）被拒绝', () => {
  const afterHeading = documentWith('### 查价\n<!-- behavior-doc: market -->\n正文。');
  assert.ok(behaviorCoverageErrors({ document: afterHeading, commandIds: ['market'] })
    .some((error) => /line 4/u.test(error) && error.includes('immediately followed')));
  const orphan = documentWith('<!-- behavior-doc: market -->');
  assert.ok(behaviorCoverageErrors({ document: orphan, commandIds: ['market'] })
    .some((error) => /line 3/u.test(error) && error.includes('immediately followed')));
});

test('负例：格式错误的标记（空列表或非法 id）被拒绝', () => {
  const empty = documentWith('<!-- behavior-doc: -->\n### 查价\n正文。');
  assert.ok(behaviorCoverageErrors({ document: empty, commandIds: ['market'] })
    .some((error) => error.includes('malformed')));
  const badIds = documentWith('<!-- behavior-doc: 1bad, market -->\n### 查价\n正文。');
  assert.ok(behaviorCoverageErrors({ document: badIds, commandIds: ['market'] })
    .some((error) => error.includes('malformed') && error.includes('line')));
});

test('负例：真实注册表下故意制造的文档被拒绝（回归双保险）', async () => {
  const document = await readFile(capabilitiesUrl, 'utf8');
  const missing = behaviorCoverageErrors({ document: `${document}\n<!-- behavior-doc: market -->\n### 附加章节\n`, commandIds: registryCommandIds });
  assert.ok(missing.some((error) => error.includes('market') && error.includes('duplicate')));
});
