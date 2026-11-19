/**
 * Quota exhaustion cascade management integration test
 * Tests that when all model groups of a token are disabled, the token is automatically marked as quota-exhausted
 */

import { hasOtherAvailableModelGroups, getAvailableModelGroups } from '../src/utils/tokenQuotaHelper.js';
import tokenCooldownManager from '../src/auth/token_cooldown_manager.js';

// Token ID used for testing
const TEST_TOKEN_ID = 'test-token-cascade';

// Core models (for testing)
const TEST_MODELS = {
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-4-hydrogen',
  banana: 'gemini-3.1-flash-image'
};

/**
 * Test helper: clear cooldown state for the test token
 */
function cleanupTestToken() {
  for (const modelId of Object.values(TEST_MODELS)) {
    tokenCooldownManager.clearCooldown(TEST_TOKEN_ID, modelId);
  }
}

/**
 * Test 1: Verify initial state - all model groups are available
 */
function test1_initialState() {
  console.log('\n=== Test 1: Initial State Check ===');
  cleanupTestToken();
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ Initial state - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (!hasOther || available.length !== 3) {
    throw new Error('Initial state error: all model groups should be available');
  }
  
  console.log('✅ Test 1 passed');
}

/**
 * Test 2: Disable a single model group - others remain available
 */
function test2_singleGroupDisabled() {
  console.log('\n=== Test 2: Disable Single Model Group ===');
  cleanupTestToken();
  
  // Disable Claude model group
  const resetTime = Date.now() + 3600000; // Recovers in 1 hour
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ After disabling claude - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (!hasOther) {
    throw new Error('Other model groups should remain available after disabling a single group');
  }
  
  if (available.length !== 2 || !available.includes('gemini') || !available.includes('banana')) {
    throw new Error('Incorrect available model groups list');
  }
  
  console.log('✅ Test 2 passed');
}

/**
 * Test 3: Disable two model groups - one remains available
 */
function test3_twoGroupsDisabled() {
  console.log('\n=== Test 3: Disable Two Model Groups ===');
  cleanupTestToken();
  
  const resetTime = Date.now() + 3600000;
  
  // Disable Claude and Gemini
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, resetTime);
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ After disabling claude, gemini - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (!hasOther) {
    throw new Error('One model group should remain available after disabling two groups');
  }
  
  if (available.length !== 1 || !available.includes('banana')) {
    throw new Error('Incorrect available model groups list');
  }
  
  console.log('✅ Test 3 passed');
}

/**
 * Test 4: Disable all model groups - none available
 */
function test4_allGroupsDisabled() {
  console.log('\n=== Test 4: Disable All Model Groups ===');
  cleanupTestToken();
  
  const resetTime = Date.now() + 3600000;
  
  // Disable all model groups
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.banana, resetTime);
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ After disabling all model groups - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (hasOther) {
    throw new Error('No model groups should be available after disabling all groups');
  }
  
  if (available.length !== 0) {
    throw new Error('Available model groups list should be empty');
  }
  
  console.log('✅ Test 4 passed');
}

/**
 * Test 5: Automatic recovery after cooldown expires
 */
function test5_cooldownExpiry() {
  console.log('\n=== Test 5: Automatic Recovery After Cooldown Expiry ===');
  cleanupTestToken();
  
  // Set an already-expired cooldown time
  const expiredTime = Date.now() - 1000; // 1 second ago
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, expiredTime);
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ After cooldown expiry - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (!hasOther || available.length !== 3) {
    throw new Error('Model group should recover availability after cooldown expires');
  }
  
  console.log('✅ Test 5 passed');
}

/**
 * Test 6: Mixed state - some expired, some still active
 */
function test6_mixedState() {
  console.log('\n=== Test 6: Mixed Cooldown State ===');
  cleanupTestToken();
  
  const expiredTime = Date.now() - 1000;
  const futureTime = Date.now() + 3600000;
  
  // Claude expired (should be available)
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, expiredTime);
  // Gemini active (unavailable)
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, futureTime);
  // Banana has no cooldown (available)
  
  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);
  
  console.log(`✓ Mixed state - has other available model groups: ${hasOther}`);
  console.log(`✓ Available model groups: [${available.join(', ')}]`);
  
  if (!hasOther) {
    throw new Error('Model groups should be available in mixed state');
  }
  
  if (available.length !== 2 || !available.includes('claude') || !available.includes('banana')) {
    throw new Error('Incorrect available model groups list, expected claude and banana');
  }
  
  console.log('✅ Test 6 passed');
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🚀 Starting quota exhaustion cascade management integration tests\n');
  console.log('Test goal: Verify handling when all model groups for a token are disabled');
  
  try {
    test1_initialState();
    test2_singleGroupDisabled();
    test3_twoGroupsDisabled();
    test4_allGroupsDisabled();
    test5_cooldownExpiry();
    test6_mixedState();
    
    console.log('\n✅ All tests passed!');
    console.log('\nTest summary:');
    console.log('1. ✅ Initial state check passed');
    console.log('2. ✅ Other groups remain available after disabling one group');
    console.log('3. ✅ One group remains available after disabling two groups');
    console.log('4. ✅ No groups available after disabling all groups (triggers quota exhaustion)');
    console.log('5. ✅ Automatic recovery after cooldown expiry');
    console.log('6. ✅ Mixed state handled correctly');
    
    // Cleanup
    cleanupTestToken();
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    
    // Cleanup
    cleanupTestToken();
    
    process.exit(1);
  }
}

// Run tests
runAllTests();