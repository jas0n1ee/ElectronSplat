// Sign the packaged macOS app, and optionally notarize and staple it.
//
// Signing is delegated to @electron/osx-sign: Electron's bundle layout (frameworks, helpers, which
// entitlements each piece inherits) is exactly the part hand-rolled signing gets wrong. Notarization
// stays as the two visible xcrun calls rather than another dependency.
//
// Nothing here is a secret. The identity is read from the login keychain, and the notarization
// credentials live in a notarytool keychain profile; both are named per run and never stored here.
//
// Usage (from the repo root):
//   node scripts/sign-macos.mjs                        # sign with the Developer ID identity present
//   node scripts/sign-macos.mjs --profile <name>       # ... then notarize, staple and validate
//   node scripts/sign-macos.mjs --allow-development    # local mechanics test with an Apple Development
//                                                      # certificate: signs, but cannot be distributed
import { sign } from '@electron/osx-sign';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const app = resolve(value('--app') ?? 'desktop-dist/ElectronSplat-darwin-arm64/ElectronSplat.app');
const entitlements = resolve('scripts/entitlements.plist');
const profile = value('--profile');
const allowDevelopment = args.includes('--allow-development');

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const show = (cmd, cmdArgs) => {
  process.stdout.write(`\n$ ${cmd} ${cmdArgs.join(' ')}\n`);
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (out.trim()) console.log(out.trim());
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status ?? result.signal})`);
  return out;
};

// 1. Which identity to sign with. Developer ID is the only distributable one; everything else is a
// mechanics test, so say so rather than producing something that looks shippable.
const listed = run('security', ['find-identity', '-v', '-p', 'codesigning']);
const pick = prefix => listed.split('\n').map(l => /"([^"]+)"/.exec(l)?.[1] ?? null).find(n => n?.startsWith(prefix)) ?? null;
const developerId = pick('Developer ID Application:');
const development = pick('Apple Development:');
const identity = value('--identity') ?? developerId ?? (allowDevelopment ? development : null);
if (!identity) {
  console.error(development
    ? `\nNo Developer ID Application identity in the keychain (found: ${development}).\nCreate and install a Developer ID Application certificate with its private key first. For a local mechanics test only, pass --allow-development.`
    : '\nNo code signing identity in the keychain. Install a Developer ID Application certificate with its private key.');
  process.exit(1);
}
const distributable = identity.startsWith('Developer ID Application:');
console.log(`identity: ${identity}${distributable ? '' : '\nWARNING: not a Developer ID identity — the result cannot be distributed; notarization and spctl do not apply.'}`);

// 2. Sign inside-out, entitlements on every file: the app, its helpers and the bundled node all load
// or spawn native code, and a nested binary signed without them fails at launch, not at signing time.
await sign({
  app, identity, platform: 'darwin', hardenedRuntime: true, timestamp: true,
  entitlements, 'entitlements-inherit': entitlements,
  optionsForFile: () => ({ entitlements, hardenedRuntime: true })
});
console.log('\nsigned');

// 3. Verify what got produced, rather than trusting the signing step.
show('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const detail = show('codesign', ['-dv', '--verbose=4', app]);
for (const key of ['Identifier', 'TeamIdentifier', 'Signature']) console.log(`  ${key}: ${new RegExp(`^${key}=(.+)$`, 'm').exec(detail)?.[1] ?? '?'}`);

// 4. Notarize. Only meaningful for a distributable build; notarytool takes an archive, and ditto keeps
// the framework symlinks intact.
if (profile && distributable) {
  const staging = await mkdtemp(join(tmpdir(), 'notarize-'));
  try {
    const zip = join(staging, 'app.zip');
    show('ditto', ['-c', '-k', '--keepParent', app, zip]);
    show('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait']);
    show('xcrun', ['stapler', 'staple', app]);
    show('xcrun', ['stapler', 'validate', app]);
  } finally { await rm(staging, { recursive: true, force: true }); }
} else if (profile) console.log('\nnotarization skipped: needs a Developer ID identity');
else console.log('\nnotarization skipped: no --profile given');

// 5. Gatekeeper's own verdict — the one a user's Mac will apply.
if (distributable) show('spctl', ['-a', '-vv', app]);
else console.log('spctl skipped: it rejects anything that is not a notarized Developer ID build');

console.log(`\ndone: ${app}\nNext: run the acceptance suite against this exact bundle — PORTABLE_TEST_EXECUTABLE="${join(app, 'Contents/MacOS/ElectronSplat')}" node tests/desktop.mjs`);
