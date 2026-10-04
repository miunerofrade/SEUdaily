import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSlashCommands, slashCommandHint, slashCommands } from '../apps/web/src/slash-commands.ts';

test('slash menu matches command prefixes and stops matching completed arguments', () => {
  assert.equal(matchSlashCommands('/').length, slashCommands.length);
  assert.ok(matchSlashCommands('/VP').every(item => item.command.startsWith('/vpn')));
  assert.deepEqual(matchSlashCommands('/vpn dis').map(item => item.command), ['/vpn disconnect']);
  assert.deepEqual(matchSlashCommands('/vpn   con').map(item => item.command), ['/vpn connect']);
  assert.equal(matchSlashCommands('/vpn connect 12081').length, 0);
  assert.equal(matchSlashCommands('/ramdisk 768M').length, 0);
  assert.equal(matchSlashCommands('解释 /vpn').length, 0);
  assert.equal(matchSlashCommands('/vpn\n解释').length, 0);
});

test('command hints require a complete command name and distinguish unknown slash prompts', () => {
  assert.match(slashCommandHint('/vpn status'), /VPN 命令/);
  assert.match(slashCommandHint('/ramdisk 768M'), /内存盘命令/);
  assert.match(slashCommandHint('/vpnother'), /普通消息/);
  assert.equal(slashCommandHint('普通消息'), '');
});
