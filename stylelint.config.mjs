/**
 * Launch Operator style lint (Quality Bar 8: design tokens, RTL and Arabic).
 * Component CSS uses tokens only: no literal colour, length, duration or global stacking layer, and
 * logical properties only. apps/web/src/styles/tokens.css is the single file allowed to hold literals.
 * Media queries may use px widths (custom properties cannot be used in media features).
 * Token-level rules (six type sizes, one accent, defined variables, theme parity) live in
 * scripts/quality/style-tokens.mjs, which stylelint cannot express.
 */
const physical = [
  /^(margin|padding|border|scroll-margin|scroll-padding)-(left|right|top|bottom)(-|$)/,
  /^border-(top|bottom)-(left|right)-radius$/,
  /^(left|right|top|bottom)$/,
  /^(width|height|min-width|max-width|min-height|max-height)$/,
];

export default {
  ignoreFiles: ['**/node_modules/**', '**/.next*/**', '**/dist/**', '**/.local/**', '**/coverage/**', 'prototypes/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix'],
    'unit-disallowed-list': [
      ['px', 'em', 'rem', 'ex', 'ch', 'pt', 'pc', 'cm', 'mm', 'q', 'in', 'ms', 's'],
      { ignoreMediaFeatureNames: { px: ['width', 'min-width', 'max-width'] } },
    ],
    'property-disallowed-list': physical,
    'declaration-property-value-disallowed-list': {
      'text-align': ['left', 'right'],
      float: ['left', 'right'],
      clear: ['left', 'right'],
      // Global layers come from --z-*; local stacking inside a component stays 0-9.
      'z-index': ['/^-?\\d{2,}$/'],
    },
    'declaration-property-value-allowed-list': {
      'font-size': ['/^var\\(--f[1-6]\\)$/', 'inherit'],
      'font-weight': ['/^var\\(--w-(regular|medium|strong)\\)$/', 'inherit'],
      'font-family': ['/^var\\(--(serif|sans|arabic|mono)\\)$/', 'inherit'],
      'line-height': ['/^var\\(--lh-[a-z]+\\)$/', 'inherit', '1', '0', 'normal'],
      'letter-spacing': ['/^var\\(--track-[a-z]+\\)$/', '0', 'normal'],
      '/^(transition|animation)-duration$/': ['/^var\\(--[a-z-]+\\)( !important)?$/'],
    },
  },
  overrides: [
    {
      files: ['**/styles/tokens.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null,
        'function-disallowed-list': null,
        'unit-disallowed-list': null,
        'declaration-property-value-allowed-list': null,
      },
    },
  ],
};
