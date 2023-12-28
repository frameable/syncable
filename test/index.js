const { SUITE, TEST } = process.env;

process.env.IS_TEST_RUN = true;

let suites = [];
module.exports = (name, fn) => suites.push({ name, fn });

require('./syncable');
require('./client');
require('./rater');

void async function main() {
  for (const suite of suites) {
    if (SUITE && SUITE != suite.name) continue;
    await suite.fn(async (desc, fn) => {
      if (TEST && TEST != desc) return;
      try {
        await fn();
        console.log("\x1b[32m✓\x1b[39m", `[${suite.name}]`, desc);
      } catch(e) {
        console.log(`\x1b[31m✗\x1b[39m`, `[${suite.name}]`, desc);
        console.error(e);
      }
    })
  }
  process.exit();
}();
