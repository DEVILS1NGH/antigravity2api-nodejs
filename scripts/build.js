import esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const bundleDir = path.join(distDir, 'bundle');

// Convert to forward-slash paths (cross-platform compatibility)
const toSlash = (p) => p.replace(/\\/g, '/');

function copyDirectoryContents(sourceDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

// Ensure directories exist
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(bundleDir)) {
  fs.mkdirSync(bundleDir, { recursive: true });
}

// Parse command-line arguments
const args = process.argv.slice(2);
const targetArg = args.find(arg => arg.startsWith('--target='));
const target = targetArg ? targetArg.split('=')[1] : 'node18-win-x64';

// Resolve target platform
const targetMap = {
  'win': 'node18-win-x64',
  'win-x64': 'node18-win-x64',
  'linux': 'node18-linux-x64',
  'linux-x64': 'node18-linux-x64',
  'linux-arm64': 'node18-linux-arm64',
  'macos': 'node18-macos-x64',
  'macos-x64': 'node18-macos-x64',
  'macos-arm64': 'node18-macos-arm64',
  'all': 'node18-win-x64,node18-linux-x64,node18-linux-arm64,node18-macos-x64,node18-macos-arm64'
};

const resolvedTarget = targetMap[target] || target;

// Output filename mapping
const outputNameMap = {
  'node18-win-x64': 'antigravity-win-x64.exe',
  'node18-linux-x64': 'antigravity-linux-x64',
  'node18-linux-arm64': 'antigravity-linux-arm64',
  'node18-macos-x64': 'antigravity-macos-x64',
  'node18-macos-arm64': 'antigravity-macos-arm64'
};

// Platform-specific bin file mapping
const binFileMap = {
  'node18-win-x64': 'fingerprint_windows_amd64.exe',
  'node18-linux-x64': 'fingerprint_linux_amd64',
  'node18-linux-arm64': 'fingerprint_android_arm64',
  'node18-macos-x64': 'fingerprint_linux_amd64',
  'node18-macos-arm64': 'fingerprint_android_arm64'
};

console.log('📦 Step 1: Bundling with esbuild...');

// Bundle to CommonJS with esbuild
await esbuild.build({
  entryPoints: ['src/server/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(bundleDir, 'server.cjs'),
  external: [],
  minify: false,
  sourcemap: false,
  // Handle __dirname and __filename
  define: {
    'import.meta.url': 'importMetaUrl'
  },
  banner: {
    js: `
const importMetaUrl = require('url').pathToFileURL(__filename).href;
const __importMetaDirname = __dirname;
`
  },
  // Copy static assets
  loader: {
    '.node': 'copy'
  }
});

console.log('✅ Bundle created: dist/bundle/server.cjs');

// Create temporary package.json for pkg
// Reference asset files with absolute paths
  const pkgJson = {
  name: 'antigravity-to-openai',
  version: '1.0.0',
  bin: 'server.cjs',
  pkg: {
    assets: [
      toSlash(path.join(rootDir, 'public', '**/*')),
      toSlash(path.join(rootDir, 'public', '*.html')),
      toSlash(path.join(rootDir, 'public', '*.css')),
      toSlash(path.join(rootDir, 'public', 'js', '*.js')),
      toSlash(path.join(rootDir, 'public', 'assets', '*')),
      toSlash(path.join(rootDir, 'src', 'bin', '*')),
      toSlash(path.join(rootDir, 'src', 'utils', 'proto', '*.proto')),
      toSlash(path.join(rootDir, 'src', 'config', '*.json'))
    ]
  }
};

fs.writeFileSync(
  path.join(bundleDir, 'package.json'),
  JSON.stringify(pkgJson, null, 2)
);

console.log('📦 Step 2: Building executable with pkg...');

// Helper to run pkg command
function runPkg(args) {
  // Convert paths in arguments to forward slashes
  const quotedArgs = args.map(arg => {
    if (arg.includes(' ') || arg.includes('\\')) {
      return `"${arg.replace(/\\/g, '/')}"`;
    }
    return arg;
  });

  const cmd = `npx pkg ${quotedArgs.join(' ')}`;
  console.log(`Running: ${cmd}`);

  try {
    execSync(cmd, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: true
    });
  } catch (error) {
    throw new Error(`pkg failed: ${error.message}`);
  }
}

// Build pkg command
const targets = resolvedTarget.split(',');
const isMultiTarget = targets.length > 1;

