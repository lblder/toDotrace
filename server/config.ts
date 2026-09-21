import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 运行配置的唯一来源。
 *
 * 架构文档 §1：代码中不得出现 localhost / 端口硬编码假设，一切来自配置。
 * 环境变量名与 vite.config.ts 的 dev 代理保持一致（TODOAGENT_API_HOST / TODOAGENT_API_PORT），
 * 否则「前端代理指向的端口」与「服务端实际监听的端口」会各说各话。
 */

/** 仓库根目录（server/config.ts → 上一级）。 */
export const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function envString(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`环境变量 ${name} 不是合法端口：${raw}`)
  }
  return parsed
}

export interface Config {
  /** 监听地址。默认仅回环（开发文档 §8）。 */
  host: string
  port: number
  /** SQLite 单文件路径。默认 data/app.db（开发文档 §8）。 */
  dbPath: string
  /** 生产态静态资源目录；dev 态不托管（只提供 API）。 */
  staticDir: string
  /** 是否为生产态（NODE_ENV=production）。 */
  isProduction: boolean
  /** 会话有效期：30 天滑动（ADR-008 §5）。 */
  sessionTtlMs: number
  /** 邀请码有效期：7 天。 */
  inviteTtlMs: number
  /** 登录失败锁定：连续 5 次 → 15 分钟（ADR-008 §5）。 */
  loginMaxFailures: number
  loginLockMs: number
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production'
  return {
    host: envString('TODOAGENT_API_HOST', '127.0.0.1'),
    // 默认 8788 而非更常见的 8787：开发机上 8787 被一个长期驻留进程占用，
    // 默认值必须开箱即用。端口一律可被环境变量覆盖（架构文档 §1：不得硬编码）。
    port: envPort('TODOAGENT_API_PORT', 8788),
    dbPath: envString('TODOAGENT_DB_PATH', path.join(projectRoot, 'data', 'app.db')),
    staticDir: envString('TODOAGENT_STATIC_DIR', path.join(projectRoot, 'dist')),
    isProduction,
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
    loginMaxFailures: 5,
    loginLockMs: 15 * 60 * 1000,
  }
}
