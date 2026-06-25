/**
 * Minimal async test runner. Replaces the previously-referenced-but-missing
 * TestRunner/Assert so `npm test` works again.
 */
class Assert {
  async assertTrue(cond, msg) {
    if (!cond) throw new Error(`assertTrue failed: ${msg}`);
  }
  async assertEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(`assertEqual failed: ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
  async assertThrows(fn, msg) {
    let threw = false;
    try { await fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(`assertThrows failed: ${msg}`);
  }
}

class TestRunner {
  constructor() { this.tests = []; }
  test(name, fn) { this.tests.push({ name, fn }); }
  async run() {
    const assert = new Assert();
    let passed = 0, failed = 0;
    for (const t of this.tests) {
      try {
        await t.fn(assert);
        console.log(`  ✓ ${t.name}`);
        passed++;
      } catch (e) {
        console.error(`  ✗ ${t.name}\n      ${e.message}`);
        failed++;
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    return failed === 0;
  }
}

module.exports = { TestRunner, Assert };
