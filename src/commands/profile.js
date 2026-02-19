/**
 * snbatch profile — manage instance connections
 */
import { Command } from 'commander';
import inquirer from 'inquirer';
import { listProfiles, addProfile, removeProfile, setActiveProfile } from '../utils/profiles.js';
import { printTable, printSuccess, printError, printInfo } from '../utils/display.js';

export function profileCommand() {
  const cmd = new Command('profile').description('Manage instance connections');

  cmd
    .command('add <name>')
    .description('Add or update a profile')
    .option('--instance <url>', 'Instance URL')
    .option('--username <user>', 'Username')
    .option('--password <pass>', 'Password (prefer interactive prompt)')
    .action(async (name, opts) => {
      try {
        let { instance, username, password } = opts;

        const questions = [];
        if (!instance) questions.push({ type: 'input', name: 'instance', message: 'Instance URL:', validate: (v) => v ? true : 'Required' });
        if (!username) questions.push({ type: 'input', name: 'username', message: 'Username:', validate: (v) => v ? true : 'Required' });
        if (!password) questions.push({ type: 'password', name: 'password', message: 'Password:', mask: '*', validate: (v) => v ? true : 'Required' });

        if (questions.length) {
          const answers = await inquirer.prompt(questions);
          instance = instance ?? answers.instance;
          username = username ?? answers.username;
          password = password ?? answers.password;
        }

        await addProfile(name, { url: instance, username, password });
        printSuccess(`Profile '${name}' saved.`);
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });

  cmd
    .command('list')
    .description('List all profiles')
    .action(async () => {
      try {
        const profiles = await listProfiles();
        if (!profiles.length) { printInfo('No profiles configured. Run: snbatch profile add <name>'); return; }
        printTable(
          ['Name', 'Instance URL', 'Active'],
          profiles.map((p) => [p.name, p.url, p.active ? '✓' : ''])
        );
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });

  cmd
    .command('switch <name>')
    .description('Set the active profile')
    .action(async (name) => {
      try {
        await setActiveProfile(name);
        printSuccess(`Switched to profile '${name}'.`);
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });

  cmd
    .command('remove <name>')
    .description('Remove a profile')
    .action(async (name) => {
      try {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Remove profile '${name}'?`,
          default: false,
        }]);
        if (!confirm) { printInfo('Aborted.'); return; }
        await removeProfile(name);
        printSuccess(`Profile '${name}' removed.`);
      } catch (err) {
        printError(err.message);
        process.exit(2);
      }
    });

  return cmd;
}
