const { createLocalDb } = require('./local-db');
const db = createLocalDb();

const showSecrets = process.argv.includes('--show-secrets');

function maskSecret(value) {
  if (!value || value === 'none') return value;
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function main() {
  const accounts = db.listAccounts();

  const output = accounts.map((account) => ({
    ...account,
    refreshToken: showSecrets ? account.refreshToken : maskSecret(account.refreshToken),
  }));

  console.log('ACCOUNTS IN DB:');
  if (!showSecrets) {
    console.log('(refreshToken is masked; pass --show-secrets only on a private terminal if you truly need it)');
  }
  console.log(JSON.stringify(output, null, 2));
}

main().finally(() => {
  db.close();
});
