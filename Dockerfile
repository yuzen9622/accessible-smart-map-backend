# syntax=docker/dockerfile:1
# Reviewed native OTP extension; the final default target remains the Node API.
FROM opentripplanner/opentripplanner@sha256:a7eac7da397faa9ec9dee407d4204895d24df4981500662fa6793aae0e71fd8f AS otp-upstream

FROM node:22-bookworm-slim AS otp-prepare
COPY --from=otp-upstream /app /opt/otp-upstream
COPY src/otp /opt/otp-source
COPY <<'OTP_PACKAGER' /opt/otp-build.mjs
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fail = message => { throw new Error(message); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const canonical = value => JSON.stringify(sort(value)) + '\n';
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
function files(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`Symlink forbidden: ${full}`);
    return entry.isDirectory() ? files(full) : [full];
  });
}
function resolveInside(root, relative) {
  if (path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p === '') || /[\r\n]/.test(relative)) fail(`Invalid relative path: ${relative}`);
  return path.join(root, relative);
}
function verifyTree(root, expected, label) {
  const actual = Object.fromEntries(files(root).map(file => [path.relative(root, file).split(path.sep).join('/'), fileSha(file)]));
  if (canonical(actual) !== canonical(expected)) {
    const changed = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].filter(k => actual[k] !== expected[k]);
    fail(`${label} differs from reviewed bytes: ${changed.slice(0, 5).join(', ')}`);
  }
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
function quoteJavaArg(argument) {
  if (/[\r\n]/.test(argument)) fail('Newline in Java argument');
  return '"' + argument.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

// ZIP_STORED, fixed 2000-01-01 UTC, sorted names, no filesystem metadata.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let result = 0xffffffff;
  for (const b of bytes) result = crcTable[(result ^ b) & 255] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}
