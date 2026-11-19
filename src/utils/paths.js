/**
 * Path utility module
 * Unified path resolution for both pkg-packaged and development environments
 * @module utils/paths
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Detect whether running in a pkg-packaged environment
 * @type {boolean}
 */
export const isPkg = typeof process.pkg !== 'undefined';

/**
 * Get project root directory
 * @returns {string} Project root directory path
 */
export function getProjectRoot() {
  if (isPkg) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, '../..');
}

/**
 * Get data directory path
 * Uses the executable directory or current working directory in pkg environments
 * @returns {string} Data directory path
 */
export function getDataDir() {
  if (isPkg) {
    // pkg environment: prefer the data directory next to the executable
    const exeDir = path.dirname(process.execPath);
    const exeDataDir = path.join(exeDir, 'data');
    // Check if files can be created in this directory
    try {
      if (!fs.existsSync(exeDataDir)) {
        fs.mkdirSync(exeDataDir, { recursive: true });
      }
      return exeDataDir;
    } catch (e) {
      // If creation fails, fall back to the current working directory
      const cwdDataDir = path.join(process.cwd(), 'data');
      try {
        if (!fs.existsSync(cwdDataDir)) {
          fs.mkdirSync(cwdDataDir, { recursive: true });
        }
        return cwdDataDir;
      } catch (e2) {
        // Finally fall back to the user home directory
        const homeDataDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.antigravity', 'data');
        if (!fs.existsSync(homeDataDir)) {
          fs.mkdirSync(homeDataDir, { recursive: true });
        }
        return homeDataDir;
      }
    }
  }
  // Development environment
  return path.join(__dirname, '..', '..', 'data');
}

/**
 * Get public static files directory
 * @returns {string} Public directory path
 */
export function getPublicDir() {
  if (isPkg) {
    // pkg environment: prefer the public directory next to the executable
    const exeDir = path.dirname(process.execPath);
    const exePublicDir = path.join(exeDir, 'public');
    if (fs.existsSync(exePublicDir)) {
      return exePublicDir;
    }
    // Next, check the public directory in the current working directory
    const cwdPublicDir = path.join(process.cwd(), 'public');
    if (fs.existsSync(cwdPublicDir)) {
      return cwdPublicDir;
    }
    // Finally, use the bundled public directory (via snapshot)
    return path.join(__dirname, '../../public');
  }
  // Development environment
  return path.join(__dirname, '../../public');
}

/**
 * Get image storage directory
 * @returns {string} Image directory path
 */
export function getImageDir() {
  if (isPkg) {
    // pkg environment: prefer public/images next to the executable
    const exeDir = path.dirname(process.execPath);
    const exeImageDir = path.join(exeDir, 'public', 'images');
    try {
      if (!fs.existsSync(exeImageDir)) {
        fs.mkdirSync(exeImageDir, { recursive: true });
      }
      return exeImageDir;
    } catch (e) {
      // If creation fails, fall back to the current working directory
      const cwdImageDir = path.join(process.cwd(), 'public', 'images');
      try {
        if (!fs.existsSync(cwdImageDir)) {
          fs.mkdirSync(cwdImageDir, { recursive: true });
        }
        return cwdImageDir;
      } catch (e2) {
        // Finally fall back to the user home directory
        const homeImageDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.antigravity', 'images');
        if (!fs.existsSync(homeImageDir)) {
          fs.mkdirSync(homeImageDir, { recursive: true });
        }
        return homeImageDir;
      }
    }
  }
  // Development environment
  return path.join(__dirname, '../../public/images');
}

/**
 * Get .env file path
 * @returns {string} .env file path
 */
export function getEnvPath() {
  if (isPkg) {
    // pkg environment: prefer .env next to the executable
    const exeDir = path.dirname(process.execPath);
    const exeEnvPath = path.join(exeDir, '.env');
    if (fs.existsSync(exeEnvPath)) {
      return exeEnvPath;
    }
    // Next, check .env in the current working directory
    const cwdEnvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(cwdEnvPath)) {
      return cwdEnvPath;
    }
    // Return the executable directory path (even if it does not exist)
    return exeEnvPath;
  }
  // Development environment
  return path.join(__dirname, '../../.env');
}

/**
 * Get configuration file paths
 * @returns {{envPath: string, configJsonPath: string, configJsonExamplePath: string, examplePath: string, upstreamJsonPath: string}} Configuration file paths
 */
