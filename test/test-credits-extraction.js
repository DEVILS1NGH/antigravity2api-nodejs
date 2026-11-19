/**
 * Test credits information extraction
 * Verifies extracting and saving credits info from the loadCodeAssist endpoint
 */

// Mock loadCodeAssist API response data
const mockLoadCodeAssistResponse = {
  currentTier: {
    id: 'g1-pro-tier'
  },
  cloudaicompanionProject: 'test-project-123',
  paidTier: {
    availableCredits: [
      {
        creditAmount: '150.50'
      }
    ]
  }
};

// Mock free-tier response (no credits info)
const mockFreeTierResponse = {
  currentTier: {
    id: 'free-tier'
  },
  cloudaicompanionProject: 'test-project-456'
};

// Mock unactivated account response
const mockUnactivatedResponse = {
  allowedTiers: [
    {
      id: 'LEGACY',
      isDefault: true
    }
  ]
};

/**
 * Test credits extraction logic
 */
function testCreditsExtraction() {
  console.log('=== Testing Credits Info Extraction ===\n');

  // Test 1: Pro account with credits
  console.log('Test 1: Pro account with credits');
  const data1 = mockLoadCodeAssistResponse;
  const sub1 = data1.currentTier.id;
  let credits1 = null;
  
  if (sub1 !== 'free-tier' && data1?.paidTier?.availableCredits?.[0]?.creditAmount) {
    try {
      credits1 = parseFloat(data1.paidTier.availableCredits[0].creditAmount);
      console.log(`✓ Extracted credits: ${credits1}`);
      console.log(`✓ Subscription tier: ${sub1}`);
    } catch (err) {
      console.log(`✗ Parse failed: ${err.message}`);
    }
  } else {
    console.log(`- No credits info (sub=${sub1})`);
  }
  console.log('');

  // Test 2: Free-tier account without credits
  console.log('Test 2: Free-tier account without credits');
  const data2 = mockFreeTierResponse;
  const sub2 = data2.currentTier.id;
  let credits2 = null;
  
  if (sub2 !== 'free-tier' && data2?.paidTier?.availableCredits?.[0]?.creditAmount) {
    try {
      credits2 = parseFloat(data2.paidTier.availableCredits[0].creditAmount);
      console.log(`✓ Extracted credits: ${credits2}`);
    } catch (err) {
      console.log(`✗ Parse failed: ${err.message}`);
    }
  } else {
    console.log(`✓ Correctly skipped (sub=${sub2}, credits=null)`);
  }
  console.log('');

  // Test 3: Unactivated account
  console.log('Test 3: Unactivated account');
  const data3 = mockUnactivatedResponse;
  if (!data3.currentTier) {
    console.log(`✓ Correctly identified as unactivated account`);
  }
  console.log('');

  // Test 4: Edge cases - string to float conversion
  console.log('Test 4: String to float conversion');
  const testValues = ['150.50', '100', '0.99', '1000.123456'];
  testValues.forEach(value => {
    const parsed = parseFloat(value);
    console.log(`  "${value}" -> ${parsed}`);
  });
  console.log('');

  console.log('=== All Tests Completed ===');
}

// Run tests
testCreditsExtraction();