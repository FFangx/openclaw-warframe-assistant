#!/usr/bin/env node

// Generate the repository's formal command directory from the runtime registry.
// This tool intentionally lives outside skill/ so it is never a runtime dependency.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMAND_REGISTRY, COMMAND_REGISTRY_SCHEMA_VERSION, HELP_SECTION_REGISTRY, registryContractErrors } from '../skill/scripts/command-registry.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, '..');
const outputPath = path.join(repoRoot, 'docs', 'COMMANDS.md');
const BEGIN = '<!-- BEGIN GENERATED COMMAND TABLE: command-registry -->';
const END = '<!-- END GENERATED COMMAND TABLE: command-registry -->';

function markdown(value) {
  return String(value ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/`/gu, '\\`')
    .replace(/\r?\n/gu, '<br>');
}

function sectionById() {
  return new Map(HELP_SECTION_REGISTRY.map((section) => [section.id, section]));
}

export function renderCommandDirectory() {
  const errors = registryContractErrors();
  if (errors.length) throw new Error(`command registry contract failed:\n${errors.join('\n')}`);
  const sections = sectionById();
  const rows = [...COMMAND_REGISTRY]
    .sort((left, right) => {
      const sectionOrder = (sections.get(left.helpSectionId)?.order || 0) - (sections.get(right.helpSectionId)?.order || 0);
      return sectionOrder || left.commandId.localeCompare(right.commandId);
    })
    .map((entry) => {
      const section = sections.get(entry.helpSectionId);
      const aliases = entry.aliases.length ? entry.aliases.join('、') : '—';
      const privacy = entry.privacyScope === 'userPrivate' ? '用户本人私聊' : entry.privacyScope === 'session' ? '当前会话' : '公开';
      return `| ${markdown(entry.commandId)} | ${markdown(section.title)} | ${markdown(`帮助 ${section.helpQuery}`)} | ${markdown(entry.canonicalSyntax)} | ${markdown(aliases)} | ${markdown(entry.helpSummary)} | ${markdown(privacy)} |`;
    });
  return [
    BEGIN,
    `<!-- command-registry-schema: ${markdown(COMMAND_REGISTRY_SCHEMA_VERSION)} -->`,
    '| commandId | 模块 | 帮助入口 | 正式语法 | 常用别名 | 用途 | 权限 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    END,
  ].join('\n');
}

export function replaceGeneratedBlock(document, generated = renderCommandDirectory()) {
  const beginIndex = document.indexOf(BEGIN);
  const endIndex = document.indexOf(END);
  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
    throw new Error('docs/COMMANDS.md generated markers are missing or out of order');
  }
  const end = endIndex + END.length;
  return `${document.slice(0, beginIndex)}${generated}${document.slice(end)}`;
}

function canonicalDocument(document) {
  return `${document.replace(/\r\n/gu, '\n').replace(/\n*$/u, '')}\n`;
}

async function main(argv) {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : null;
  if (!mode || (argv.includes('--write') && argv.includes('--check'))) {
    throw new Error('usage: node tools/generate-command-docs.mjs --write|--check');
  }
  const current = await readFile(outputPath, 'utf8');
  const generated = renderCommandDirectory();
  const expected = canonicalDocument(replaceGeneratedBlock(current, generated));
  if (mode === 'write') {
    if (expected !== current) await writeFile(outputPath, expected, 'utf8');
    return;
  }
  if (expected !== current) throw new Error('docs/COMMANDS.md is stale; run --write');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
