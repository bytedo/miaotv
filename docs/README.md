# MiaoTV 文档

第一次部署，先看[部署指南](deployment/DEPLOYMENT.md)。想改代码，从[贡献指南](../CONTRIBUTING.md)开始。仓库首页提供了最短的[启动步骤](../README.md#用-docker-跑起来)。

## 部署与账号

| 文档                                          | 内容                                             |
| --------------------------------------------- | ------------------------------------------------ |
| [部署指南](deployment/DEPLOYMENT.md)          | Docker、其他部署方式、更新和备份                 |
| [配置说明](deployment/CONFIGURATION.md)       | 环境变量、存储、媒体源、注册审核、邮件与 Webhook |
| [邀请码](INVITE_CODE_SYSTEM.md)               | 创建、使用和停用邀请码，注册开关的组合规则       |
| [OIDC 登录](authentication/OIDC_SETUP.md)     | 身份提供方配置、回调地址和当前兼容限制           |
| [可信网络](authentication/TRUSTED_NETWORK.md) | 免登录访问的条件及反向代理配置                   |
| [安全与隐私](security/SECURITY.md)            | 认证、数据处理与部署注意事项                     |

## 播放与下载

| 文档                                              | 内容                                    |
| ------------------------------------------------- | --------------------------------------- |
| [视频下载](features/DOWNLOAD_FEATURES.md)         | 下载任务、保存方式、恢复与浏览器限制    |
| [片头片尾跳过](advanced/SKIP_CONTROLLER_GUIDE.md) | 按剧集设置跳过规则、快捷键与存储        |
| [广告过滤](advanced/CUSTOM_AD_FILTER.md)          | 过滤规则、自定义代码及执行范围          |
| [代理配置](advanced/PROXY_CONFIG.md)              | 图片、接口和视频代理，私有源与 DNS 排查 |

## 客户端与媒体库

| 文档                                            | 内容                            |
| ----------------------------------------------- | ------------------------------- |
| [Emby](integration/EMBY_GUIDE.md)               | 启用 Emby、添加媒体库和播放设置 |
| [TVBox](integration/TVBOX.md)                   | 订阅地址、输出格式和播放器对接  |
| [TVBox 访问控制](integration/TVBOX_SECURITY.md) | 令牌、用户权限、IP 限制与日志   |
| [移动端](mobile/MOBILE.md)                      | 浏览器、PWA 和生态客户端        |

## 开发与版本

- [贡献指南](../CONTRIBUTING.md)：目录结构、开发命令、测试和提交方式。
- [虚拟列表](features/VIRTUAL_SCROLL_GUIDE.md)：列表组件、布局与滚动状态的实现说明。
- [更新记录](../CHANGELOG)：公开版本的功能和修复。
- [来源与许可](../NOTICE.md)：上游项目、第三方组件和字体署名。

文档有错可以直接提 PR。报告使用问题时，请附上版本、部署方式、复现步骤和脱敏后的日志，详见[问题反馈](../CONTRIBUTING.md#报告问题)。涉及账号绕过或密钥泄露的漏洞，请按[安全报告说明](../SECURITY.md)处理。
