#!/usr/bin/env node
/**
 * Monitor 429 error rate in Antigravity Pool database logs
 * Run: node scripts/monitor-429.js [thresholdPercent]
 */

const { createLocalDb } = require('./local-db');
const db = createLocalDb();

const THRESHOLD_PERCENT = Number(process.argv[2] || 5);

async function main() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  console.log(`📊 Monitoring request logs since ${oneHourAgo.toISOString()}...`);

  try {
    const logs = db.requestLogsSince(oneHourAgo);

    const totalRequests = logs.length;
    if (totalRequests === 0) {
      console.log('✅ No requests recorded in the last 1 hour. Nothing to alert.');
      process.exit(0);
    }

    const total429 = logs.filter((l) => l.statusCode === 429).length;
    const totalErrors = logs.filter((l) => l.statusCode >= 400).length;
    const errorRate = (totalErrors / totalRequests) * 100;
    const errorRate429 = (total429 / totalRequests) * 100;

    console.log(`📈 Stats:`);
    console.log(`   - Total Requests: ${totalRequests}`);
    console.log(`   - 429 Errors: ${total429} (${errorRate429.toFixed(1)}%)`);
    console.log(`   - Total Errors: ${totalErrors} (${errorRate.toFixed(1)}%)`);

    if (errorRate429 > THRESHOLD_PERCENT) {
      console.error(
        `\n⚠️  ALERT: 429 error rate is ${errorRate429.toFixed(1)}%, exceeding the threshold of ${THRESHOLD_PERCENT}%!`
      );
      process.exit(1);
    }

    console.log('\n✅ System health is within limits.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to monitor database request logs:', error);
    process.exit(2);
  } finally {
    db.close();
  }
}

main();
