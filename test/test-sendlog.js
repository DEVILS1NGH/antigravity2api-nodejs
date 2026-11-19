import tokenManager from '../src/auth/token_manager.js';
import { sendLog } from '../src/api/client.js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

async function testSendLog() {
  try {
    // Get token
    const token = await tokenManager.getToken();
    if (!token) {
      console.error('No available token');
      return;
    }
    console.log('Successfully obtained token');

    // Read data.bin file
    const buffer = readFileSync('data-reserialized.bin');
    console.log(`Successfully read data.bin, size: ${buffer.length} bytes`);

    // Generate random parameters
    const num = Math.floor(Math.random() * 100);
    const trajectoryId = randomUUID();

    // Call sendLog
    await sendLog(token, num, trajectoryId, buffer);
    console.log('sendLog call succeeded');
  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testSendLog();