function jar(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const name of Object.keys(entries).sort()) {
    const bytes = entries[name], filename = Buffer.from(name), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(10273, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(10273, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(directory, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function manifestLine(key, value) {
  let text = `${key}: ${value}`, lines = [];
  while (text.length > 70) { lines.push(text.slice(0, 70)); text = ' ' + text.slice(70); }
  return [...lines, text].join('\r\n') + '\r\n';
}

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--source', '--otp-app', '--output', '--javac', '--reviewed-lock-sha256', '--phase'].includes(key) || value === undefined || key in options) fail(`Invalid argument: ${key}`);
  options[key] = value;
}
for (const key of ['--source', '--otp-app', '--output', '--reviewed-lock-sha256']) if (!options[key]) fail(`Required: ${key}`);
const phase = options['--phase'] ?? 'all';
if (!['prepare', 'finish', 'all'].includes(phase)) fail('Invalid phase');
const source = path.resolve(options['--source']), app = path.resolve(options['--otp-app']), output = path.resolve(options['--output']);
const lockFile = path.join(source, 'reviewed-lock.json'), lockSha = fileSha(lockFile);
if (lockSha !== options['--reviewed-lock-sha256']) fail('Reviewed lock does not match externally supplied trust anchor');
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
if (lock.schema_version !== 1) fail('Unsupported reviewed lock');
verifyTree(app, lock.app_files, 'Official OTP application');
for (const component of lock.components) {
  if (!['policy', 'observer', 'api'].includes(component.name)) fail('Unknown component');
  for (const [kind, expected] of [['src', component.sources], ['resources', component.resources]]) {
    for (const relative of Object.keys(expected)) resolveInside(source, relative);
    verifyTree(path.join(source, component.name, kind), expected, `${component.name}/${kind}`);
  }
  if (canonical([...component.source_order].sort()) !== canonical(Object.keys(component.sources).sort())) fail('Compiler source list mismatch');
}
if (phase !== 'finish') {
  fs.mkdirSync(output);
  for (const component of lock.components) {
    const classes = path.join(output, 'classes', component.name);
    fs.mkdirSync(classes, { recursive: true });
    const args = [...component.compiler_args];
    if (component.classpath.length) args.push('-cp', component.classpath.map(entry => {
      if (entry.startsWith('app/')) return resolveInside(app, entry.slice(4));
      if (entry === 'policy.jar' || entry === 'observer.jar') return path.join(output, 'classes', entry.slice(0, -4));
      fail(`Unrecognized dependency: ${entry}`);
    }).join(path.delimiter));
    args.push('-d', classes, ...component.source_order.map(relative => resolveInside(path.join(source, component.name, 'src'), relative)));
    fs.writeFileSync(path.join(output, `compile-${component.name}.args`), args.map(quoteJavaArg).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(output, 'prepared.json'), canonical({ schema_version: 1, reviewed_lock_sha256: lockSha }));
  if (phase === 'prepare') { process.stdout.write(canonical({ prepared: true, compiler_version: lock.compiler_version })); process.exit(0); }
  if (!options['--javac']) fail('--javac is required for all phase');
  if (run(options['--javac'], ['-version']) !== lock.compiler_version) fail('Compiler version differs from reviewed compiler');
  for (const component of lock.components) run(options['--javac'], ['@' + path.join(output, `compile-${component.name}.args`)]);
} else {
  const prepared = JSON.parse(fs.readFileSync(path.join(output, 'prepared.json'), 'utf8'));
  if (prepared.reviewed_lock_sha256 !== lockSha) fail('Prepared build belongs to another reviewed lock');
}

const artifacts = {};
for (const component of lock.components) {
  const classes = path.join(output, 'classes', component.name);
  verifyTree(classes, component.classes, `${component.name} compiled classes`);
  let mf = manifestLine('Manifest-Version', '1.0');
  if (component.name === 'observer') {
    mf += manifestLine('Premain-Class', 'org.opentripplanner.runtime.policyidentity.RuntimePolicyIdentity');
    mf += manifestLine('Can-Redefine-Classes', 'false') + manifestLine('Can-Retransform-Classes', 'false');
  }
  const entries = { 'META-INF/MANIFEST.MF': Buffer.from(mf + '\r\n') };
  for (const relative of Object.keys(component.classes)) entries[relative] = fs.readFileSync(resolveInside(classes, relative));
  for (const relative of Object.keys(component.resources)) entries[relative] = fs.readFileSync(resolveInside(path.join(source, component.name, 'resources'), relative));
  const bytes = jar(entries), filename = `${component.name}.jar`;
  fs.writeFileSync(path.join(output, filename), bytes);
  artifacts[component.name] = { path: filename, sha256: sha(bytes), class_count: Object.keys(component.classes).length, reviewed_class_bytes_equal: true };
}
const policy = lock.components.find(component => component.name === 'policy');
const policyClasses = Object.fromEntries(Object.entries(policy.classes).map(([relative, hash]) => [relative.slice(0, -6).replaceAll('/', '.'), hash]));
const classDigest = sha(Object.keys(policyClasses).sort().map(name => `${name}\0${policyClasses[name]}\n`).join(''));
const policyManifest = {
  schema_version: 1, policy_revision: 'v8-direct-walk-endpoint-constraints', api_revision: lock.api_revision,
  official_commit: lock.official_commit, official_image: lock.official_image,
  reviewed_lock_sha256: lockSha, compiler_version: lock.compiler_version, java_release: lock.release,
  artifacts, policy_classes: policyClasses, observed_class_digest_sha256: classDigest,
  class_count: Object.keys(policyClasses).length,
  trust_boundary: 'Reviewed image-owned pin and backend allowlist; only policy classes are observed. No malicious-operator or transitive-runtime attestation.'
};
const manifestBytes = Buffer.from(canonical(policyManifest)), manifestSha = sha(manifestBytes);
fs.writeFileSync(path.join(output, 'policy-manifest.json'), manifestBytes);
const pin = [
  'format=1', 'artifact.path=policy.jar', `artifact.sha256=${artifacts.policy.sha256}`,
  'manifest.path=policy-manifest.json', `manifest.sha256=${manifestSha}`,
  'observer.path=observer.jar', `observer.sha256=${artifacts.observer.sha256}`,
  ...Object.keys(policyClasses).sort().map(name => `class.${name}=${policyClasses[name]}`)
].join('\n') + '\n';
fs.writeFileSync(path.join(output, 'policy.pin'), pin);
fs.writeFileSync(path.join(output, 'policy.pin.sha256'), sha(pin) + '\n');
const reviewed = [{ artifactSha256: artifacts.policy.sha256, manifestSha256: manifestSha, observedClassDigestSha256: classDigest, classCount: Object.keys(policyClasses).length }];
if (!fs.readFileSync(path.join(source, 'reviewed-policies.json')).equals(Buffer.from(canonical(reviewed)))) fail('Bundled backend policies differ from the reviewed OTP package');
fs.writeFileSync(path.join(output, 'reviewed-policies.json'), canonical(reviewed));
fs.writeFileSync(path.join(output, 'package-manifest.json'), canonical({ schema_version: 1, reviewed_lock_sha256: lockSha, artifacts, policy_manifest_sha256: manifestSha, policy_pin_sha256: sha(pin), reviewed_policies_sha256: fileSha(path.join(output, 'reviewed-policies.json')) }));
process.stdout.write(canonical({ output, artifacts, reviewed_policy: reviewed[0], policy_pin_sha256: sha(pin) }));
OTP_PACKAGER
RUN node /opt/otp-build.mjs --source /opt/otp-source --otp-app /opt/otp-upstream \
    --output /opt/otp-build --phase prepare \
    --reviewed-lock-sha256 0edad51a675edcccc2cbcdb13e7b1c79bb3ae34abd90c02e8baa635956e7dc09

FROM eclipse-temurin:26.0.2_10-jdk-jammy@sha256:67a829749773eb1c5a656ee478cc25b1968f3c0a05d3ba342b4998fce6688f89 AS otp-compile
COPY --from=otp-prepare /opt /opt
RUN test "$(javac -version)" = "javac 26.0.2" \
    && javac -J-Xmx256m -J-XX:ActiveProcessorCount=1 @/opt/otp-build/compile-policy.args \
    && javac -J-Xmx256m -J-XX:ActiveProcessorCount=1 @/opt/otp-build/compile-observer.args \
    && javac -J-Xmx256m -J-XX:ActiveProcessorCount=1 @/opt/otp-build/compile-api.args

COPY tests/otp /opt/otp-tests
RUN otp_test_classpath='/opt/otp-build/classes/policy:/opt/otp-build/classes/api:/opt/otp-build/classes/observer:/opt/otp-upstream/classes:/opt/otp-upstream/resources:/opt/otp-upstream/libs/*' \
    && javac -J-Xmx256m --release 25 -cp "$otp_test_classpath" -d /opt/otp-test-classes /opt/otp-tests/*.java \
    && java -Xmx512m -cp "/opt/otp-test-classes:$otp_test_classpath" TransitEndpointFilterHarness \
    && java -Xmx512m -cp "/opt/otp-test-classes:$otp_test_classpath" PruneIslandsPreservationHarness

FROM otp-prepare AS otp-package
COPY --from=otp-compile /opt/otp-build /opt/otp-build
RUN node /opt/otp-build.mjs --source /opt/otp-source --otp-app /opt/otp-upstream \
    --output /opt/otp-build --phase finish \
    --reviewed-lock-sha256 0edad51a675edcccc2cbcdb13e7b1c79bb3ae34abd90c02e8baa635956e7dc09

FROM otp-upstream AS otp-runtime
WORKDIR /opt/otp-policy
COPY --from=otp-package /opt/otp-build/policy.jar /opt/otp-build/observer.jar /opt/otp-build/api.jar ./
COPY --from=otp-package /opt/otp-build/policy-manifest.json /opt/otp-build/policy.pin /opt/otp-build/policy.pin.sha256 /opt/otp-build/reviewed-policies.json /opt/otp-build/package-manifest.json ./
COPY src/otp /opt/otp-modifications
ENTRYPOINT ["/bin/sh", "-ec", "set -eu\notp_load=false\nfor otp_arg do\n  if [ \"$otp_arg\" = --load ]; then otp_load=true; fi\ndone\notp_directory=/var/opentripplanner\nif [ \"$otp_load\" = true ]; then\n  test -f /var/otp-data/active-release && test ! -L /var/otp-data/active-release || { echo 'Missing active OTP release: run pnpm otp:rebuild (import sidewalks first if needed)' >&2; exit 78; }\n  otp_release=$(cat /var/otp-data/active-release)\n  case \"$otp_release\" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid active OTP release' >&2; exit 78;; esac\n  otp_root=/var/otp-data/releases/$otp_release\n  test ! -L /var/otp-data/releases && test ! -L \"$otp_root\" && test ! -L \"$otp_root/inputs\" && test ! -L \"$otp_root/evidence\" || exit 78\n  otp_directory=$otp_root/inputs\n  otp_manifest=$otp_root/evidence/build-manifest.json\n  test -f \"$otp_manifest\" && test ! -L \"$otp_manifest\" || { echo 'Missing build-manifest.json in active release' >&2; exit 78; }\nfi\notp_classpath=\"observer.jar:api.jar:policy.jar:$(cat /app/jib-classpath-file)\"\nset -- -cp \"$otp_classpath\" org.opentripplanner.runtime.policyidentity.TrustedPolicyLauncher org.opentripplanner.standalone.OTPMain \"$otp_directory\" \"$@\"\nif [ \"$otp_load\" = true ]; then\n  otp_manifest_sha=$(sha256sum \"$otp_manifest\")\n  otp_manifest_sha=${otp_manifest_sha%% *}\n  set -- \"-Dotp.buildManifest.path=$otp_manifest\" \"-Dotp.buildManifest.sha256=$otp_manifest_sha\" \"$@\"\nfi\nexec java -XX:+DisableAttachMechanism -Dotp.policyIdentity.pin=policy.pin \"-Dotp.policyIdentity.pinSha256=$(cat policy.pin.sha256)\" -javaagent:observer.jar \"$@\"", "--"]
CMD ["--load"]

# Multi-stage build for the Node API.
# Runtime uses dist/ + production deps; optional terrain DTM is mounted read-only.
# Accessibility data lives in MongoDB, transit in the OTP sidecar.

# ── builder: full deps + compile TS → dist ──────────────────────────────────
FROM node:22-bookworm-slim AS builder
# pnpm is the package manager (package.json "scripts" call `pnpm run`); corepack
# activates the exact version pinned in package.json "packageManager".
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Set registry network resilience variables (retry on network failure e.g. ECONNRESET)
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
# --ignore-scripts skips the `postinstall: pnpm run build` hook here: src/ isn't
# copied yet, so an automatic build would fail. We build explicitly below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
RUN pnpm run build

# ── runtime: production deps + compiled output only ─────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Set registry network resilience variables (retry on network failure e.g. ECONNRESET)
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /app/dist ./dist
# Drop privileges — the node image ships a non-root `node` user.
USER node
# Documentation only; the real port comes from PORT in the injected env.
EXPOSE 8000
CMD ["node", "dist/server.js"]
