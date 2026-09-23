/**
 * 快速录入结果 → 新建载荷（ADR-014 §6 的落点表 + ADR-017 §3 的上限）。
 *
 * 这个映射只有一处，因为它是**预览说的与存的是不是同一件事**的落点——
 * 预览里的每一个碎片最终都落在下面某个字段上，两处各写一份就会出现
 * 「预览显示解析成功、提交却 400」这类用户看不出原因的失败。
 */
import { uuidv7 } from '@shared/uuid'
import type { QuickAddResult } from '@shared/quickadd'
import type { CreateTaskInput } from '../../lib/api-client'

/**
 * 新建载荷。**`taskId` 由客户端生成**（ADR-017 §5）：不是为了幂等，
 * 而是为了让「本地新建」与「导出后再导入」走同一条代码路径（ADR-010 §3 要求导入保留原 id）。
 * 幂等是顺带的收益：双击提交不会产生两条一模一样的任务。
 *
 * ⚠️ **`importance === null` 时整条键都不出现**（ADR-014 §6）：
 * 「用户写了 `!中`」与「用户没写」在预览里必须可区分，而默认值 `'normal'`
 * 只有服务端那一处（ADR-017 §3）。客户端再写一次 `?? 'normal'` 就是第二个默认值。
 *
 * `steps` 也**不出现**：快速录入只产出标题与七个字段，步骤为空（ADR-014 §6 末段）。
 */
export function quickAddToCreateInput(result: QuickAddResult, taskId?: string): CreateTaskInput {
  return {
    taskId: taskId ?? uuidv7(),
    title: result.title,
    plannedDate: result.plannedDate,
    plannedWeek: result.plannedWeek,
    dueDate: result.dueDate,
    tags: [...result.tags],
    projectId: result.projectId,
    recurrence: result.recurrence,
    ...(result.importance === null ? {} : { importance: result.importance }),
  }
}
