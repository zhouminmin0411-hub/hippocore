const typeLabels: Record<string, string> = {
  Task: '任务',
  Decision: '决策',
  Insight: '洞察',
  Area: '领域',
  Event: '事件',
  Entity: '实体',
  Project: '项目',
};

const stateLabels: Record<string, string> = {
  all: '全部',
  candidate: '候选',
  verified: '已确认',
  archived: '已归档',
};

export function presentTypeLabel(value: string) {
  return typeLabels[value] || value;
}

export function presentStateLabel(value: string) {
  return stateLabels[value] || value;
}

export function presentCopy(value: string | null | undefined) {
  if (!value) return '';
  return value
    .replace('This task represents near-term execution intent and should be tracked to completion.', '这是一项明确的近期执行事项，适合继续跟踪直到完成。')
    .replace('This task represents near-term execution intent and should be tracked to completion', '这是一项明确的近期执行事项，适合继续跟踪直到完成')
    .replace('The next concrete action is:', '下一步可以直接执行：')
    .replace('This action is synthesized from the broader source context.', '这一步是从完整上下文中整理出的可执行动作。')
    .replace('This decision can serve as the current default direction unless contradicted by new evidence.', '这项决策可以作为当前默认方向，除非后续出现新的反证。')
    .replace('This insight can be reused in future evaluations to reduce repeated trial and error.', '这条洞察可以复用于后续判断，减少重复试错。')
    .replace('This theme is the complete expression of the current topic.', '这就是当前主题在这段来源里的完整表达。');
}
