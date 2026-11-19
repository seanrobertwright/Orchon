// The lint gate. It is CommonJS on purpose: `orca plugin test` loads ES modules of this folder
// with Orca's resolver, which refuses packages imported by name, and the test of this config
// (scripts/eslint-config.test.ts) runs there.
const js = require('@eslint/js')
const html = require('@html-eslint/eslint-plugin')
const htmlParser = require('@html-eslint/parser')
const tseslint = require('typescript-eslint')
const extensions = require('./scripts/source-extensions.json')

/** This file: the one place `require()` is allowed. */
const CONFIG_FILE = 'eslint.config.cjs'
/** The one module that may load `node:fs` among the files Orca loads, and the one that may use `fetch`. */
const DISK_MODULE = 'src/disk.ts'
const CLIENT_MODULE = 'src/client.ts'
/** The one date helper: the only file Orca loads that may use `Date` and `Intl.DateTimeFormat`. */
const DATE_MODULE = 'src/dates.ts'
/** The one file that may load `node:module`, to hand the gates their development dependencies. */
const LOADER_MODULE = 'scripts/tooling.ts'
/**
 * The fixture recorder's two gateways. The recorder is a developer-run script that boots an
 * Archon release and records its answers: one file starts that release, the release's own setup
 * commands and `git` for a scratch repository, and one file calls the release over HTTP. Orca
 * never loads either.
 */
const RECORDER_PROCESS_MODULE = 'scripts/recorder/process.ts'
const RECORDER_HTTP_MODULE = 'scripts/recorder/http.ts'

/** Development tooling Orca never loads: the gates' scripts, the tests and this file. */
const TOOLING = ['scripts/**', '**/*.test.*', '**/*.check.*', CONFIG_FILE]

/** Every file of code. The list of extensions is shared with the other gates. */
const CODE = [...extensions.typescript, ...extensions.javascript].map((extension) => `**/*.${extension}`)

/**
 * No file may load these: the worker starts no process and opens no socket of its own. The one
 * exception is the recorder's process module, which may load the first.
 */
const PROCESS_MODULE = 'child_process'
const BANNED_MODULES = [PROCESS_MODULE, 'net', 'http', 'https', 'tls', 'dgram', 'worker_threads']
const DISK_MODULES = ['fs']
const LOADER_MODULES = ['module']

const BANNED_MESSAGE = 'Orchon starts no process and reaches the network only through its client module.'
const DISK_MESSAGE = `Only the disk module (${DISK_MODULE}) reads or writes files.`
const LOADER_MESSAGE = `node:module would load a module past the import bans. Only ${LOADER_MODULE} may use it.`

/** `import` and `export ... from` of a module, by either spelling and with its subpaths. */
const importPaths = (names, message) =>
  names.flatMap((name) =>
    [`node:${name}`, name, `node:${name}/promises`, `${name}/promises`].map((specifier) => ({
      name: specifier,
      message
    }))
  )

/** `import()`, `require()` and `import x = require()` of a module. */
const loadSelectors = (names, message) => {
  const specifier = `/^(node:)?(${names.join('|')})(\\u002F|$)/`
  return [
    `ImportExpression[source.value=${specifier}]`,
    `CallExpression[callee.name="require"][arguments.0.value=${specifier}]`,
    `TSExternalModuleReference[expression.value=${specifier}]`
  ].map((selector) => ({ selector, message }))
}

const NON_LITERAL_LOADS = [
  'ImportExpression[source.type!="Literal"]',
  'CallExpression[callee.name="require"][arguments.0.type!="Literal"]'
].map((selector) => ({
  selector,
  message: 'A module is loaded by a literal string, so every module a file loads can be read from its source.'
}))

/**
 * The module bans for one group of files. The network modules are banned in every group;
 * `disk`, `loader` and `startsProcess` say whether the group may load `node:fs`, `node:module`
 * and `node:child_process`.
 */
