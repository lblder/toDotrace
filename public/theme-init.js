/*
 * 首帧防闪烁：在样式表生效之前把主题属性落到 <html> 上。
 *
 * 为什么是独立文件而不是内联脚本：CSP 是 script-src 'self'，内联脚本会被拦下。
 * 为什么必须是 classic script 且放在 <head>：要赶在首次绘制之前同步执行完。
 *
 * 两条约定（改这里之前先读 src/lib/theme.ts）：
 *  1. 存储键在本文件里定义，并通过 <html data-theme-key> 告诉 src/lib/theme.ts。
 *     运行期以本文件为准——DOM 上有值，那个模块就用这个值，不会各说各话。
 *     改名时同步改它的 FALLBACK_STORAGE_KEY（脚本缺席时的兜底）；
 *     两者是否一致由测试直接读源码核对，不靠人盯。
 *  2. 本文件必须**总是**写 data-theme。tokens.css 在没有该属性时落到
 *     `:root:not([data-theme])` —— 那是一套固定的暗色，不看系统偏好；
 *     只有把属性写死，首帧才会与系统偏好一致。
 *
 * 取值逻辑与 src/lib/theme.ts 的 resolve() 保持一致：
 *   'dark' / 'light'  → 显式选择，直接用
 *   'system' / 无值 / 读不出 → 跟随系统；拿不到 matchMedia 时按暗色处理
 */
;(function () {
  var KEY = 'todoagent.theme'
  var root = document.documentElement

  // theme.ts 从这里把键读回去——键只有这一个来源
  root.dataset.themeKey = KEY

  var preference = null
  try {
    var raw = window.localStorage.getItem(KEY)
    if (raw === 'dark' || raw === 'light') preference = raw
  } catch (error) {
    // 存储不可用（隐私模式等）→ 跟随系统，不抛错
  }

  var systemDark = true
  if (typeof window.matchMedia === 'function') {
    systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  var resolved = preference !== null ? preference : systemDark ? 'dark' : 'light'
  root.dataset.theme = resolved
})()
