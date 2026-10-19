#!/usr/bin/env node
'use strict';

// Builds an installable tarball with a throw-away pre-release version (e.g. 0.1.7-dev.20261019-133000),
// without touching package.json. Real version numbers are only bumped for releases.

const { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, renameSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const out = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const base = pkg.version.replace(/-.*$/, '');
const version = `${base}-dev.${stamp}`;

const work = mkdtempSync(join(tmpdir(), 'heatzy-dev-'));
try {
  for (const entry of [...(pkg.files || []), 'package.json']) {
    if (existsSync(join(root, entry))) cpSync(join(root, entry), join(work, entry), { recursive: true });
  }
  writeFileSync(join(work, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  execFileSync('npm', ['pack', '--pack-destination', work, '--silent'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = readdirSync(work).find((name) => name.endsWith('.tgz'));
  renameSync(join(work, tgz), join(out, tgz));
  console.log(join(out, tgz));
} finally {
  rmSync(work, { recursive: true, force: true });
}
