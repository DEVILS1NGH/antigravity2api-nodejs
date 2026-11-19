/**
 * Token rotation polling test script
 * Tests three rotation strategies: round_robin, quota_exhausted, request_count
 */

import path from 'path';
import { fileURLToPath } from 'url';
import TokenStore from '../src/auth/token_store.js';
import TokenPool from '../src/auth/token_pool.js';
import { StrategyFactory } from '../src/auth/token_rotation_strategy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use mock file path
const mockAccountsPath = path.join(__dirname, 'mock-accounts.json');

// Test result counters
let passed = 0;
let failed = 0;

// Helper: print test result
function printResult(testName, success, message = '') {
  if (success) {
    console.log(`✅ ${testName}`);
    passed++;
  } else {
    console.log(`❌ ${testName}${message ? ': ' + message : ''}`);
    failed++;
  }
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('\n=== Token Rotation Polling Tests ===\n');

async function testRoundRobinStrategy() {
  console.log('📋 Test 1: Round Robin Strategy');
  console.log('Expected: Rotate through each available token in sequence\n');
  
  try {
    // Initialize
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');
    
    // Load tokens
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);
    
    printResult('Load test data', enabledTokens.length === 3, `Loaded ${enabledTokens.length} enabled tokens`);
    
    // Add to pool
    for (const token of enabledTokens) {
      await pool.add(token);
    }
    
    // Get available tokens (in the format expected by rotation strategies)
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('Token pool initialization', availableTokens.length === 3);
    
    // Test rotation order
    const selectedTokens = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.selectToken(availableTokens);
      if (selected) {
        selectedTokens.push(selected.token.name);
        strategy.recordUsage(selected.tokenId);
      }
    }
    
    console.log(`  Rotation order: ${selectedTokens.join(' -> ')}`);
    
    // Verify rotation is cyclic
    const expectedPattern = ['Test Account 1', 'Test Account 2', 'Test Account 3', 'Test Account 1', 'Test Account 2', 'Test Account 3'];
    const isCorrectPattern = selectedTokens.every((name, idx) => name === expectedPattern[idx]);
    
    printResult('Round Robin rotation order', isCorrectPattern);
    
    // Test reset
    strategy.reset();
    const firstAfterReset = strategy.selectToken(availableTokens);
    printResult('Strategy reset', firstAfterReset.token.name === 'Test Account 1');
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

async function testQuotaExhaustedStrategy() {
  console.log('📋 Test 2: Quota Exhausted Strategy');
  console.log('Expected: Keep using the same token until manually switched\n');
  
  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('quota_exhausted');
    
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);
    
    for (const token of enabledTokens) {
      await pool.add(token);
    }
    
    // Get available tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    
    // Fetch token multiple times; should always return the same one
    const selectedTokens = [];
    for (let i = 0; i < 5; i++) {
      const selected = strategy.selectToken(availableTokens);
      selectedTokens.push(selected.token.name);
    }
    
    console.log(`  Usage order: ${selectedTokens.join(' -> ')}`);
    
    // Verify all are the same token
    const allSame = selectedTokens.every(name => name === selectedTokens[0]);
    printResult('Keep using the same token', allSame);
    
    // Manually switch to next
    strategy.switchToNext(availableTokens.length);
    const afterSwitch = strategy.selectToken(availableTokens);
    
    printResult('Manual token switch', afterSwitch.token.name === 'Test Account 2');
    
    // Manually switch a second time
    strategy.switchToNext(availableTokens.length);
    const afterSecondSwitch = strategy.selectToken(availableTokens);
    
    printResult('Second manual switch', afterSecondSwitch.token.name === 'Test Account 3');
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

async function testRequestCountStrategy() {
  console.log('📋 Test 3: Request Count Strategy');
  console.log('Expected: Automatically switch after each token handles a fixed number of requests\n');
  
  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const requestsPerToken = 3; // Each token handles 3 requests
    const strategy = StrategyFactory.create('request_count', { requestCountPerToken: requestsPerToken });
    
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);
    
    for (const token of enabledTokens) {
      await pool.add(token);
    }
    
    // Get available tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    
    // Simulate requests and record usage
    const selectedTokens = [];
    let currentTokenId = null;
    
    for (let i = 0; i < 9; i++) {
      const selected = strategy.selectToken(availableTokens);
      selectedTokens.push(selected.token.name);
      
      // Record usage
      const shouldSwitch = strategy.recordUsage(selected.tokenId);
      
      if (shouldSwitch) {
        console.log(`  Switch triggered after request #${i + 1} (${selected.token.name} reached ${requestsPerToken} requests)`);
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }
      
      currentTokenId = selected.tokenId;
    }
    
    console.log(`  Usage order: ${selectedTokens.join(' -> ')}`);
    
    // Verify switching pattern: switch token every 3 requests
    const expectedPattern = [
      'Test Account 1', 'Test Account 1', 'Test Account 1',
      'Test Account 2', 'Test Account 2', 'Test Account 2',
      'Test Account 3', 'Test Account 3', 'Test Account 3'
    ];
    
    const isCorrectPattern = selectedTokens.every((name, idx) => name === expectedPattern[idx]);
    printResult('Switch by request count', isCorrectPattern);
    
    // Test updating threshold
    strategy.setRequestCountPerToken(2);
    strategy.reset();
    
    const newPattern = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.selectToken(availableTokens);
      newPattern.push(selected.token.name);
      
      const shouldSwitch = strategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }
    }
    
    console.log(`  New threshold (2 requests) order: ${newPattern.join(' -> ')}`);
    
    const newExpected = [
      'Test Account 1', 'Test Account 1',
      'Test Account 2', 'Test Account 2',
      'Test Account 3', 'Test Account 3'
    ];
    
    const isNewPatternCorrect = newPattern.every((name, idx) => name === newExpected[idx]);
    printResult('Switch after updating threshold', isNewPatternCorrect);
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

