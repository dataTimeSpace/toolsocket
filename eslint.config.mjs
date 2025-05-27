import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
    globalIgnores([
        'dist/*',
    ]),
    {
        files: ['**/*.{js,mjs,cjs}'],
        plugins: { js },
        extends: ['js/recommended'],

        rules: {
            'indent': ['warn', 4],
            'linebreak-style': ['error', 'unix'],
            'quotes': 'off',
            'semi': ['warn', 'always'],

            'comma-spacing': ['warn', {
                before: false,
                after: true,
            }],

            'key-spacing': 'warn',
            'keyword-spacing': 'warn',
            'no-trailing-spaces': 'warn',

            'brace-style': ['warn', '1tbs', {
                allowSingleLine: true,
            }],

            'space-before-blocks': 'warn',
            'space-infix-ops': 'warn',
            'no-prototype-builtins': 'off',

            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],

            'no-redeclare': 'warn',
            'no-inner-declarations': 'warn',
            'no-extra-semi': 'warn',
            'require-atomic-updates': 'off',
            'max-statements-per-line': 'warn',
        },
    },
    { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            globals: {...globals.browser, ...globals.node},
        },
    },
]);
