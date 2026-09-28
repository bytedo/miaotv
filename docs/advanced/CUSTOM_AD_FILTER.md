# 自定义 M3U8 广告过滤

管理员可以在后台的“去广告规则”页面保存一段 JavaScript，在播放器读取 HLS 清单时修改其中的内容。规则按视频源编写；有些源的广告直接烧录在视频里，修改清单无法去除。

## 配置和更新

1. 打开 `/admin`，进入“去广告规则”。
2. 编写规则，或载入示例后按实际清单修改。
3. 每次修改代码都递增版本号，再点击“保存配置”。
4. 刷新播放页，确认播放器已开启去广告，并检查浏览器控制台和实际播放结果。

播放页会比较服务端提供的版本号和本地缓存，必要时请求 `/api/ad-filter?full=true` 更新代码。只改代码而保留原版本号，已有用户可能继续使用旧缓存。

清空自定义代码后会回到默认过滤规则。要完全停止播放器的过滤，应关闭播放器中的去广告选项。

## 函数约定

代码必须定义一个同步函数 `filterAdsFromM3U8`，接收视频源的 key 和清单字符串，并返回清单字符串：

```javascript
function filterAdsFromM3U8(type, m3u8Content) {
  if (type !== 'example-source') {
    return m3u8Content;
  }

  // 在这里处理已确认的源规则。
  return m3u8Content;
}
```

两个参数分别是：

| 参数          | 内容                           |
| ------------- | ------------------------------ |
| `type`        | 当前播放源的 key               |
| `m3u8Content` | 当前加载的主清单或媒体清单文本 |

没有匹配规则时返回原文。不要返回 Promise、`undefined` 或空字符串；当前调用方不会验证返回值的类型，也不会验证清单结构。

使用普通 JavaScript 即可。实现只通过正则去掉少量基础 TypeScript 类型注解，并没有完整的 TypeScript 编译器，不能依赖接口、泛型或类型断言等语法。代码也没有模块导入环境。

## 一个范围受限的例子

下面的例子演示如何删除已确认的 `/ads/` 路径分片。它只处理 `example-source` 的点播清单，且要求 `#EXTINF` 后紧跟片段 URL；遇到加密、初始化段或字节范围标签时保留原文。使用前需要替换源 key，并用实际清单确认路径规则。

```javascript
function filterAdsFromM3U8(type, m3u8Content) {
  if (
    type !== 'example-source' ||
    !m3u8Content.includes('#EXT-X-ENDLIST') ||
    /#EXT-X-(KEY|MAP|BYTERANGE):/.test(m3u8Content)
  ) {
    return m3u8Content;
  }

  const lines = m3u8Content.split('\n');
  const kept = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const nextLine = lines[index + 1]?.trim();

    if (
      line.startsWith('#EXTINF:') &&
      nextLine &&
      !nextLine.startsWith('#') &&
      /(^|\/)ads\//.test(nextLine)
    ) {
      index += 1;
      continue;
    }

    kept.push(lines[index]);
  }

  return kept.some((line) => line.trim().startsWith('#EXTINF:'))
    ? kept.join('\n')
    : m3u8Content;
}
```

这个例子没有识别所有广告的能力。片段时长、URL 关键字和 `#EXT-X-DISCONTINUITY` 都不能单独证明某段是广告。误删正常片段或不连续标记，可能造成跳帧、音画不同步甚至播放失败。

加密清单还涉及密钥、IV 和媒体序列号。不要把上面的删除逻辑直接套到加密清单、直播或多音轨清单上。标签含义可以查 [HLS 规范 RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216)。

## 执行范围和失败行为

自定义代码通过 `new Function()` 在播放页执行，具有页面脚本可用的权限。它可以访问浏览器全局对象、localStorage 和未设为 HttpOnly 的 Cookie，没有独立沙箱。保存前需要审查代码，不能把不熟悉的外部脚本直接粘贴进去。

代码会分发给能访问该接口的客户端，因此不能在其中放密钥或其他秘密。管理员保存规则，相当于为观看者页面提供一段可执行脚本。

语法错误或执行时抛出异常，会触发默认规则。错误返回值、死循环、过度过滤则不一定能被这层异常处理救回。默认规则本身也按 URL 关键字过滤，无法保证对所有源都正确。

过滤发生在播放页的 HLS.js 清单加载器中。原生播放路径以及下载器各自有自己的处理流程，不能假定它们都会使用这段规则。

## 排查与接口

代码没有更新时，检查保存结果、版本号和浏览器控制台。缓存键为 `customAdFilterCode`、`customAdFilterVersion`；服务端版本为 0 时，客户端会清理这份缓存。

视频在启用规则后出错，可以先让函数直接返回 `m3u8Content`，确认问题是否由规则引起，再比较修改前后的清单。提交问题时附上源 key、规则、复现步骤和脱敏清单，删去签名参数、密钥地址中的令牌等凭据。

| 请求                           | 返回内容                          |
| ------------------------------ | --------------------------------- |
| `GET /api/ad-filter`           | `{ "version": 1 }`                |
| `GET /api/ad-filter?full=true` | `{ "code": "...", "version": 1 }` |

实现见[后台编辑器](../../src/components/CustomAdFilterConfig.tsx)、[播放页](../../src/app/play/page.tsx)和[配置读取接口](../../src/app/api/ad-filter/route.ts)。
