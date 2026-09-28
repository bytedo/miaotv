#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function loadLocalDevEnvironment(projectDirectory) {
  // USERNAME is also a Windows system variable. This explicit local launcher
  // takes the site owner from the project's development environment files.
  delete process.env.USERNAME;
  process.env.NODE_ENV = 'development';
  const nextRequire = createRequire(require.resolve('next/package.json'));
  const { loadEnvConfig } = nextRequire('@next/env');
  loadEnvConfig(projectDirectory, true, console, true);

  if (!process.env.USERNAME?.trim()) {
    throw new Error(
      '本机启动需要在 .env.local（或其他开发环境文件）中配置站长 USERNAME。',
    );
  }
  return { ...process.env };
}

function startLocalDev(args = process.argv.slice(2)) {
  if (
    args.some(
      (arg) =>
        arg === '--hostname' ||
        arg.startsWith('--hostname=') ||
        arg.startsWith('-H'),
    )
  ) {
    throw new Error('dev:local 固定监听 127.0.0.1，不接受 hostname 参数。');
  }

  const inheritedEnvironment = { ...process.env };
  const environment = loadLocalDevEnvironment(projectRoot);
  const childEnvironment = {
    ...inheritedEnvironment,
    USERNAME: environment.USERNAME,
    NODE_ENV: 'development',
  };
  // Next must load and watch the other environment-file values itself.
  delete childEnvironment.__NEXT_PROCESSED_ENV;
  require('./generate-manifest.js');

  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      ...args,
    ],
    {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  const cleanup = () => {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
  };
  child.once('error', (error) => {
    cleanup();
    console.error(`本机开发服务启动失败：${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
  return child;
}

if (require.main === module) {
  try {
    startLocalDev();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { loadLocalDevEnvironment, startLocalDev };
