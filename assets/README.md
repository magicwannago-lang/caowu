# 藏品图片与音频

## 图片 `assets/img/`

在 `index.html` 里找到 `<figure class="relic">`，把注释解开并填入路径：

```html
<div class="relic-media">
  <img src="assets/img/你的文件名.jpg" alt="藏品说明">
</div>
```

建议尺寸：

| 位置 | 比例 | 建议像素 |
|---|---|---|
| 主打横长陈位（`.relic-wide`） | 21 : 9 | 1600 × 686 |
| 普通陈位 | 4 : 3 | 1200 × 900 |

图片会自动 `object-fit: cover` 裁切，并带极缓的悬停放大（1.025 倍）。
**色调建议**：偏浅、低饱和，与米白纸底相处。过艳的图片会破坏整页的纸感。

## 音频 `assets/audio/`

在 `index.html` 的播放器里给 `<audio>` 补 `src`：

```html
<audio src="assets/audio/你的文件名.mp3" preload="metadata"></audio>
```

同时把 `.player-sub` 里的「未放入音频」文案改掉。
播放按钮的字符会在 `听 / 停` 之间切换，进度条自动跟随。

尚未放入音频时，点击按钮不会报错，只会把图标改为「待」——安静地示意。