async function testTokenPoolIntegration() {
  console.log('📋 Test 4: TokenPool Integration with Rotation Strategy');
  console.log('Expected: Verify disabled tokens are automatically skipped during rotation\n');
  
  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');
    
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);
    
    // Add all enabled tokens
    const tokenIds = [];
    for (const token of enabledTokens) {
      const tokenId = await pool.add(token);
      tokenIds.push(tokenId);
    }
    
    printResult('Initial token count', pool.size() === 3);
    
    // Disable one token
    pool.disable(tokenIds[1]); // Disable the second token
    
    // Get available tokens
    const enabledIdsAfterDisable = pool.getEnabledIds();
    const availableAfterDisable = enabledIdsAfterDisable.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('Available count after disabling token', availableAfterDisable.length === 2);
    
    // Test whether rotation skips the disabled token
    const selectedAfterDisable = [];
    for (let i = 0; i < 4; i++) {
      const selected = strategy.selectToken(availableAfterDisable);
      selectedAfterDisable.push(selected.token.name);
    }
    
    console.log(`  Rotation after disabling Account 2: ${selectedAfterDisable.join(' -> ')}`);
    
    // Verify disabled token was not selected
    const noDisabledToken = !selectedAfterDisable.includes('Test Account 2');
    printResult('Skip disabled token', noDisabledToken);
    
    // Re-enable
    pool.enable(tokenIds[1]);
    const enabledIdsAfterEnable = pool.getEnabledIds();
    const availableAfterEnable = enabledIdsAfterEnable.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('Re-enable token', availableAfterEnable.length === 3);
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

