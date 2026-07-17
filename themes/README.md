# 主题系统

## 目录

```
themes/
  manifest.js       # 主题 id / 名称 / 描述（唯一清单）
  base.css          # 布局组件，只用 var(--*)
  tokens/<id>.css   # 各主题 CSS 变量
  overrides/<id>.css# 主题专属组件补丁
  swatches.css      # 设置页色板预览
```

## 引用关系

```
manifest.js  ──►  构建注入前端 THEMES / setTheme 下拉
tokens/*     ──►  html[data-theme=id] { --bg; --accent; ... }
overrides/*  ──►  按钮 / 毛玻璃等补丁
base.css     ──►  全局布局
swatches.css ──►  .theme-opt 预览

scripts/build-themes.mjs
        │
        ▼
generated/themes.bundle.css
        +
generated/themes.runtime.js   (THEMES / THEME_ALIAS / DEFAULT_THEME_ID)
        │
        ▼
注入 cf-worker-example.js 的占位符
```

## 新增主题

1. 复制 `tokens/default.css` → `tokens/foo.css`，改选择器与变量
2. 需要特殊按钮时加 `overrides/foo.css`
3. `manifest.js` 增加一项
4. `swatches.css` 增加 `.theme-opt[data-id="foo"]`
5. 运行 `npm run build:themes`

## 构建

```bash
npm run build:themes
npm run deploy   # 会先 build:themes
```
