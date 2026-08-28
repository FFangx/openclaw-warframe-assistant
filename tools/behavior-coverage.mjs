#!/usr/bin/env node

// R5：能力详单行为文档覆盖合同。
//
// skill/references/capabilities.md 的每个行为章节标题紧上一行必须有一行
// `<!-- behavior-doc: <commandId>[, <commandId>…] -->` 机器可读标记，把该章节
// 映射到 skill/scripts/command-registry 中的命令；注册表里每个 commandId 必须
// 恰好映射一次。未知 commandId、重复映射、缺失映射与标记未紧跟章节标题都会
// 被本工具与 CI 拒绝。行为散文仍完全由 capabilities.md 手工维护，不复制到
// 帮助摘要或生成的命令目录。
//
// 本工具故意放在 tools/（与 generate-command-docs.mjs 同层），不进入 skill/
// 运行时部署。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { COMMAND_REGISTRY } from '../skill/scripts/command-registry.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
export const CAPABILITIES_PATH = path.join(toolDir, '..', 'skill', 'references', 'capabilities.md');

// A marker must occupy a line of its own and may list ids separated by a comma.
const MARKER_RE = /^[\t ]*<!--[\t ]*behavior-doc:[\t ]*([^>]*?)-->[\t ]*$/u;
const COMMAND_ID_RE = /^[a-z][a-z0-9-]+$/u;
// A marker block must be followed by the section heading it documents.
const HEADING_RE = /^(#{2,3})[\t ]+(.+?)[\t ]*$/u;

function parseMarkerIds(text, line, errors) {
  const ids = String(text ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!ids.length || ids.some((value) => !COMMAND_ID_RE.test(value))) {
    errors.push(`malformed behavior-doc marker at line ${line}`);
    return [];
  }
  return ids;
}

// Parse a capabilities.md-style document into commandId -> section mappings.
// Returns { mappings, errors }; mappings entries carry commandId, sectionTitle,
// line (marker line) and sectionLine (heading line).
export function parseBehaviorMarkers(document) {
  const lines = String(document ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const mappings = [];
  const errors = [];
  let index = 0;
  while (index < lines.length) {
    if (!MARKER_RE.test(lines[index])) {
      index += 1;
      continue;
    }
    const blockStart = index;
    while (index < lines.length && MARKER_RE.test(lines[index])) index += 1;
    const heading = index < lines.length ? HEADING_RE.exec(lines[index]) : null;
    if (!heading) {
      errors.push(`behavior-doc marker at line ${blockStart + 1} must be immediately followed by a "##" or "###" section heading`);
      continue;
    }
    const sectionTitle = String(heading[2]).trim();
    const sectionLine = index + 1;
    for (let marker = blockStart; marker < index; marker += 1) {
      const ids = parseMarkerIds(MARKER_RE.exec(lines[marker])?.[1], marker + 1, errors);
      for (const commandId of ids) mappings.push({ commandId, sectionTitle, line: marker + 1, sectionLine });
    }
    index += 1;
  }
  return { mappings, errors };
}

// Contract check against a commandId list. Returns a list of error strings
// (empty when the contract holds): unknown ids, duplicate mappings and
// registered commands without any mapping all fail.
export function behaviorCoverageErrors({ document, commandIds }) {
  const registryIds = new Set(commandIds || []);
  const { mappings, errors } = parseBehaviorMarkers(document);
  const counts = new Map();
  for (const mapping of mappings) counts.set(mapping.commandId, (counts.get(mapping.commandId) || 0) + 1);
  for (const [commandId, count] of counts) {
    if (!registryIds.has(commandId)) errors.push(`unknown commandId in behavior-doc marker: ${commandId}`);
    if (count > 1) errors.push(`duplicate behavior-doc mapping for commandId: ${commandId} (${count} markers)`);
  }
  for (const commandId of commandIds || []) {
    if (!counts.has(commandId)) errors.push(`missing behavior-doc mapping for commandId: ${commandId}`);
  }
  return errors;
}

// File-level check used by tests, verify.ps1 and CI.
export async function capabilitiesCoverageErrors() {
  const document = await readFile(CAPABILITIES_PATH, 'utf8');
  return behaviorCoverageErrors({
    document,
    commandIds: COMMAND_REGISTRY.map((entry) => entry.commandId),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = await capabilitiesCoverageErrors();
  if (errors.length) {
    process.stderr.write(`skill/references/capabilities.md behavior-doc coverage failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}
