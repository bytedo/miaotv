// 此文件由 scripts/convert-changelog.js 自动生成
// 请勿手动编辑

export interface ChangelogEntry {
  version: string;
  date: string;
  added: string[];
  changed: string[];
  fixed: string[];
}

export const changelog: ChangelogEntry[] = [
  {
    version: '6.6.6+1',
    date: '2026-09-29',
    added: [
      '首个公开源码快照，包含浏览器播放、账号管理、TVBox 和 Emby 接入等现有功能；镜像发布尚待维护者执行。',
      '补充 Docker Compose、本地开发、贡献流程和安全问题报告说明。',
      '增加上游来源与第三方字体的许可说明。',
    ],
    changed: [
      '按部署、账号、播放和客户端整理文档，统一使用公开仓库地址。',
      '默认安装步骤采用源码构建；镜像发布由维护者在公开仓库手动开启。',
      '客户端下载页改为浏览器与 PWA 使用说明，生态客户端链接保留在移动端文档中。',
    ],
    fixed: [
      '更正注册默认状态、存储后端限制和数据备份范围的说明。',
      '移除与公开版本无关的安装包链接，修正文档中的过期路径和功能描述。',
      '按用户隔离 Emby 列表、媒体库和搜索响应缓存，并将 TVBox 健康检查限制为管理员访问。',
    ],
  },
];

export default changelog;
