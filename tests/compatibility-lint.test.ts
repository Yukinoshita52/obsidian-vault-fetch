import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

it('rejects an unguarded newer API and accepts the explicit version guard', async () => {
  const eslint = new ESLint({ cwd: process.cwd() });
  const source = (guard: string) => `import {PluginSettingTab,requireApiVersion} from 'obsidian';
    export class Probe extends PluginSettingTab { display():void { ${guard} this.update(); } }`;
  const options = { filePath: 'src/ui/settings-tab.ts' };
  const unguarded = await eslint.lintText(source(''), options);
  expect(unguarded.flatMap(result => result.messages).some(message => message.ruleId === 'obsidianmd/no-unsupported-api')).toBe(true);
  const guarded = await eslint.lintText(source("if (requireApiVersion('1.13.0'))"), options);
  expect(guarded.flatMap(result => result.messages)).toEqual([]);
}, 20_000);
