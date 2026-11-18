// The lint gate. It is CommonJS on purpose: `orca plugin test` loads ES modules of this folder
// with Orca's resolver, which refuses packages imported by name, and the test of this config
// (scripts/eslint-config.test.ts) runs there.
const js = require('@eslint/js')
const html = require('@html-eslint/eslint-plugin')
const htmlParser = require('@html-eslint/parser')
const tseslint = require('typescript-eslint')

/** The one module that may import `node:fs`, and the one that may call `fetch`. */
const DISK_MODULE = 'src/disk.ts'
const CLIENT_MODULE = 'src/client.ts'

/** Development tooling Orca never loads: the gates' scripts, the tests and this file. */
const TOOLING = ['scripts/**', '**/*.test.ts', '**/*.test.tsx', '**/*.check.ts', 'eslint.config.cjs']

const CODE = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.js', '**/*.mjs', '**/*.cjs']

/** No file may import these: the worker starts no process and opens no socket of its own. */
const BANNED_MODULES = ['child_process', 'net', 'http', 'https', 'tls', 'dgram', 'worker_threads']

const bannedModulePaths = BANNED_MODULES.flatMap((name) =>
  [`node:${name}`, name].map((specifier) => ({
    name: specifier,
    message: 'Orchon starts no process and reaches the network only through its client module.'
  }))
)

const diskPaths = ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].map((specifier) => ({
  name: specifier,
  message: `Only the disk module (${DISK_MODULE}) reads or writes files.`
}))

const requirePaths = ['node:module', 'module'].map((specifier) => ({
  name: specifier,
  importNames: ['createRequire'],
  message: 'createRequire would load a module past the import bans.'
}))

const NON_LITERAL_IMPORT = {
  selector: 'ImportExpression[source.type!="Literal"]',
  message: 'import() takes a literal string, so every module a file loads can be read from its source.'
}

const bannedImportExpression = (names, message) => ({
  selector: `ImportExpression[source.value=/^(node:)?(${names.join('|')})(\\u002F|$)/]`,
  message
})

const BANNED_MODULE_IMPORT = bannedImportExpression(
  BANNED_MODULES,
  'Orchon starts no process and reaches the network only through its client module.'
)
const DISK_IMPORT = bannedImportExpression(
  ['fs'],
  `Only the disk module (${DISK_MODULE}) reads or writes files.`
)

const fetchProperties = ['globalThis', 'window', 'self'].map((object) => ({
  object,
  property: 'fetch',
  message: `Only the client module (${CLIENT_MODULE}) calls fetch.`
}))

const BUILTIN_MODULE_PROPERTY = {
  object: 'process',
  property: 'getBuiltinModule',
  message: 'process.getBuiltinModule would load a module past the import bans.'
}

module.exports = tseslint.config(
  // Every gate skips these: installed packages, Orca's generated files and the implement
  // flow's runtime state. The editors' JavaScript is compiler output; its TypeScript is linted.
  { ignores: ['node_modules/', '.lril/', '.orca/', 'editors/**/*.js'] },

  { linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' } },

  {
    files: CODE,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // no-implied-eval only sees a timer it knows to be a global.
    languageOptions: { globals: { setTimeout: 'readonly', setInterval: 'readonly' } },
    rules: {
      // Unused code is an error.
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'all' }],
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-useless-assignment': 'error',

      // The worker's limits on itself. The tooling below loosens only the disk rule.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': ['error', { paths: [...bannedModulePaths, ...diskPaths, ...requirePaths] }],
      'no-restricted-syntax': ['error', NON_LITERAL_IMPORT, BANNED_MODULE_IMPORT, DISK_IMPORT],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: `Only the client module (${CLIENT_MODULE}) calls fetch.` }
      ],
      'no-restricted-properties': ['error', ...fetchProperties, BUILTIN_MODULE_PROPERTY]
    }
  },

  {
    files: [DISK_MODULE],
    rules: {
      'no-restricted-imports': ['error', { paths: [...bannedModulePaths, ...requirePaths] }],
      'no-restricted-syntax': ['error', NON_LITERAL_IMPORT, BANNED_MODULE_IMPORT]
    }
  },

  {
    files: [CLIENT_MODULE],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': ['error', BUILTIN_MODULE_PROPERTY]
    }
  },

  {
    files: TOOLING,
    rules: {
      'no-restricted-imports': ['error', { paths: bannedModulePaths }],
      'no-restricted-syntax': ['error', NON_LITERAL_IMPORT, BANNED_MODULE_IMPORT],
      'no-restricted-properties': ['error', ...fetchProperties]
    }
  },

  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },

  // Accessibility and correctness of the editors' own HTML. The panel has no markup to lint:
  // Orca draws it from components whose labels the type-check already requires.
  {
    files: ['**/*.html'],
    plugins: { '@html-eslint': html },
    languageOptions: { parser: htmlParser },
    rules: {
      '@html-eslint/require-doctype': 'error',
      '@html-eslint/require-lang': 'error',
      '@html-eslint/require-title': 'error',
      '@html-eslint/require-closing-tags': ['error', { selfClosing: 'always' }],
      '@html-eslint/require-img-alt': 'error',
      '@html-eslint/require-button-type': 'error',
      '@html-eslint/require-input-label': 'error',
      '@html-eslint/require-frame-title': 'error',
      '@html-eslint/require-li-container': 'error',
      '@html-eslint/no-abstract-roles': 'error',
      '@html-eslint/no-invalid-role': 'error',
      '@html-eslint/no-accesskey-attrs': 'error',
      '@html-eslint/no-aria-hidden-body': 'error',
      '@html-eslint/no-aria-hidden-on-focusable': 'error',
      '@html-eslint/no-positive-tabindex': 'error',
      '@html-eslint/no-nested-interactive': 'error',
      '@html-eslint/no-heading-inside-button': 'error',
      '@html-eslint/no-empty-headings': 'error',
      '@html-eslint/no-skip-heading-levels': 'error',
      '@html-eslint/no-multiple-h1': 'error',
      '@html-eslint/no-non-scalable-viewport': 'error',
      '@html-eslint/no-duplicate-id': 'error',
      '@html-eslint/no-duplicate-attrs': 'error',
      '@html-eslint/no-duplicate-in-head': 'error',
      '@html-eslint/no-obsolete-tags': 'error',
      '@html-eslint/no-obsolete-attrs': 'error',
      '@html-eslint/no-inline-styles': 'error'
    }
  }
)
