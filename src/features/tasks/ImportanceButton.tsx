/** 与任务列表一致的重要标记；未操作时保留已有的普通/低重要性值。 */
export function ImportanceButton({ important, disabled, onChange }: {
  important: boolean
  disabled?: boolean
  onChange: (important: boolean) => void
}) {
  const label = important ? '取消重要标记' : '标为重要'
  return <button type="button" className={`ta-tasks__starButton${important ? ' ta-tasks__starButton--on' : ''}`}
    aria-label={label} aria-pressed={important} title={label} disabled={disabled}
    onClick={() => onChange(!important)}>{important ? '★' : '☆'}</button>
}
