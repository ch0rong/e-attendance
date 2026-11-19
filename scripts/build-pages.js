/**
 * Cloudflare Pages 정적 빌드 스크립트 (scripts/build-pages.js)
 * - 공개 웹에 필요한 프론트엔드 파일만 dist/로 복사 (apps-script/, scripts/, README 등 제외)
 * - Cloudflare Pages 환경변수 GAS_WEB_APP_URL(또는 로컬 config.js)로 dist/config.js 자동 생성
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const STATIC_FILES = [
  'index.html',
  'admin.html',
  'style.css',
  'app.js',
  'admin.js',
];

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function resolveGasUrl() {
  const fromEnv = String(process.env.GAS_WEB_APP_URL || '').trim();
  if (fromEnv) return fromEnv;

  const localConfigPath = path.join(ROOT, 'config.js');
  if (fs.existsSync(localConfigPath)) {
    const sandbox = { window: {} };
    const vm = require('vm');
    vm.runInNewContext(fs.readFileSync(localConfigPath, 'utf8'), sandbox);
    const fromLocal = String(
      (sandbox.window.APP_CONFIG && sandbox.window.APP_CONFIG.GAS_WEB_APP_URL) || ''
    ).trim();
    if (fromLocal) return fromLocal;
  }

  return '';
}

// 1. dist 초기화
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 2. 프론트엔드 파일 및 assets 복사
for (const file of STATIC_FILES) {
  fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
}
copyDirRecursive(path.join(ROOT, 'assets'), path.join(DIST, 'assets'));

// 3. dist/config.js 생성 (환경변수 또는 로컬 config.js 기반)
const gasUrl = resolveGasUrl();
const appConfig = {
  IS_TEST_MODE: !gasUrl,
  GAS_WEB_APP_URL: gasUrl,
};
fs.writeFileSync(
  path.join(DIST, 'config.js'),
  `window.APP_CONFIG = ${JSON.stringify(appConfig, null, 2)};\n`,
  'utf8'
);

console.log(
  `[build-pages] dist/ ready (IS_TEST_MODE=${appConfig.IS_TEST_MODE}, HAS_GAS_URL=${Boolean(gasUrl)})`
);