const moduleBans = ({ disk, loader, startsProcess = false }) => {
  const banned = [
    [BANNED_MODULES.filter((name) => !(startsProcess && name === PROCESS_MODULE)), BANNED_MESSAGE],
    ...(disk ? [] : [[DISK_MODULES, DISK_MESSAGE]]),
    ...(loader ? [] : [[LOADER_MODULES, LOADER_MESSAGE]])
  ]
  return {
    'no-restricted-imports': [
      'error',
      { paths: banned.flatMap(([names, message]) => importPaths(names, message)) }
    ],
    'no-restricted-syntax': [
      'error',
      ...NON_LITERAL_LOADS,
      ...banned.flatMap(([names, message]) => loadSelectors(names, message))
    ]
  }
}

const FETCH_MESSAGE = `Only the client module (${CLIENT_MODULE}) uses fetch.`
const DATE_MESSAGE = `Only the date helper (${DATE_MODULE}) reads the clock, parses a date or formats one.`

const GLOBAL_OBJECTS = ['globalThis', 'window', 'self']
const fetchProperties = GLOBAL_OBJECTS.map((object) => ({ object, property: 'fetch', message: FETCH_MESSAGE }))
const dateProperties = [
  ...GLOBAL_OBJECTS.map((object) => ({ object, property: 'Date', message: DATE_MESSAGE })),
  { property: 'DateTimeFormat', message: DATE_MESSAGE }
]

const BUILTIN_MODULE_PROPERTY = {
  object: 'process',
  property: 'getBuiltinModule',
  message: 'process.getBuiltinModule would load a module past the import bans.'
}

/**
 * The globals one group of files may not use. `fetch` and `dates` say whether the group is let
 * past the fetch ban and the date ban.
 */
const globalBans = ({ fetch, dates }) => ({
  'no-restricted-globals': [
    'error',
    ...(fetch ? [] : [{ name: 'fetch', message: FETCH_MESSAGE }]),
    ...(dates ? [] : [{ name: 'Date', message: DATE_MESSAGE }])
  ],
  'no-restricted-properties': [
    'error',
    ...(fetch ? [] : fetchProperties),
    ...(dates ? [] : dateProperties),
    BUILTIN_MODULE_PROPERTY
  ]
})

module.exports = tseslint.config(
  // Every gate skips these: installed packages, Orca's generated files and the implement
  // flow's runtime state. The editors' JavaScript is compiler output: its TypeScript is linted,
  // and scripts/check-editor-output.ts fails on a JavaScript file there with no TypeScript source.
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

      // The worker's limits on itself. The blocks below name every file that is let past one.
      '@typescript-eslint/no-require-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      ...moduleBans({ disk: false, loader: false }),
      ...globalBans({ fetch: false, dates: false })
    }
  },

  // The disk module may load node:fs.
  { files: [DISK_MODULE], rules: moduleBans({ disk: true, loader: false }) },

  // The client module may use fetch.
  { files: [CLIENT_MODULE], rules: globalBans({ fetch: true, dates: false }) },

  // The date helper may use Date and Intl.DateTimeFormat.
  { files: [DATE_MODULE], rules: globalBans({ fetch: false, dates: true }) },

  // The tooling may load node:fs: the gates and the tests read the repository's files. It may
  // also use dates: a test builds the instants it expects, and a script stamps what it records.
  {
    files: TOOLING,
    rules: { ...moduleBans({ disk: true, loader: false }), ...globalBans({ fetch: false, dates: true }) }
  },

  // The loader may also load node:module.
  { files: [LOADER_MODULE], rules: moduleBans({ disk: true, loader: true }) },

  // The recorder's process module may also load node:child_process, to start the release it records.
  { files: [RECORDER_PROCESS_MODULE], rules: moduleBans({ disk: true, loader: false, startsProcess: true }) },

  // The recorder's HTTP module may use fetch, to call that release.
  {
    files: [RECORDER_HTTP_MODULE],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': ['error', BUILTIN_MODULE_PROPERTY]
    }
  },

  // A CommonJS file is parsed as one. The module bans still read its require() calls.
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } }
  },

  // This file may call require(), which is how a CommonJS config loads its plugins.
  { files: [CONFIG_FILE], rules: { '@typescript-eslint/no-require-imports': 'off' } },

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
