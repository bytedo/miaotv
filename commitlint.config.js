module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 禁用 body 行长度限制（适配 AI 生成的 commit message）
    'body-max-line-length': [0],
    //   TODO Add Scope Enum Here
    // 'scope-enum': [2, 'always', ['yourscope', 'yourscope']],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'chore',
        'style',
        'refactor',
        'ci',
        'test',
        'perf',
        'revert',
        'vercel',
      ],
    ],
  },
};
