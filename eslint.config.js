// Minimal, pragmatic lint floor (architecture review §5): @eslint/js
// recommended, correct globals per environment. Style rules are deliberately
// out of scope — this exists to catch real errors (undefined globals, unused
// vars, unsafe patterns), not to argue about formatting.
import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: [
            "last_deploy/",
            "node_modules/",
            "md/",
            ".claude/",
            "archive/",
            "docs/",
            // static/ is assets, except the service-worker template (real JS,
            // also loaded by test/sw.test.mjs via new Function — must parse).
            "static/**",
            "!static/sw.js",
            // Materialized locally from src/aliases.stub.js by the pretest
            // hook; gitignored and may hold personal data — don't lint it.
            "src/aliases.js",
        ],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
        },
    },
    {
        // Browser code (bundled by esbuild).
        files: ["src/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                // Build-time constant injected by esbuild --define (see
                // build.sh / catalog.js); a typeof guard covers plain Node.
                __WORKS_VERSION__: "readonly",
            },
        },
    },
    {
        // These four files are mid-refactor on a concurrent branch (tooltip
        // consolidation); suppress the rule here instead of editing them so
        // the merge stays clean. TODO: remove this block and fix the handful
        // of unused vars once that refactor lands.
        files: [
            "src/tabComponent.js",
            "src/calendarComponent.js",
            "src/musicianNetworkComponent.js",
            "src/dashboardComponent.js",
        ],
        rules: {
            "no-unused-vars": "off",
        },
    },
    {
        // Service-worker template.
        files: ["static/sw.js"],
        languageOptions: {
            sourceType: "script",
            globals: { ...globals.serviceworker },
        },
    },
    {
        // Node: build/dev scripts, tests, and this config file.
        files: ["scripts/**/*.mjs", "test/**/*.mjs", "eslint.config.js"],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
];
