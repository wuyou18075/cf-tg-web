// themes/manifest.js — 主题唯一清单（构建脚本与文档共用）
// 前端 HTML 内联代码由 build-themes.mjs 注入 generated 片段

export const DEFAULT_THEME_ID = "prairie";

export const THEME_ALIAS = {
  matrix: "prairie",
  aurora: "glass",
  ice: "paper",
  ember: "noir",
  "草原绿": "prairie",
  "默认": "default",
};

export const THEMES = [
  { id: "prairie", name: "原谅色", desc: "柔雾浅绿，清新治愈", file: "tokens/prairie.css", overrides: "overrides/prairie.css" },
  { id: "default", name: "极夜蓝", desc: "深蓝控制台", file: "tokens/default.css" },
  { id: "cyber", name: "霓虹赛博", desc: "青粉霓虹电光", file: "tokens/cyber.css" },
  { id: "noir", name: "墨夜", desc: "极哑光深灰黑", file: "tokens/noir.css", overrides: "overrides/noir.css" },
  { id: "glass", name: "琉璃", desc: "深空毛玻璃", file: "tokens/glass.css", overrides: "overrides/glass.css" },
  { id: "paper", name: "雾蓝白", desc: "淡蓝纸感浅色", file: "tokens/paper.css", overrides: "overrides/paper.css" },
  { id: "crimson", name: "绛夜", desc: "深酒红暗珊瑚", file: "tokens/crimson.css", overrides: "overrides/crimson.css" },
];
