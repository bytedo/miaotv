# 报告安全问题

如果问题涉及账号接管、权限绕过、密钥泄露或服务端任意请求，请先私下报告，暂时不要把复现细节发到公开 Issue。

打开仓库的 [Security 页面](https://github.com/bytedo/miaotv/security)。如果页面提供 **Report a vulnerability**，请使用该私密入口；如果没有该入口，可以先在 [Issue](https://github.com/bytedo/miaotv/issues) 中请求私密联系方式，只说明问题类型，等维护者提供接收方式后再发送细节。

报告中请提供：

- 受影响的版本、提交号或镜像摘要。
- 部署方式，以及与问题有关的存储和认证配置，隐去真实凭据。
- 最小复现步骤、预期行为和实际结果。
- 你已确认的影响范围，以及可用的临时规避方法。

测试请使用自己的实例和测试账号。日志、截图或请求示例中不要包含密码、令牌、会话 Cookie、真实邮箱或第三方用户数据。

普通功能问题请使用 [Issues](https://github.com/bytedo/miaotv/issues)。部署中的账号、代理和数据保护说明见 [部署安全与隐私](docs/security/SECURITY.md)。
