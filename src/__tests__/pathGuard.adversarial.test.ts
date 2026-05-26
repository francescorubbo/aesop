import { describe, it, expect } from 'vitest';
import { checkBashCommandSafe } from '../pathGuard';

describe('pathGuard adversarial tests', () => {
  const workspace = '/workspace/sandbox';

  const BLOCKED = [
    'cd "/home/user/secret dir"',
    'echo x > $HOME/exfil',
    'cat /etc/passwd > /tmp/out',
    'bash -c "cd /; ls"',
    'cat <<EOF > /etc/hosts\n127.0.0.1 evil\nEOF',
    'cd ~/secrets',
    'ls ${HOME}',
    'echo "hello" > $PWD/outside',
  ];

  for (const cmd of BLOCKED) {
    it(`blocks: ${cmd}`, () => {
      const r = checkBashCommandSafe(cmd, workspace);
      expect(r.allowed).toBe(false);
    });
  }

  const ALLOWED = [
    'ls .',
    'cd src',
    'echo "hello" > output.txt',
    'cat main.ts',
    'grep "foo" src/main.ts',
  ];

  for (const cmd of ALLOWED) {
    it(`allows: ${cmd}`, () => {
      const r = checkBashCommandSafe(cmd, workspace);
      expect(r.allowed).toBe(true);
    });
  }
});
