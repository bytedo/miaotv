# 虚拟滚动

豆瓣、Emby 和短剧列表可以只渲染视口附近的卡片，滚动时再加载后面的内容。列表较长时，这能减少页面中的 DOM 节点；实际流畅度仍取决于卡片布局、图片大小和设备性能。

## 使用开关

在列表的筛选区域找到“虚拟滑动”开关。三个页面默认开启，各自记住选择，清除浏览器站点数据后会恢复默认值。

| 页面 | 路径          | localStorage 键               |
| ---- | ------------- | ----------------------------- |
| 豆瓣 | `/douban`     | `useDoubanVirtualization`     |
| Emby | `/emby`       | `useEmbyVirtualization`       |
| 短剧 | `/shortdrama` | `useShortDramaVirtualization` |

如果遇到卡片错位，可以先关闭开关比较。虚拟列表只把附近的内容放进 DOM，浏览器的页面内查找和打印也会受此影响；需要这些功能时可以切到普通列表。

虚拟滚动不会减少上游接口需要返回的数据，也不能消除慢网络下的加载等待。

## 组件用法

[VirtualGrid.tsx](../../src/components/VirtualGrid.tsx) 基于 `@tanstack/react-virtual`，按行做虚拟化。它从 CSS Grid 读取列数，用实际测量修正行高，并使用 `document.body` 作为滚动容器。

页面负责保存开关、获取数据和防止重复请求。下面是已有客户端组件中的用法，其中 `items`、`hasMore`、`loading` 和 `loadMore` 来自该页面的数据状态，`YourCard` 替换为实际卡片组件：

```tsx
import VirtualGrid from '@/components/VirtualGrid';

<VirtualGrid
  items={items}
  className='grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4'
  rowGapClass='pb-4'
  estimateRowHeight={280}
  endReached={() => {
    if (hasMore && !loading) {
      loadMore();
    }
  }}
  endReachedThreshold={3}
  renderItem={(item) => <YourCard item={item} />}
/>;
```

| 属性                  | 默认值           | 用途                                                 |
| --------------------- | ---------------- | ---------------------------------------------------- |
| `estimateRowHeight`   | `320`            | 预估行高，单位为像素，包含行间距；随后按实际高度修正 |
| `rowGapClass`         | `pb-14 sm:pb-20` | 行底部的 padding，计入测量高度                       |
| `overscan`            | `3`              | 可见范围之外预渲染的行数                             |
| `endReachedThreshold` | `2`              | 加载更多的基础阈值，计算时还会加上预计可见行数       |
| `restoreKey`          | 未设置           | 在 `sessionStorage` 保存滚动位置和测量结果           |

当前豆瓣页面的预估行高为 320 像素，Emby 和短剧为 280 像素。更换卡片布局后，需要重新检查这些值。

使用 `restoreKey` 时，把来源、搜索词和筛选条件纳入键名，避免不同列表共用位置。快照有效期为 30 分钟，数据行数变化过大时会忽略旧快照；恢复发生在组件挂载时。

## 图片与排查

豆瓣和短剧列表会优先加载前 30 张图片，其他图片按卡片组件的加载策略处理。[imageCache.ts](../../src/lib/imageCache.ts) 中的 `loadedImageUrls` 记录已加载的图片 URL，供卡片再次挂载时使用。它是页面运行期间的内存记录，无法在浏览器控制台直接作为全局变量读取。

- 卡片上下跳动：检查预估行高、行间距和图片占位尺寸，再比较开关前后的布局。
- 滚到底部仍在等待：查看列表接口的响应时间，确认 `hasMore` 和加载状态能阻止重复请求。增加阈值只能提早请求。
- 快速滚动时卡顿：在同一设备、同一列表上录制浏览器 Performance，比较渲染耗时和 DOM 数量，再调整 `overscan`。