export function getConfigPaths() {
  if (isPkg) {
    // pkg environment: prefer configuration files next to the executable
    const exeDir = path.dirname(process.execPath);
    const cwdDir = process.cwd();

    // Locate .env file
    let envPath = path.join(exeDir, '.env');
    if (!fs.existsSync(envPath)) {
      const cwdEnvPath = path.join(cwdDir, '.env');
      if (fs.existsSync(cwdEnvPath)) {
        envPath = cwdEnvPath;
      }
    }

    // Locate config.json file
    let configJsonPath = path.join(exeDir, 'config.json');
    if (!fs.existsSync(configJsonPath)) {
      const cwdConfigPath = path.join(cwdDir, 'config.json');
      if (fs.existsSync(cwdConfigPath)) {
        configJsonPath = cwdConfigPath;
      }
    }

    // Locate config.json.example file
    let configJsonExamplePath = path.join(exeDir, 'config.json.example');
    if (!fs.existsSync(configJsonExamplePath)) {
      const cwdExamplePath = path.join(cwdDir, 'config.json.example');
      if (fs.existsSync(cwdExamplePath)) {
        configJsonExamplePath = cwdExamplePath;
      }
    }

    // Locate .env.example file
    let examplePath = path.join(exeDir, '.env.example');
    if (!fs.existsSync(examplePath)) {
      const cwdExamplePath = path.join(cwdDir, '.env.example');
      if (fs.existsSync(cwdExamplePath)) {
        examplePath = cwdExamplePath;
      }
    }

    // Locate upstream.json file (upstream protocol config, tracked by git)
    // pkg environment: prefer src/config/upstream.json next to executable, then cwd, then inside snapshot
    let upstreamJsonPath = path.join(exeDir, 'src', 'config', 'upstream.json');
    if (!fs.existsSync(upstreamJsonPath)) {
      const cwdUpstreamPath = path.join(cwdDir, 'src', 'config', 'upstream.json');
      if (fs.existsSync(cwdUpstreamPath)) {
        upstreamJsonPath = cwdUpstreamPath;
      } else {
        // Fallback to snapshot path (__dirname points inside bundle after esbuild bundling)
        const snapshotUpstreamPath = path.join(__dirname, '../config/upstream.json');
        if (fs.existsSync(snapshotUpstreamPath)) {
          upstreamJsonPath = snapshotUpstreamPath;
        }
      }
    }

    return { envPath, configJsonPath, configJsonExamplePath, examplePath, upstreamJsonPath };
  }

  // Development environment
  return {
    envPath: path.join(__dirname, '../../.env'),
    configJsonPath: path.join(__dirname, '../../config.json'),
    configJsonExamplePath: path.join(__dirname, '../../config.json.example'),
    examplePath: path.join(__dirname, '../../.env.example'),
    upstreamJsonPath: path.join(__dirname, '../config/upstream.json')
  };
}

/**
 * Get proto file path
 * @param {string} protoFileName - Proto file name (e.g., 'telemetry.proto')
 * @returns {string} Proto file path
 */
export function getProtoPath(protoFileName) {
  if (isPkg) {
    // pkg environment: prefer src/utils/proto next to the executable
    const exeDir = path.dirname(process.execPath);
    const exeProtoPath = path.join(exeDir, 'src', 'utils', 'proto', protoFileName);
    if (fs.existsSync(exeProtoPath)) {
      return exeProtoPath;
    }
    // Next, check src/utils/proto in the current working directory
    const cwdProtoPath = path.join(process.cwd(), 'src', 'utils', 'proto', protoFileName);
    if (fs.existsSync(cwdProtoPath)) {
      return cwdProtoPath;
    }
    // Return the executable directory path (even if it does not exist)
    return exeProtoPath;
  }
  // Development environment
  return path.join(__dirname, 'proto', protoFileName);
}

/**
 * Compute a relative path for log display
 * @param {string} absolutePath - Absolute path
 * @returns {string} Relative path or original path
 */
export function getRelativePath(absolutePath) {
  if (isPkg) {
    const exeDir = path.dirname(process.execPath);
    if (absolutePath.startsWith(exeDir)) {
      return '.' + absolutePath.slice(exeDir.length).replace(/\\/g, '/');
    }
    const cwdDir = process.cwd();
    if (absolutePath.startsWith(cwdDir)) {
      return '.' + absolutePath.slice(cwdDir.length).replace(/\\/g, '/');
    }
  }
  return absolutePath;
}
