import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

const sourceFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.ts', 'scripts/**/*.ts'];
const documentedAssertions = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { missing: 'Explain the proven non-null precondition in a nearby comment, or check the value.' },
  },
  create(context) {
    return {
      TSNonNullExpression(node) {
        const comments = context.sourceCode.getAllComments();
        if (
          !comments.some(
            comment =>
              comment.loc.end.line >= node.loc.start.line - 2 &&
              comment.loc.start.line <= node.loc.end.line &&
              /\S.{15}/.test(comment.value),
          )
        ) {
          context.report({ node, messageId: 'missing' });
        }
      },
    };
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next*/**',
      '**/dist/**',
      '**/.local/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/mission-view-validator.js',
      'prototypes/**',
    ],
  },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: sourceFiles })),
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': next },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error', '@next/next/no-img-element': 'error' },
  },
  {
    files: sourceFiles,
    plugins: { local: { rules: { 'documented-assertion': documentedAssertions } } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'local/documented-assertion': 'error',
    },
  },
];