async function testStrategySwitch() {
  console.log('📋 Test 5: Dynamic Rotation Strategy Switching');
  console.log('Expected: Verify switching strategies at runtime\n');
  
  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);
    
    for (const token of enabledTokens) {
      await pool.add(token);
    }
    
    // Get available tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    
    // Test switching from round_robin to quota_exhausted
    let strategy = StrategyFactory.create('round_robin');
    
    const roundRobinResults = [];
    for (let i = 0; i < 3; i++) {
      const selected = strategy.selectToken(availableTokens);
      roundRobinResults.push(selected.token.name);
    }
    
    console.log(`  Round Robin: ${roundRobinResults.join(' -> ')}`);
    printResult('Round Robin mode', roundRobinResults.length === 3);
    
    // Switch strategy
    strategy = StrategyFactory.create('quota_exhausted');
    
    const quotaResults = [];
    for (let i = 0; i < 3; i++) {
      const selected = strategy.selectToken(availableTokens);
      quotaResults.push(selected.token.name);
    }
    
    console.log(`  Quota Exhausted: ${quotaResults.join(' -> ')}`);
    
    const allSame = quotaResults.every(name => name === quotaResults[0]);
    printResult('Switch to Quota Exhausted', allSame);
    
    // Switch to request_count
    strategy = StrategyFactory.create('request_count', { requestCountPerToken: 2 });
    
    const requestCountResults = [];
    for (let i = 0; i < 4; i++) {
      const selected = strategy.selectToken(availableTokens);
      requestCountResults.push(selected.token.name);
      
      const shouldSwitch = strategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }
    }
    
    console.log(`  Request Count: ${requestCountResults.join(' -> ')}`);
    printResult('Switch to Request Count', requestCountResults.length === 4);
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

async function testEdgeCases() {
  console.log('📋 Test 6: Edge Case Handling');
  console.log('Expected: Properly handle empty token pool, single token, etc.\n');
  
  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');
    
    // Test empty token pool
    const emptyResult = strategy.selectToken([]);
    printResult('Empty token pool returns null', emptyResult === null);
    
    // Test single token
    const singleToken = {
      tokenId: 'single_id',
      token: { name: 'Single Account', refresh_token: 'single_token' }
    };
    
    const singleResults = [];
    for (let i = 0; i < 3; i++) {
      const result = strategy.selectToken([singleToken]);
      singleResults.push(result.token.name);
    }
    
    const allSingle = singleResults.every(name => name === 'Single Account');
    printResult('Single token cycle', allSingle);
    
    // Test request_count strategy edge case
    const rcStrategy = StrategyFactory.create('request_count', { requestCountPerToken: 1 });
    
    const token1 = { tokenId: 'id1', token: { name: 'Token1', refresh_token: 't1' } };
    const token2 = { tokenId: 'id2', token: { name: 'Token2', refresh_token: 't2' } };
    
    const rcResults = [];
    for (let i = 0; i < 4; i++) {
      const selected = rcStrategy.selectToken([token1, token2]);
      rcResults.push(selected.token.name);
      
      const shouldSwitch = rcStrategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        rcStrategy.switchToNext(2, selected.tokenId);
      }
    }
    
    console.log(`  Switch at threshold=1: ${rcResults.join(' -> ')}`);
    
    const expectedRc = ['Token1', 'Token2', 'Token1', 'Token2'];
    const isRcCorrect = rcResults.every((name, idx) => name === expectedRc[idx]);
    printResult('Switch on every request when threshold=1', isRcCorrect);
    
    console.log();
  } catch (error) {
    console.error('Test failed:', error.message);
    failed++;
  }
}

// Run all tests
async function runAllTests() {
  try {
    await testRoundRobinStrategy();
    await testQuotaExhaustedStrategy();
    await testRequestCountStrategy();
    await testTokenPoolIntegration();
    await testStrategySwitch();
    await testEdgeCases();
    
    // Print summary
    console.log('\n=== Test Summary ===');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📊 Total: ${passed + failed}`);
    
    if (failed === 0) {
      console.log('\n🎉 All tests passed! Token rotation is working properly.\n');
    } else {
      console.log('\n⚠️  Some tests failed, please check the related functionality.\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Test execution error:', error);
    process.exit(1);
  }
}

// Execute tests
runAllTests();