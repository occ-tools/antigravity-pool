const { spawnSync } = require('node:child_process');
const path = require('node:path');

process.env.DATABASE_URL ||= 'file:./dev.db';

const command = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
);

const result = spawnSync(command, ['validate'], {
  env: process.env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
