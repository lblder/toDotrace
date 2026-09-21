/**
 * 图标集：统一 24 视框、1.5 描边、圆头圆角接合（同一视觉语言）。
 * 全部以 `currentColor` 取色 —— 颜色由使用处的 CSS 令牌决定，
 * 图标文件里不出现任何色值（架构文档 §6）。
 */

import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Icon({ size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    />
  )
}

/** 显示密码 */
export function IconEye(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  )
}

/** 隐藏密码 */
export function IconEyeOff(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.5" />
      <path d="M6.3 8.1A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.4-.6" />
      <path d="M10 10.3a2.9 2.9 0 0 0 4 4" />
    </Icon>
  )
}

/** 切换到亮色 */
export function IconSun(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </Icon>
  )
}

/** 切换到暗色 */
export function IconMoon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
    </Icon>
  )
}

/** 警示（错误横幅） */
export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.8 2.8 20h18.4L12 3.8Z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.2h.01" />
    </Icon>
  )
}

/** 提示（信息横幅） */
export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.2" />
      <path d="M12 7.8h.01" />
    </Icon>
  )
}

/** 完成 / 成功 */
export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.8 12.6 4.6 4.6L19.2 7.4" />
    </Icon>
  )
}

/** 登出 */
export function IconLogout(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 4.5h3a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3" />
      <path d="M10.5 8.2 6.7 12l3.8 3.8" />
      <path d="M6.7 12h8.6" />
    </Icon>
  )
}

/** 重试 */
export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 4v4.5H16" />
    </Icon>
  )
}
