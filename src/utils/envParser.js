import fs from 'fs';

/**
 * Parse .env file content into an object
 * Supports multiline strings (wrapped in double or single quotes)
 */
export function parseEnvFile(filePath) {
  const envData = {};
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  let currentKey = null;
  let currentValue = '';
  let inMultiline = false;
  let quoteChar = null;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    if (inMultiline) {
      // Continue collecting multiline value
      currentValue += '\n' + line;
      // Check if it ends (ends with the closing quote)
      if (line.trimEnd().endsWith(quoteChar)) {
        // Remove trailing quote
        currentValue = currentValue.slice(0, -1);
        envData[currentKey] = currentValue;
        inMultiline = false;
        currentKey = null;
        currentValue = '';
        quoteChar = null;
      }
    } else {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;
      
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1);
      
      // Check if this is the start of a quoted multiline string
      const trimmedValue = value.trimStart();
      if ((trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) &&
          !trimmedValue.endsWith(trimmedValue[0])) {
        // Start of multiline string
        quoteChar = trimmedValue[0];
        currentKey = key;
        currentValue = trimmedValue.slice(1); // Remove leading quote
        inMultiline = true;
      } else {
        // Single-line value, strip surrounding quotes if present
        value = value.trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        envData[key] = value;
      }
    }
  }
  
  // Handle unclosed multiline string
  if (inMultiline && currentKey) {
    envData[currentKey] = currentValue;
  }
  
  return envData;
}

/**
 * Update key-value pairs in a .env file
 * Supports multiline strings (automatically wrapped in double quotes)
 */
export function updateEnvFile(filePath, updates) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  Object.entries(updates).forEach(([key, value]) => {
    // Wrap value in double quotes if it contains newlines
    let formattedValue = value;
    if (typeof value === 'string' && value.includes('\n')) {
      // Multiline string: wrap in double quotes
      formattedValue = `"${value}"`;
    }
    
    // Match the entire key-value pair (including possible multiline values)
    // 1. Try matching single-line format first
    const singleLineRegex = new RegExp(`^${key}=.*$`, 'm');
    // 2. Try matching multiline format (starts with quote, may span lines, ends with quote)
    const multiLineRegex = new RegExp(`^${key}=["']([\\s\\S]*?)["']$`, 'm');
    
    if (multiLineRegex.test(content)) {
      // Replace multiline format
      content = content.replace(multiLineRegex, `${key}=${formattedValue}`);
    } else if (singleLineRegex.test(content)) {
      // Replace single-line format
      content = content.replace(singleLineRegex, `${key}=${formattedValue}`);
    } else {
      // Key does not exist; append to end of file
      content += `\n${key}=${formattedValue}`;
    }
  });
  
  fs.writeFileSync(filePath, content, 'utf8');
}
