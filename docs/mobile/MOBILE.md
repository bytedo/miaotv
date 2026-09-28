# 手机与电视访问

手机可以直接用浏览器访问 MiaoTV。网页支持 PWA，可在浏览器提供的安装入口添加到桌面；不同系统的入口和播放能力会有差异。

## 浏览器与 PWA

在设备浏览器中打开站点的 HTTPS 地址。iPhone 和 iPad 通常通过 Safari 的分享菜单选择“添加到主屏幕”；Android 可使用浏览器菜单中的安装或添加到主屏幕选项。没有出现安装入口时，可以继续在浏览器里使用。

添加到桌面不会把视频资源保存在设备上。离线保存的范围和限制见[视频下载](../features/DOWNLOAD_FEATURES.md)。需要跨设备同步播放记录和收藏时，站点应使用服务端存储，并在各设备登录同一个账号；浏览器本地存储的数据不会自动同步。

本站 `/download` 页面提供浏览器和 PWA 的使用说明。本仓库发布的是 Web 应用，不发布独立的 Android、iOS、Windows 或电视客户端安装包。

## Selene 与 Selene-TV

[Selene](https://github.com/MoonTechLab/Selene) 和 [Selene-TV](https://github.com/MoonTechLab/Selene-TV) 是 MoonTV 生态中的客户端项目，由各自的维护者发布。接入 MiaoTV 前，请查看它们当前支持的服务端接口、登录方式和系统要求。

| 项目      | 使用场景               | 安装来源                                                      |
| --------- | ---------------------- | ------------------------------------------------------------- |
| Selene    | 手机                   | [Releases](https://github.com/MoonTechLab/Selene/releases)    |
| Selene-TV | Android TV、遥控器设备 | [Releases](https://github.com/MoonTechLab/Selene-TV/releases) |

接入时填写完整服务器地址，例如 `https://tv.example.com`，再使用本站账号登录。不要把网页播放地址或 `/api/tvbox` 订阅地址当成服务器根地址。网页端的功能不一定都能在客户端使用。

只有客户端正确使用本站的账号和数据接口，播放记录、收藏才可能与网页端同步。电视端也可以使用 [TVBox 配置接口](../integration/TVBOX.md)；TVBox 订阅用于导入视频源配置。

## 连接排查

先在客户端所在设备的浏览器中打开站点，确认域名、HTTPS 证书和网络可达。电脑上的 `localhost` 对手机指的是手机自己，不能用它访问电脑部署的服务。默认 Compose 只监听本机，其他设备需通过配置好的反向代理或调整后的端口访问。

客户端能连接但无法登录时，核对账号状态和客户端支持的认证方式。OIDC、验证码等网页登录步骤可能没有对应的客户端流程。先用普通测试账号确认连接，再按客户端文档排查认证兼容性。
