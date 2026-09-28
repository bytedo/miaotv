import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import '../../tokens.css';
import styles from './MarkdownContent.module.css';

const components: Components = {
  a: ({ children, href, title }) => {
    if (!href) return <span>{children}</span>;

    const isExternal = /^(https?:)?\/\//i.test(href);
    return (
      <a
        href={href}
        title={title}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noopener noreferrer' : undefined}
      >
        {children}
        {isExternal && <span className='sr-only'>（在新标签页打开）</span>}
      </a>
    );
  },
  img: ({ src, alt, title }) =>
    src ? (
      // Announcement images have administrator-provided URLs and dimensions.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt || ''}
        title={title}
        loading='lazy'
        decoding='async'
        referrerPolicy='no-referrer'
      />
    ) : (
      <span>{alt}</span>
    ),
  table: ({ children }) => (
    <div
      className={styles.tableViewport}
      role='region'
      aria-label='表格，可横向滚动'
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => (
    <pre tabIndex={0} role='region' aria-label='代码块，可横向滚动'>
      {children}
    </pre>
  ),
  input: ({ checked }) => (
    <input
      type='checkbox'
      checked={Boolean(checked)}
      disabled
      aria-label={checked ? '已完成' : '未完成'}
    />
  ),
};

const remarkPlugins = [remarkGfm, remarkBreaks];

const MarkdownContent = memo(function MarkdownContent({
  children,
}: {
  children: string;
}) {
  return (
    <div className={styles.content}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownContent;