try {
  const pkgJsonPath = path.join(bundleDir, 'package.json');

  // Remove old executables (avoid EPERM errors)
  if (isMultiTarget) {
    for (const t of targets) {
      const oldFile = path.join(distDir, outputNameMap[t] || 'antigravity');
      if (fs.existsSync(oldFile)) {
        console.log(`🗑️ Removing old file: ${oldFile}`);
        fs.unlinkSync(oldFile);
      }
    }
  } else {
    const outputName = outputNameMap[resolvedTarget] || 'antigravity';
    const oldFile = path.join(distDir, outputName);
    if (fs.existsSync(oldFile)) {
      console.log(`🗑️ Removing old file: ${oldFile}`);
      fs.unlinkSync(oldFile);
    }
  }

  if (isMultiTarget) {
    // Multi-target build
    runPkg([pkgJsonPath, '--target', resolvedTarget, '--compress', 'GZip', '--out-path', distDir]);
  } else {
    // Single-target build
    const outputName = outputNameMap[resolvedTarget] || 'antigravity';
    const outputPath = path.join(distDir, outputName);

    // Disable compression when cross-compiling ARM64 on Windows (avoids spawn UNKNOWN error)
    const isArm64 = resolvedTarget.includes('arm64');
    const isWindows = process.platform === 'win32';
    const compressArgs = (isArm64 && isWindows) ? [] : ['--compress', 'GZip'];

    runPkg([pkgJsonPath, '--target', resolvedTarget, ...compressArgs, '--output', outputPath]);
  }

  console.log('✅ Build complete!');

  // Copy runtime files to dist directory
  console.log('📁 Copying runtime files...');

  // Copy public directory (excluding images)
  const publicSrcDir = path.join(rootDir, 'public');
  const publicDestDir = path.join(distDir, 'public');
  console.log(`  Source: ${publicSrcDir}`);
  console.log(`  Dest: ${publicDestDir}`);
  console.log(`  Source exists: ${fs.existsSync(publicSrcDir)}`);

  if (fs.existsSync(publicSrcDir)) {
    try {
      if (fs.existsSync(publicDestDir)) {
        console.log('  Removing existing public directory...');
        fs.rmSync(publicDestDir, { recursive: true, force: true });
      }
      console.log('  Copying public directory...');
      copyDirectoryContents(publicSrcDir, publicDestDir);
      // Remove images directory (generated at runtime, not needed in build)
      const imagesDir = path.join(publicDestDir, 'images');
      if (fs.existsSync(imagesDir)) {
        fs.rmSync(imagesDir, { recursive: true, force: true });
      }
      console.log('  ✓ Copied public directory');
    } catch (err) {
      console.error('  ❌ Failed to copy public directory:', err.message);
      throw err;
    }
  } else {
    console.error('  ❌ Source public directory not found!');
  }

  // Copy bin directory (only files for the target platform)
  const binSrcDir = path.join(rootDir, 'src', 'bin');
  const binDestDir = path.join(distDir, 'bin');
  if (fs.existsSync(binSrcDir)) {
    if (fs.existsSync(binDestDir)) {
      fs.rmSync(binDestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(binDestDir, { recursive: true });

    // Only copy bin files for the target platform
    const targetBinFiles = isMultiTarget
      ? [...new Set(targets.map(t => binFileMap[t]).filter(Boolean))]  // Multi-target: deduplicated list of all files
      : [binFileMap[resolvedTarget]].filter(Boolean);  // Single-target: copy only one file

    if (targetBinFiles.length > 0) {
      for (const binFile of targetBinFiles) {
        const srcPath = path.join(binSrcDir, binFile);
        const destPath = path.join(binDestDir, binFile);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`  ✓ Copied bin/${binFile}`);
        } else {
          console.warn(`  ⚠ Warning: bin/${binFile} not found`);
        }
      }
    // Copy tls_config.json
    const configFile = 'tls_config.json';
    const configSrcPath = path.join(binSrcDir, configFile);
    const configDestPath = path.join(binDestDir, configFile);
    if (fs.existsSync(configSrcPath)) {
      fs.copyFileSync(configSrcPath, configDestPath);
      console.log(`  ✓ Copied bin/${configFile}`);
} else {
  console.warn(`  ⚠ Warning: bin/${configFile} not found`);
}
    } else {
      // If no mapping exists, copy all files (legacy fallback)
      try {
        copyDirectoryContents(binSrcDir, binDestDir);
        console.log('  ✓ Copied all bin files');
      } catch (err) {
        console.error('  ⚠ Warning: Failed to copy bin directory:', err.message);
      }
    }
  }

  // Copy config template (only config.json)
  const configSrcPath = path.join(rootDir, 'config.json');
  const configDestPath = path.join(distDir, 'config.json');
  if (fs.existsSync(configSrcPath)) {
    fs.copyFileSync(configSrcPath, configDestPath);
    console.log('  ✓ Copied config.json');
  }

  // Copy proto files
  const protoSrcDir = path.join(rootDir, 'src', 'utils', 'proto');
  const protoDestDir = path.join(distDir, 'src', 'utils', 'proto');
  if (fs.existsSync(protoSrcDir)) {
    fs.mkdirSync(protoDestDir, { recursive: true });
    const protoFiles = fs.readdirSync(protoSrcDir).filter(f => f.endsWith('.proto'));
    for (const protoFile of protoFiles) {
      fs.copyFileSync(
        path.join(protoSrcDir, protoFile),
        path.join(protoDestDir, protoFile)
      );
      console.log(`  ✓ Copied src/utils/proto/${protoFile}`);
    }
  }

  // Copy upstream.json (upstream protocol configuration)
  const upstreamSrcPath = path.join(rootDir, 'src', 'config', 'upstream.json');
  const upstreamDestDir = path.join(distDir, 'src', 'config');
  const upstreamDestPath = path.join(upstreamDestDir, 'upstream.json');
  if (fs.existsSync(upstreamSrcPath)) {
    fs.mkdirSync(upstreamDestDir, { recursive: true });
    fs.copyFileSync(upstreamSrcPath, upstreamDestPath);
    console.log('  ✓ Copied src/config/upstream.json');
  } else {
    console.warn('  ⚠ Warning: src/config/upstream.json not found');
  }

  console.log('');
  console.log('🎉 Build successful!');
  console.log('');
  console.log('📋 Usage:');
  console.log('  1. Copy the dist folder to your target machine');
  console.log('  2. Run the executable (will auto-generate random credentials if not configured)');
  console.log('  3. Optionally create .env file to customize settings');
  console.log('');

} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
} finally {
  // Clean up temporary files
  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    console.log('🧹 Cleaned up temporary files');
  }
}
