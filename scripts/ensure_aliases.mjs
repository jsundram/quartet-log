#!/usr/bin/env node
// Ensure src/aliases.js exists so every entry point (dev build, prod build,
// npm test, audit script) can import it. If the personal copy is absent
// (fresh clone, CI without the PLAYER_ALIASES_JS secret), copy the
// checked-in stub into place. Idempotent; no dependencies. See
// src/aliases.stub.js for the full mechanism description.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = join(root, 'src', 'aliases.js');
const stub = join(root, 'src', 'aliases.stub.js');

if (!existsSync(real)) {
    const header =
        '// GENERATED from src/aliases.stub.js by scripts/ensure_aliases.mjs\n' +
        '// because no personal src/aliases.js was present. This file is\n' +
        '// gitignored — replace it with your real alias tables (same shape).\n\n';
    writeFileSync(real, header + readFileSync(stub, 'utf8'));
    console.log('ensure_aliases: created src/aliases.js from stub (empty alias tables).');
}
