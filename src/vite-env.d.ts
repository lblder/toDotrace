/**
 * Vite 的客户端类型（含 `declare module '*.css'` 等静态资源声明）。
 *
 * 根 tsconfig.json 的 `types` 只列了 node 与 vitest/globals，vite/client 不在其中，
 * 因此 CSS 副作用导入会报 TS2882。用这个三斜线引用补上，
 * 无需改动根 tsconfig（该文件不在本 agent 的改动边界内）。
 */
/// <reference types="vite/client" />
