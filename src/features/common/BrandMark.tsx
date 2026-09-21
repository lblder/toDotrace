/**
 * 品牌标记：一枚方形印章里的对勾（「打卡」的仪式性符号，§7 签名元素）。
 * 取色走 currentColor，由使用处的令牌决定。
 */

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="26" height="26" rx="6" strokeWidth={2} />
      <rect
        x="6.5"
        y="6.5"
        width="19"
        height="19"
        rx="3.5"
        strokeWidth={0.75}
        opacity={0.55}
      />
      <path
        d="M10.5 16.4 14 20l8-9"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
