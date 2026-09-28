const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { load } = require('cheerio');
const { createComponentLoader } = require('./component-test-loader.cjs');

const renderer = Promise.all([
  import('react-markdown'),
  import('remark-gfm'),
  import('remark-breaks'),
]).then(([markdown, gfm, breaks]) => {
  const loadComponent = createComponentLoader({
    'react-markdown': { __esModule: true, ...markdown },
    'remark-gfm': { __esModule: true, ...gfm },
    'remark-breaks': { __esModule: true, ...breaks },
    '../../tokens.css': {},
    './MarkdownContent.module.css': {},
  });
  return loadComponent('components/MarkdownContent.tsx').default;
});

async function renderMarkdown(content) {
  const MarkdownContent = await renderer;
  return load(
    renderToStaticMarkup(React.createElement(MarkdownContent, null, content)),
  );
}

test('announcements render Markdown structure and preserve ordinary line breaks', async () => {
  const $ = await renderMarkdown(
    [
      '# 站点更新',
      '',
      '**加粗**与*强调*，还有~~旧内容~~。',
      '普通文本的第二行。',
      '',
      '> 使用提示',
      '',
      '- 第一项',
      '  - 子项',
      '- 第二项',
      '',
      '1. 第一步',
      '2. 第二步',
      '',
      '- [x] 已上线',
      '- [ ] 待上线',
      '',
      '| 功能 | 状态 |',
      '| --- | :---: |',
      '| 公告 | 可用 |',
      '',
      '行内 `const value = 1`。',
      '',
      '```html',
      '<script>alert("example")</script>',
      '```',
    ].join('\n'),
  );

  assert.equal($('h1').text(), '站点更新');
  assert.equal($('strong').text(), '加粗');
  assert.equal($('em').text(), '强调');
  assert.equal($('del').text(), '旧内容');
  assert.equal($('p').first().find('br').length, 1);
  assert.equal($('blockquote').text().trim(), '使用提示');
  assert.equal($('ul ul li').text(), '子项');
  assert.equal($('ol > li').length, 2);
  assert.equal($('input[type="checkbox"][disabled]').length, 2);
  assert.equal($('input[checked]').length, 1);
  assert.equal($('table th').length, 2);
  assert.equal($('table td').last().text(), '可用');
  assert.equal($('table').parent().attr('tabindex'), '0');
  assert.match($('table th').last().attr('style'), /text-align:center/);
  assert.match($('pre code').text(), /<script>alert\("example"\)<\/script>/);
  assert.equal($('pre').attr('tabindex'), '0');
  assert.equal($('script').length, 0);
});

test('announcement links keep navigation safe and external destinations isolated', async () => {
  const $ = await renderMarkdown(
    [
      '[帮助](https://example.com/help)',
      '[站内](/search?q=example)',
      '[邮件](mailto:help@example.com)',
      '[协议相对地址](//example.com/help)',
      '[不安全](javascript:alert%281%29)',
      '[编码协议](javascript&colon;alert%281%29)',
      '[数据地址](data:text/html,unsafe)',
    ].join('\n\n'),
  );

  const external = $('a[href="https://example.com/help"]');
  assert.equal(external.attr('target'), '_blank');
  assert.equal(external.attr('rel'), 'noopener noreferrer');
  assert.match(external.text(), /在新标签页打开/);
  assert.equal($('a[href^="//"]').attr('rel'), 'noopener noreferrer');
  assert.equal($('a[href^="/search"]').attr('target'), undefined);
  assert.equal($('a[href^="mailto:"]').attr('href'), 'mailto:help@example.com');
  assert.equal($('a').length, 4);
  assert.match($('body').text(), /不安全/);
});

test('announcement HTML and unsafe images remain inert while Markdown images render', async () => {
  const $ = await renderMarkdown(
    [
      '<script>alert(1)</script>',
      '',
      '<iframe src="https://example.com"></iframe>',
      '',
      '<img src="x" onerror="alert(1)">',
      '',
      '<a href="javascript:alert(1)">原始 HTML</a>',
      '',
      '![海报](https://example.com/poster.png "海报说明")',
      '',
      '![不可用图片](javascript:alert%281%29)',
      '',
      '![不可用数据](data:image/svg+xml,unsafe)',
    ].join('\n'),
  );

  assert.equal($('script, iframe, [onerror], [onclick]').length, 0);
  assert.equal($('a').length, 0);
  assert.equal($('img').length, 1);
  assert.equal($('img').attr('src'), 'https://example.com/poster.png');
  assert.equal($('img').attr('alt'), '海报');
  assert.equal($('img').attr('loading'), 'lazy');
  assert.equal($('img').attr('referrerpolicy'), 'no-referrer');
  assert.match($('body').text(), /不可用图片/);
  assert.match($('body').text(), /不可用数据/);
});
